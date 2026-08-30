// The node without a GPU still answers: it asks an external API.
// Phase 8.5 of the ROADMAP -- the external assistant as ONE MORE CANDIDATE.
//
// -----------------------------------------------------------------------------
// WHY IT'S A CANDIDATE AND NOT A SEPARATE BRANCH
//
// Phase 8 made routing choose by load instead of taking the first one. With
// that, an upstream doesn't need any special path: it registers in the store
// as one more row -- kind 'upstream' -- and everything that already exists
// starts working with it for free. findAllByModelId considers it, /v1/models
// and /v1/nodes list it, the routing log records it with its reason, and the
// provenance headers declare it to the client.
//
// If instead it were an `if (noHayNadie) llamarAOpenAI()` stuck inside
// handleChat, all of that would have to be written again and would stay
// outside the trail.
//
// -----------------------------------------------------------------------------
// WHAT OBDIENT-SEED ALREADY LEARNED
//
// obdient-seed's proxy (src/proxy/senior.mjs) has spent months talking to
// this same API. Two things it learned the hard way and that come free here:
//
//   1. ONLY delta.content gets read. Reasoning models also send
//      `reasoning_content`, which exposes the model's thinking and, with it,
//      the provider behind it. It's discarded by construction, not by a
//      filter someone can forget.
//   2. The provider's error detail goes to THIS process's log, never to the
//      client: it can carry the account name or the function's internal id.
//
// And two things obdient-seed is missing that are needed here:
//
//   3. Backoff with jitter ONLY for 429/5xx/connection errors. A 400 or a 401
//      will fail all three times anyway (D20: without idempotency, backoff
//      isn't fault tolerance, it's a bill multiplier).
//   4. `usage` is read from the provider. obdient-seed discards it and its
//      own app is waiting for it; here it's what feeds budget settlement.
// -----------------------------------------------------------------------------

import env from 'bare-env'
// Bare has no global AbortController -- it's neither the browser nor Node.
// The package is the same one bare-fetch already uses internally for its
// `signal`, so this doesn't add a new dependency to the tree: it just makes
// it explicit.
import AbortController from 'bare-abort-controller'

const REINTENTOS = 3
const ESPERA_BASE_MS = 400

// Up to the provider's first byte. Not the same number as the P2P path's
// (120s): a peer might be loading 807 MB of weights for the first time, an
// internet API isn't.
//
// 180s, and the number changed (B16). The previous version was 60s, taken
// from what was measured on 2026-08-25 against integrate.api.nvidia.com:
// llama-3.3-70b took 43.4 seconds to first byte and got dropped as unusable,
// so 60 seemed to let through even what was already known to be too slow.
//
// The next day the SAME endpoint took 58 seconds, and OpenRouter on its free
// tier took 10 to first byte and 50 total. So the cap had two seconds of
// margin against what had been measured, and requests were about to start
// cutting themselves off -- not because of a hung provider, which is what
// this clock exists to catch, but because of a slow one answering just fine.
//
// The lesson isn't the number, it's where it comes from: a free tier is a
// QUEUE, and how long you wait in it isn't up to you. A cap calibrated flush
// against a single measurement isn't a cap, it's the next failure. These
// 180s give room for that; what does NOT change is that a provider that
// never answers still has to get cut off, and 180 is still enough for that.
//
// Can be overridden per model from the config (`timeoutPrimerChunkMs`),
// which is what to do for a model whose real latency is known.
const PRIMER_CHUNK_TIMEOUT_MS = 180000

// Tokens were already coming in and they got cut off without closing the
// stream. A hung TCP socket doesn't announce itself: without this the
// request stays open forever, and with it, the budget reservation that
// authorized it.
const IDLE_TIMEOUT_MS = 30000

// Output cap when neither the config nor the client say otherwise. 1024 is
// ~4 paragraphs: enough for a chat response, and it bounds the worst case of
// the reservation to a number you can look at without flinching.
const MAX_TOKENS_DEFAULT = 1024

function enteroPositivo(v, porDefecto) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto
}

function esReintentable(status) {
  return status === 429 || (status >= 500 && status < 600)
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// HTTP header names are NOT case-sensitive; a JavaScript object IS. That
// mismatch was a hole (B11): a lowercase `authorization` written in the
// config didn't collide with the `Authorization` the code writes, so BOTH
// survived and bare-fetch sent them concatenated --
//
//     authorization = Bearer <someone-else's-provider-key>, Bearer <ours>
//
// -- i.e. one provider's credential traveling to another one's endpoint. The
// same thing happened with `content-type`, and the JSON body went out
// announced as text/plain.
//
// Everything gets normalized to lowercase on the way IN, and then the
// object itself resolves the collision: whatever the code writes overwrites
// whatever the file says, because they're the same key. There's no list of
// reserved names to remember to keep up to date afterward.
function enMinuscula(crudos) {
  const out = {}
  for (const [nombre, valor] of Object.entries(crudos || {})) {
    out[String(nombre).toLowerCase()] = valor
  }
  return out
}

export class Upstream {
  constructor({
    id,
    label,
    baseUrl,
    apiKeyEnv,
    model,
    anunciadoComo = null,
    displayName,
    tags = [],
    maxConcurrent = 4,
    maxTokens = MAX_TOKENS_DEFAULT,
    precio = null,
    esLocal = false,
    timeoutPrimerChunkMs = PRIMER_CHUNK_TIMEOUT_MS,
    timeoutIdleMs = IDLE_TIMEOUT_MS,
    extraBody = null,
    extraHeaders = null
  }) {
    this.id = id
    this.label = label || id
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.apiKeyEnv = apiKeyEnv
    this.model = model
    // WHAT THE PROVIDER CALLS IT vs WHAT THIS NETWORK ADVERTISES IT AS. Two
    // different things, and until now they were one.
    //
    // The same model has a different name at each door: NVIDIA calls it
    // `nvidia/nemotron-3.5-lightning-30b-a3b` and OpenRouter calls it
    // `nvidia/nemotron-3.5-lightning`. With a single field, two providers of
    // the SAME model enter the registry as two different models and never
    // compete -- findAllByModelId filters by exact name, so load-based
    // routing, tie-breaking, and budget degradation never come into play.
    //
    // `anunciadoComo` is the name the row enters the marketplace under;
    // `model` is the string that travels in the body to the provider.
    // Without declaring it, they're the same and everything behaves as
    // before.
    this.anunciadoComo = anunciadoComo || model
    this.displayName = displayName || model
    this.tags = tags
    this.maxConcurrent = maxConcurrent
    // ITS OWN OUTPUT CAP, with a non-zero default on purpose.
    //
    // The budget reservation is `promptTokens*input + maxTokens*output`: with
    // maxTokens at zero the upper bound comes out to ZERO, and the cap stops
    // cutting off exactly on the one path that costs real money. An OpenAI
    // client that doesn't send `max_tokens` — which is almost all of
    // them — can't disable the cutoff by accident, so the node sets the
    // limit.
    this.maxTokens =
      Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : MAX_TOKENS_DEFAULT
    // { entrada, salida } in micro-dollars per 1M tokens, or null if the
    // operator didn't declare it. With no price there's no possible
    // reservation: whoever registers it decides whether that leaves the
    // upstream out (bin.mjs does leave it out).
    this.precio = precio
    // An endpoint running on THIS machine: llama-server, vLLM, or a
    // self-hosted NIM, speaking OpenAI on localhost. It's an upstream by how
    // it's called -- HTTP, not the embedded engine -- and it's NOT a third
    // party the prompt travels to: it never leaves the machine, nobody sees
    // it, it costs no money.
    //
    // That difference isn't cosmetic: it decides whether the opt-in, the
    // `local: true` filter, and D19's "no local capacity" condition apply to
    // it. All three say NO.
    this.esLocal = esLocal === true
    // Both clocks come from the config so a slow model can be accommodated
    // without touching code -- and so tests can exercise them without
    // waiting a minute. An invalid value falls back to the default: never to
    // zero, which would be a timeout that fires before it even starts.
    this.timeoutPrimerChunkMs = enteroPositivo(timeoutPrimerChunkMs, PRIMER_CHUNK_TIMEOUT_MS)
    this.timeoutIdleMs = enteroPositivo(timeoutIdleMs, IDLE_TIMEOUT_MS)
    // Some models ask for fields outside the OpenAI standard (for example
    // chat_template_kwargs.enable_thinking). They live in the config, not in
    // the code: they belong to the model, not to us.
    this.extraBody = extraBody
    // Extra provider headers. OpenRouter, for example, uses HTTP-Referer and
    // X-Title to attribute traffic to an app. They live in the config and
    // not in the code for the same reason as extraBody: they belong to the
    // provider, not to us.
    //
    // Stored ALREADY normalized to lowercase, which is what makes the
    // guarantee below true: `authorization` and `content-type` cannot be
    // overridden from the file NO MATTER HOW THEY'RE CAPITALIZED. See
    // #headers.
    this.extraHeaders = extraHeaders ? enMinuscula(extraHeaders) : null
  }

  // The credential is read from an ENVIRONMENT VARIABLE whose NAME is in the
  // config. The repo keeps the name; the secret never touches disk, and
  // above all never enters the signed manifest announced to the network.
  get apiKey() {
    return env[this.apiKeyEnv] || null
  }

  disponible() {
    // A local endpoint carries no credential: requiring one would leave it
    // permanently disabled. What makes it usable is being up, and that's
    // only known once something is actually requested from it.
    return this.esLocal || !!this.apiKey
  }

  // Generates text deltas. SAME shape as engine.complete(), on purpose: the
  // provider and the gateway consume both with the same `for await`, so
  // cancellation, timeouts, and token counting keep working with no changes.
  // `signal` is sent by the gateway when the client leaves. The timeouts are
  // set here: they belong to the protocol with the provider, not the client,
  // and the gateway has no reason to know how long an API it didn't choose
  // takes.
  async *completar({ messages, maxTokens = 0, signal = null, onUsage = null, onFinish = null }) {
    // A single controller for the three ways to cut it off — the client left,
    // the provider never started, the provider hung mid-stream —: whichever
    // fires first aborts the fetch, and `motivo` says which one. Without this
    // the error the operator sees is a bare AbortError, which doesn't
    // distinguish "you closed the tab" from "the API died."
    const ctl = new AbortController()
    let motivo = null
    let temporizador = null

    const cortar = (porque) => {
      if (motivo) return
      motivo = porque
      ctl.abort()
    }

    const armar = (ms, porque) => {
      clearTimeout(temporizador)
      temporizador = setTimeout(() => cortar(porque), ms)
      temporizador.unref?.()
    }

    if (signal) {
      if (signal.aborted) cortar('el cliente cerro la conexion')
      else
        signal.addEventListener('abort', () => cortar('el cliente cerro la conexion'), {
          once: true
        })
    }

    try {
      yield* this.#completar({
        messages,
        maxTokens,
        onUsage,
        onFinish,
        ctl,
        armar,
        motivoDe: () => motivo
      })
    } finally {
      clearTimeout(temporizador)
      // If the consumer cuts the `for await` — a `break`, or an exception
      // further up — the generator closes here and the fetch has to die with
      // it. Without this abort the provider keeps generating and billing for
      // a stream nobody is reading anymore.
      cortar('el consumidor dejo de leer')
    }
  }

  // The config's FIRST and ours after: `authorization` cannot be overridden
  // from a file -- that would mean sending one provider's credential to
  // another -- and neither can `content-type`, because the body is JSON no
  // matter what someone else writes.
  //
  // Everything lowercase, on both sides. That detail is B11's entire fix: the
  // constructor already lowercased whatever came from the file, so these
  // three lines collide with whatever name someone wrote and overwrite it.
  // Written as `Content-Type`/`Authorization` they overwrote nothing -- they
  // coexisted with the lowercase version and both traveled.
  #headers(key) {
    const h = { ...(this.extraHeaders || {}) }
    h['content-type'] = 'application/json'
    if (key) h.authorization = 'Bearer ' + key
    else delete h.authorization
    return h
  }

  async *#completar({ messages, maxTokens, onUsage, onFinish, ctl, armar, motivoDe }) {
    // The lesser of what the client asked for and what this node allows. A
    // client can ask for LESS than the cap; it can't ask for more.
    const tope = maxTokens > 0 ? Math.min(maxTokens, this.maxTokens) : this.maxTokens
    const key = this.apiKey
    if (!key && !this.esLocal) {
      throw new Error('upstream: missing credential, set the ' + this.apiKeyEnv + ' environment variable')
    }

    const mod = await import('bare-fetch')
    const fetch = mod.default || mod.fetch || mod

    // Order matters, and it used to be reversed: `extraBody` went LAST, so a
    // `max_tokens` written in the config would override the node's cap -- the
    // one number the reservation was calculated with -- and a
    // `stream: false` would break the SSE parser without saying why. What
    // the node needs to bound spend and understand the response goes AFTER:
    // the config extends, it doesn't override.
    const extra = { ...(this.extraBody || {}) }

    // `usage` in streaming is OPTIONAL in the OpenAI protocol: without
    // requesting it, the vast majority of providers don't send it. And
    // without `usage`, settlement is left without the real token
    // counts -- especially the input ones, which there's no way to count on
    // this side. It's requested by the CODE, not the config: it used to be a
    // field in a file that could be forgotten, and forgetting it came cheap
    // on the bill and expensive on the cap.
    const streamOptions = { ...(extra.stream_options || {}), include_usage: true }
    delete extra.stream_options

    const body = {
      ...extra,
      model: this.model,
      messages,
      stream: true,
      stream_options: streamOptions,
      max_tokens: tope
    }

    let res = null
    armar(
      this.timeoutPrimerChunkMs,
      `provider did not respond within ${this.timeoutPrimerChunkMs / 1000}s`
    )

    for (let intento = 0; intento < REINTENTOS; intento++) {
      if (intento > 0) {
        const espera = ESPERA_BASE_MS * Math.pow(2, intento - 1) * (0.5 + Math.random())
        await esperar(espera)
      }
      try {
        res = await fetch(this.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: this.#headers(key),
          body: JSON.stringify(body),
          signal: ctl.signal
        })
      } catch (err) {
        res = null
        // A cutoff on our end is NOT a network failure: retrying would mean
        // asking the provider again for something we already decided we
        // don't want -- and paying for it.
        const porque = motivoDe()
        if (porque) throw new Error('upstream: request to provider cut off: ' + porque)
        if (intento === REINTENTOS - 1) {
          throw new Error('upstream: could not reach provider: ' + ((err && err.message) || err))
        }
        continue
      }

      if (res.ok) break

      const detalle = await res.text().catch(() => '')
      console.error('[upstream:' + this.id + '] HTTP ' + res.status + ': ' + detalle.slice(0, 300))

      if (!esReintentable(res.status)) {
        // The message that goes out to the client does NOT carry the
        // provider's detail.
        throw new Error('external provider rejected the request (HTTP ' + res.status + ')')
      }
      if (intento === REINTENTOS - 1) {
        throw new Error('external provider is unavailable (HTTP ' + res.status + ')')
      }
      res = null
    }

    // Hand-rolled SSE: same format the panel's chat already parses.
    let buffer = ''
    let usage = null
    let finishReason = null

    for await (const chunk of res.body) {
      const porque = motivoDe()
      if (porque) throw new Error('upstream: provider stream cut off: ' + porque)

      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')

      let corte
      while ((corte = buffer.indexOf('\n\n')) !== -1) {
        const bloque = buffer.slice(0, corte)
        buffer = buffer.slice(corte + 2)

        for (const linea of bloque.split('\n')) {
          if (!linea.startsWith('data:')) continue
          const dato = linea.slice(5).trim()
          if (dato === '' || dato === '[DONE]') continue

          let ev
          try {
            ev = JSON.parse(dato)
          } catch {
            continue
          }

          // B15 -- a 200 does NOT mean it went well.
          //
          // The status arrives with the headers, i.e. before the model
          // generates a single token. Everything that breaks
          // afterward -- the provider behind it going down, a quota running
          // out mid-stream, a content filter -- can't travel as a status
          // because it's already been sent: it travels as an `error` object
          // inside the body. OpenRouter does this, and it wasn't being
          // checked here.
          //
          // Without this, the error used to get discarded like any unknown
          // event: the generator finished normally, the gateway read it as
          // `ok: true`, it cut the candidate walk short WITHOUT trying the
          // next one, and the client received a successful, empty response.
          // The most expensive kind of failure there is: the one that looks
          // exactly like working.
          //
          // It throws, which is what makes the gateway treat it as a fallen
          // candidate and move on to the next one. The provider's detail
          // goes to THIS process's log and not to the client, same as in the
          // status branch: it can carry the account name or the internal id.
          if (ev.error) {
            const detalle =
              (ev.error && (ev.error.message || ev.error.code)) || JSON.stringify(ev.error)
            console.error(
              '[upstream:' + this.id + '] error IN STREAM: ' + String(detalle).slice(0, 300)
            )
            // The code is kept in the message because the gateway reads a
            // 429 from it to treat it as saturation instead of a broken
            // request.
            const codigo = ev.error && ev.error.code
            throw new Error(
              'external provider cut off the response' + (codigo ? ' (' + codigo + ')' : '')
            )
          }

          // Usage travels in the last chunk when the provider sends it.
          if (ev.usage) usage = ev.usage

          // B14 -- HOW IT FINISHED, which until now was discarded the same
          // way the error was discarded. The provider states it in the last
          // chunk, and it's the only one that knows for sure: we count SSE
          // deltas, not tokens, so comparing against the cap would give an
          // approximate number, not the fact.
          //
          // Matters because D9 declares it non-negotiable: if the response
          // was cut off by the cap, the client has to read `length`, not
          // `stop`. Charging for a cap and reporting normal completion is
          // lying in the one field the client looks at to know whether it's
          // missing text.
          const fin = ev.choices && ev.choices[0] && ev.choices[0].finish_reason
          if (typeof fin === 'string' && fin !== '') finishReason = fin

          const delta = ev.choices && ev.choices[0] && ev.choices[0].delta
          if (!delta) continue

          // ONLY content. `reasoning_content` is ignored with no exception:
          // it's the model's thinking and it gives away the provider.
          if (typeof delta.content === 'string' && delta.content !== '') {
            // Every token that arrives proves the provider is still alive, so
            // the clock resets. What's bounded from here on is the SILENCE
            // between tokens, not how long the whole response takes: a long
            // response that keeps flowing is legitimate, thirty seconds of
            // nothing isn't.
            armar(
              this.timeoutIdleMs,
              `el proveedor dejo de mandar tokens por ${this.timeoutIdleMs / 1000}s`
            )
            yield delta.content
          }
        }
      }
    }

    if (usage && onUsage) onUsage(usage)
    if (finishReason && onFinish) onFinish(finishReason)
  }
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

// Upstreams come from a file in the data directory, NOT from the code: which
// APIs this node uses is an operator decision, not the program's.
export function cargarDesde(objeto) {
  if (!objeto || !Array.isArray(objeto.upstreams)) return []
  const out = []
  for (const u of objeto.upstreams) {
    // `apiKeyEnv` stops being mandatory ONLY for a local provider: it's the
    // only one with no credential. For a remote one it's still mandatory,
    // because an upstream with no variable name can't authenticate, and the
    // failure would only show up on the first prompt.
    const esLocal = u && u.local === true
    if (!u || !u.id || !u.baseUrl) continue
    if (!esLocal && !u.apiKeyEnv) continue
    for (const m of u.models || []) {
      if (!m || !m.modelId) continue
      out.push(
        new Upstream({
          id: u.id + ':' + m.modelId,
          label: u.label || u.id,
          baseUrl: u.baseUrl,
          apiKeyEnv: u.apiKeyEnv,
          model: m.modelId,
          anunciadoComo: typeof m.as === 'string' && m.as !== '' ? m.as : null,
          displayName: m.displayName || m.modelId,
          tags: m.tags || [],
          maxConcurrent: Number.isFinite(m.maxConcurrent) ? m.maxConcurrent : 4,
          maxTokens: Number(m.maxTokens),
          precio: precioDe(m),
          esLocal,
          timeoutPrimerChunkMs: m.timeoutPrimerChunkMs,
          timeoutIdleMs: m.timeoutIdleMs,
          extraBody: m.extraBody || null,
          extraHeaders: u.extraHeaders || null
        })
      )
    }
  }
  return out
}

// The price the operator declares, in USD per 1M tokens, converted to the
// integer micro-dollars costs.mjs works with. Never floats past this
// conversion: it's the one point where a number a person wrote enters the
// counter.
//
// Rounded UP. An underestimated price makes the reservation fall short, and
// a short reservation is a cap that gets blown past.
function precioDe(m) {
  const p = m && m.pricePerMTok
  if (!p) return null
  const entrada = Number(p.input)
  const salida = Number(p.output)
  if (!Number.isFinite(entrada) || !Number.isFinite(salida)) return null
  if (entrada < 0 || salida < 0) return null
  if (entrada === 0 && salida === 0) return null
  return {
    entrada: Math.ceil(entrada * 1_000_000),
    salida: Math.ceil(salida * 1_000_000)
  }
}

// D19's OPT-IN: sending the prompt to a third party is an operator decision
// and has to be explicit. Absent means OFF -- a half-written config file
// can't end up sending prompts off the machine.
export function optInDe(objeto) {
  return !!(objeto && objeto.optIn === true)
}

// Reselling a third party's API to the network is ANOTHER decision, and also
// off by default. Nothing consumes it yet: it's read here so that the day
// the broker gets wired up, the safe default is already written where it
// belongs.
export function brokerDe(objeto) {
  return !!(objeto && objeto.brokerEnabled === true)
}

// -----------------------------------------------------------------------------
// The file
// -----------------------------------------------------------------------------

// `<storage>/upstreams.json`, the same directory where budget.json and
// identity.json already live. NOT read from the repo: the config carries the
// name of the credential variable and this person's list of providers.
//
// The file not existing is the NORMAL case, not an error: the vast majority
// of nodes don't talk to any external API. The empty config is returned and
// nobody's bothered. A file that exists but is broken DOES get flagged,
// because there someone tried to configure something and it didn't work.
export async function leerConfig(dir) {
  const vacia = { upstreams: [], optIn: false, brokerEnabled: false, error: null }
  if (!dir) return vacia

  let crudo = null
  try {
    const fs = await import('bare-fs')
    const path = await import('bare-path')
    crudo = fs.default.readFileSync(path.default.join(dir, 'upstreams.json'), 'utf8')
  } catch {
    return vacia
  }

  let objeto = null
  try {
    objeto = JSON.parse(crudo)
  } catch (err) {
    return { ...vacia, error: 'upstreams.json is not valid JSON: ' + ((err && err.message) || err) }
  }

  return {
    upstreams: cargarDesde(objeto),
    optIn: optInDe(objeto),
    brokerEnabled: brokerDe(objeto),
    error: null
  }
}
