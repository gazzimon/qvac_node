// Marketplace gateway. Serves the 3 panels and an OpenAI-compatible API.
//
// WHAT IS COMPATIBLE (tested in test/index.js):
//   POST /v1/chat/completions  accepts { model, messages[], stream } and responds
//     - with stream:true  -> SSE of `chat.completion.chunk` (choices[].delta.content)
//     - with stream:false -> a `chat.completion` (choices[].message.content)
//   GET  /v1/models            returns { object:"list", data:[{id,object:"model",...}] }
//   Errors travel as { error: { message, type, code } }, OpenAI's shape.
//
// WHAT'S NOT THERE (said here so nobody discovers it in the demo):
//   - `usage` (token count) is NOT emitted. The SDK doesn't expose it yet and
//     a made-up count is worse than an absent field: a client billing by
//     token would read a fake number. Absent is honest and doesn't break
//     anyone using simple chat.
//   - No `tools`/`function_call`, no `n`>1, no `logprobs`.
//
// OWN EXTENSIONS (don't clash with OpenAI, no OpenAI client sends these):
//   - The request also accepts the short form { modelId, prompt }.
//   - GET /v1/nodes returns the marketplace's rich view (price, operator,
//     load) that the panels consume. /v1/models stays for the protocol.
//
// ROUTING: against the in-memory registry (store.mjs), which gets populated
// from three different sources and treats them differently:
//   kind 'peer' -> peer discovered via Hyperswarm with a verified signed
//                  manifest. Inference travels over chat:request/chat:chunk
//                  on the swarm's FramedStream (D1). Requires --swarm.
//   kind 'real' -> this machine, via engine.mjs.
//   kind 'mock' -> canned response. Only exists with --demo.
// For the same modelId the P2P peer is preferred (see findAllByModelId), and
// the routing log states how many candidates there were.

import http from 'bare-http1'
import * as store from './store.mjs'
import * as apikeys from './apikeys.mjs'
import * as budget from './budget.mjs'
import * as x402 from './x402.mjs'
import * as atestacion from './atestacion.mjs'
import * as lote from './lote.mjs'
import * as costs from './costs.mjs'
import * as quota from './quota.mjs'
import { pickCandidate, estaSaturado } from './routing.mjs'
import { DEFAULT_MODEL } from './models.mjs'
import { InferenceProgress } from './progress.mjs'
// See the note in upstream.mjs: under Bare this isn't a global.
import AbortController from 'bare-abort-controller'

const MOCK_REPLIES = {
  'facturas-ar': (prompt) =>
    `I read your receipt. Based on the AFIP format I detect: type "Factura B", ` +
    `simulated CAE 71234567890123, estimated total amount from your request ("${truncate(prompt)}") ` +
    `pending validation against the registry. (Simulated response — this node is a demo.)`,
  'arquitectura-planos': (prompt) =>
    `Analyzing the floor plan you describe ("${truncate(prompt)}"): I identify a possible 3-room layout, ` +
    `approximate covered area 68 m², and I suggest checking the rear setback against the local ` +
    `building code. (Simulated response — this node is a demo.)`,
  'traductor-en-es': (prompt) =>
    `Simulated translation of "${truncate(prompt)}": this represents the text translated into Spanish, ` +
    `keeping the original tone. (Simulated response — this node is a demo.)`
}

function truncate(s, n = 60) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

// Tokens per second of GENERATION, not of the request: TTFT is subtracted
// out. Mixing them would give a number that drops when the model is slow to
// start even if it then spits out tokens just as fast, and that's exactly the
// confusion the pair of numbers (ttft + tok/s) exists to avoid.
//
// Returns null instead of 0 when there's nothing to measure: a request that
// failed before the first token didn't generate "at zero tokens per second,"
// it didn't generate.
function tokensPerSec({ tokens, ttftMs, ms }) {
  if (!tokens || ttftMs === null) return null
  const genMs = ms - ttftMs
  if (genMs <= 0) return null
  return Number(((tokens / genMs) * 1000).toFixed(2))
}

// The real model loads ONCE, lazily -only on the first chat that needs
// it-, same as the "zero model" Phase 3 already defines: the gateway starts
// up without having downloaded or loaded anything.
let engineMod = null
let realModelId = null
let realModelLoading = null
let gpuLayers // undefined = let the SDK decide

// Which model this machine's engine loads. It used to be the literal
// 'llama1b' in here while `bin.mjs` announced `DEFAULT_MODEL` on its own
// side: two sources for the same piece of data, which only agreed because
// both values happened to be equal. `swarmModels()`'s comment already asked
// for a single source -- "if they diverged, the node would announce a model
// it later rejects" --, and they did diverge.
//
// Now it comes in through `createGateway({ model })`, which is also what
// gets announced.
let modeloLocal = DEFAULT_MODEL

// The engine's context window. It used to NOT get passed, so the model
// always loaded with the default of 2048 -- enough for a short chat but not
// for a "thinking" model: measured with qwen4b, the reasoning ate the whole
// window and the response got cut off mid-sentence, never even reaching the
// closing <think>. 2048 is prompt + reasoning + response combined.
let ctxLocal // undefined = engine.mjs's default

// Live generation progress, in the `serve` terminal. Off by default: it's
// noise for someone who just wants the node running, and it's exactly what's
// missing when debugging why a response is taking four minutes.
// `serve --log-inference` turns it on.
let logInferencia = false

export function modeloLocalActual() {
  return modeloLocal
}

function ensureRealModel() {
  if (realModelId) return Promise.resolve(realModelId)
  if (!realModelLoading) {
    realModelLoading = (async () => {
      const t0 = Date.now()
      engineMod = engineMod || (await import('./engine.mjs'))
      const { modelSrc } = await engineMod.resolveModel(modeloLocal)
      realModelId = await engineMod.loadModel({
        modelSrc,
        gpuLayers,
        ...(Number.isFinite(ctxLocal) ? { ctxSize: ctxLocal } : {})
      })

      // Lazy loading is the explanation for almost every anomalous TTFT: the
      // first chat after startup pays for downloading and loading the model,
      // and without this entry the trail shows a super-slow request with no
      // visible cause next to it.
      store.pushLog({
        kind: 'model_load',
        modelId: modeloLocal,
        target: 'local',
        ok: true,
        gpuLayers: gpuLayers ?? null,
        reason: `real model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        ms: Date.now() - t0
      })
      return realModelId
    })()
    // If loading fails, the rejected promise has to be LET GO. If it stays
    // cached, every later request gets the same rejection instantly and the
    // gateway never recovers without a restart -a registry timeout from bad
    // wifi used to leave the real node dead for the whole session-.
    realModelLoading.catch(() => {
      realModelLoading = null
    })
  }
  return realModelLoading
}

// ---------------------------------------------------------------------------
// OpenAI shape
// ---------------------------------------------------------------------------

let idCounter = 0

// `crypto.randomUUID` doesn't exist in bare, and the id only needs to be
// unique WITHIN this process: it's the key the client uses to correlate the
// chunks of ONE response, not a global identifier.
function completionId() {
  return 'chatcmpl-' + Date.now().toString(36) + (idCounter++).toString(36)
}

// B14 / D9 — the `finish_reason` the client sees.
//
// D9 declares it NON-NEGOTIABLE: if the response was cut off by the cap, it
// has to say `length`. Charging for a cap and reporting normal completion is
// lying in the one field the client looks at to know whether it's missing
// text -- and the one an agent looks at to decide whether to ask for the
// continuation.
//
// The value comes from WHOEVER GENERATED: the external provider sends it in
// the last chunk (upstream.mjs reads it and reports it via `onFinish`).
// Counting it on this side wouldn't work: we count SSE deltas, not tokens, so
// comparing them against the cap would give an approximate number, not the
// fact.
//
// With no value, `stop` is reported, which is what the gateway used to do for
// ALL responses. The difference is that now it's the default for "nobody said
// otherwise" and not a claim about every response.
function finishReasonDe(reportado) {
  if (typeof reportado !== 'string' || reportado === '') return 'stop'
  // Passed through as-is with OpenAI's vocabulary, which is what the client
  // expects: stop, length, content_filter, tool_calls. A value we don't know
  // still travels through instead of getting flattened to 'stop': making up a
  // known ending for something the provider named differently is the same
  // lie, just smaller.
  return reportado
}

function chunkEvent({ id, created, model, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
}

// OpenAI's exact error shape. Clients (Hermes included) read `error.message`;
// returning a plain string leaves them with no message to show.
function sendError(res, statusCode, message, { type = 'invalid_request_error', code = null } = {}) {
  const payload = JSON.stringify({ error: { message, type, code } })
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function sendJson(res, statusCode, body, extraHeaders = null) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...(extraHeaders || {}) })
  res.end(payload)
}

// Who answered, in the response itself.
//
// Goes in headers and not in the body on purpose: putting our own field
// inside a `chat.completion.chunk` would dirty OpenAI's format, which is
// exactly what this gateway promises to respect. No third-party client sees
// an extra header, and our own chat reads it with headers.get().
//
// encodeURIComponent because a header can't carry bytes outside latin-1 and
// the operator name is chosen by a person ("Nodo de Ramón").
// An upstream running on this machine is NOT a third party. Everything that
// decides privacy and spend -- the opt-in, the `local: true` filter, the "no
// local capacity" condition -- asks this, not `kind`, which only says HOW
// it's asked (over HTTP), not WHO it's asked of.
function esTercero(node) {
  return !!node && node.kind === 'upstream' && node.local !== true
}

// What label this candidate's output enters the trail under.
function targetDe(node) {
  if (!node) return 'none'
  if (node.kind === 'peer') return 'peer'
  if (node.kind === 'mock') return 'mock'
  return esTercero(node) ? 'upstream' : 'local'
}

// PHASE 8 — `costMicros` is the ESTIMATE, not the real cost, and the
// difference matters.
//
// The real one is known once it's finished; these headers go out BEFORE the
// first token, because in SSE there's no other moment (roadmap's R4). So
// what travels is the UPPER BOUND the spend was authorized with -- the same
// number the reservation set aside -- and the chat displays it as a cap, not
// a price.
//
// Sending the real one would require an HTTP trailer or a second request
// against the log, and both are worse than stating the truth of what's known
// when it's known.
function provenanceHeaders(node, costMicros = 0) {
  return {
    'X-Pyrus-Operator': encodeURIComponent((node && node.operator) || ''),
    'X-Pyrus-Kind': (node && node.kind) || 'unknown',
    'X-Pyrus-Cost-Estimate-Micros': String(Math.max(0, Math.ceil(Number(costMicros) || 0))),
    // Which side of the machine's edge the response was generated on. `kind`
    // isn't enough: an upstream can be a third party or our own engine
    // behind HTTP, and the chat needs to know which so it doesn't promise
    // too little or too much.
    'X-Pyrus-Scope': esTercero(node) ? 'external' : 'local',
    'X-Pyrus-Model': encodeURIComponent((node && node.modelId) || '')
  }
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

// The name comes from the query, i.e. the browser, i.e. anyone who hits the
// endpoint. Without this, a name of "../../.ssh/authorized_keys" writes
// somewhere it shouldn't: the path gets built with join() and `..` walks it
// out of the folder. Keeps ONLY the base name and characters that exist
// across the three filesystems we care about.
function sanitizeFilename(nombre) {
  const base = String(nombre).replace(/\\/g, '/').split('/').pop() || ''
  const limpio = base
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return limpio === '.' || limpio === '..' ? '' : limpio
}

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

function uploadsDir() {
  return storageSubdir('uploads')
}

function descargasDir() {
  return storageSubdir('descargas')
}

// Both folders hang off the node's storage, not the cwd: `serve` can start
// from anywhere, and files have no reason to show up wherever the operator
// happened to run the command from.
function storageSubdir(nombre) {
  const base = filesApi && filesApi.dir ? filesApi.dir : '.'
  return base.replace(/[\\/]+$/, '') + '/' + nombre
}

// Written via stream, not Buffer.concat: a large file buffered whole is
// memory taken from a process that's also serving inference.
async function recibirArchivo(req, nombre) {
  const fs = await import('bare-fs')
  const dir = uploadsDir()
  await fs.default.promises.mkdir(dir, { recursive: true })
  const destino = dir + '/' + nombre

  let total = 0
  const out = fs.default.createWriteStream(destino)

  // Hooked up BEFORE writing anything. A stream 'error' with no listener is
  // an uncaught exception that takes down the ENTIRE process -the same one
  // that's also serving inference-, not just this upload. It's stored
  // instead of reacted to on the spot: the for-await below is what decides
  // when to cut off, so it doesn't stomp on the "too large" catch mid-write.
  let streamErr = null
  out.on('error', (err) => {
    streamErr = streamErr || err
  })

  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_UPLOAD_BYTES) {
        throw new Error(
          `file too large (limit ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`
        )
      }
      if (streamErr) throw streamErr
      if (!out.write(chunk)) {
        // Without the 'error' handler here, a stream that dies WAITING to
        // drain never fires resolve or reject: the request would hang
        // forever instead of failing.
        await new Promise((resolve) => {
          out.once('drain', resolve)
          out.once('error', resolve)
        })
        if (streamErr) throw streamErr
      }
    }
  } catch (err) {
    out.destroy()
    // An upload cut off halfway leaves a truncated file that would later get
    // published as if it were complete. Deleted before propagating.
    await fs.default.promises.unlink(destino).catch(() => {})
    throw err
  }

  await new Promise((resolve, reject) => {
    if (streamErr) return reject(streamErr)
    out.end(() => resolve())
    out.once('error', reject)
  })
  if (total === 0) {
    await fs.default.promises.unlink(destino).catch(() => {})
    throw new Error('file arrived empty')
  }
  return destino
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function* mockTokens(node, prompt) {
  const reply = (MOCK_REPLIES[node.modelId] || (() => 'Simulated response.'))(prompt)
  for (const word of reply.split(' ')) {
    yield word + ' '
    await sleep(35)
  }
}

// Translates the received body into { model, messages, stream }. Accepts
// OpenAI's shape and our own short form; returns { error } if it's neither,
// so the caller can respond 400 with a message saying what's missing.
export function normalizeRequest(body) {
  // OpenAI's default is stream:false, and it has to be honored: a client that
  // omits the field expects ONE complete json, not an SSE its parser won't
  // understand. The panels and the demo's curl send stream:true explicitly.
  const stream = body.stream === true

  // Our own extension: "keep this prompt from leaving this machine." No
  // OpenAI client sends it, and omitting it leaves the usual behavior.
  const local = body.local === true

  // Our own extension: pinning the MACHINE, not just the model. `model` says
  // WHAT is wanted; `node` says WHO it's asked of. Two different questions,
  // and until now only the first could be answered: with two peers serving
  // the same modelId there was no way to pick one.
  //
  // The value is the registry row's `id`, which is what /v1/nodes already
  // returns, so the panel needs nothing new from the backend.
  const pin = typeof body.node === 'string' && body.node.trim() !== '' ? body.node.trim() : null

  // OpenAI's `max_tokens`. Read for Phase 6.5's cost estimate: the
  // reservation is the UPPER BOUND of the spend, and with no output cap
  // there's no upper bound to calculate. Zero means "wasn't sent," not "zero
  // tokens" -- the gateway doesn't enforce it yet, it only looks at it.
  const pedido = Number(body.max_tokens)
  const maxTokens = Number.isFinite(pedido) && pedido > 0 ? Math.floor(pedido) : 0

  // Our own short form: { modelId, prompt }
  if (body.model === undefined && body.modelId !== undefined) {
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      return { error: 'the short form needs "prompt" (non-empty string)' }
    }
    return {
      model: body.modelId,
      messages: [{ role: 'user', content: body.prompt }],
      stream,
      local,
      pin,
      maxTokens
    }
  }

  if (typeof body.model !== 'string' || body.model === '') {
    return { error: 'missing "model" (string with the model id)' }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: '"messages" has to be an array with at least one message' }
  }

  const messages = []
  for (const m of body.messages) {
    if (!m || typeof m.role !== 'string') {
      return { error: 'every message needs "role" and "content" of type string' }
    }
    // OpenAI allows content as an array of parts ({type:'text',text}). Text
    // parts get flattened and image parts get ignored: this gateway has no
    // multimodal models, and failing with an error would shut out clients
    // that send the array by default even when it only carries text.
    let content = m.content
    if (Array.isArray(content)) {
      content = content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
    }
    if (typeof content !== 'string') {
      return { error: `the message with role "${m.role}" carries no text content` }
    }
    messages.push({ role: m.role, content })
  }

  // `local` also travels through here. It used to be missing: the short form
  // ({modelId, prompt}) returned it and OpenAI's standard form didn't, so the
  // chat's "local only" toggle -- which sends the standard form, see
  // pages.mjs -- arrived as undefined and handleChat's filter never got
  // applied. The prompt could go out to a peer with the lock switched on
  // screen.
  return { model: body.model, messages, stream, local, pin, maxTokens }
}

// ---------------------------------------------------------------------------
// Inference against a remote peer (Phase 3)
// ---------------------------------------------------------------------------

// The peer didn't acknowledge: it's dead, or it's running a version that
// doesn't understand chat:request. Short on purpose -- it hasn't cost anyone
// anything yet.
const ACCEPT_TIMEOUT_MS = 8000

// It already acknowledged and is working, but it might be loading 807 MB of
// weights for the first time. Generous for that reason; not infinite,
// because an SDK hang on the other end can't leave the client waiting
// forever.
const FIRST_CHUNK_TIMEOUT_MS = 120000

// Tokens were already coming in and got cut off with no chat:done. The
// connection is still alive (if it dropped, the swarm reports it instantly),
// so this is the peer being stuck.
const IDLE_TIMEOUT_MS = 60000

// PHASE 10 / D27 case 1 — the client cut off and chat:cancel has already been
// sent to the peer. `swarm.cancelChat` keeps the chat alive waiting for the
// late chat:done (carrying the peer's partial signed attestation). This is
// the LAST resort: if neither the real chat:done nor `cancelChat`'s synthetic
// one arrives —fake swarm in the tests, or no swarm— the attempt closes
// anyway, charging for the prefix and with no attestation from this side.
const LATE_DONE_FALLBACK_MS = 2500

let swarmRef = null

// The node's Hyperdrive. Injected by bin.mjs after opening it, same as the
// swarm: the gateway doesn't open it on its own because the Corestore takes a
// RocksDB lock on its folder, and a second `openStore` on the same path
// fails. One single owner of the store, and the gateway is a guest.
let filesApi = null

export function setFiles(f) {
  filesApi = f
}

export function setSwarm(swarm) {
  swarmRef = swarm
}

// PHASE 7 — THIS node's payout address, or null if it has no wallet.
//
// Arrives already built from bin.mjs, which owns the storage directory and is
// the only one that knows the passphrase. The gateway NEVER opens the
// keystore or sees the seed: it only shows what already travels publicly in
// the signed manifest.
let economicPropio = null

export function setEconomic(economic) {
  economicPropio = economic || null
  return economicPropio
}

// PHASE 9 / D24 — what signs the attestation for what this node served.
//
// It's a FUNCTION, not a key: bin.mjs opens the keystore, keeps the account,
// and passes a `(message) => Promise<signature>` in here. The invariant
// above doesn't loosen — the gateway still never sees the seed — but now it
// can request a signature without holding one.
//
// Without this there's no attestation. An unsigned one is NEVER issued: an
// artifact that looks like proof and isn't is worse than one that's absent,
// and that's exactly the shape of "looking complete" while being dishonest.
let firmarConWallet = null

export function setWalletSigner(fn) {
  firmarConWallet = typeof fn === 'function' ? fn : null
  return !!firmarConWallet
}

export function walletStatus() {
  return {
    // `false` isn't an error: a node that only consumes doesn't need a
    // wallet, and its manifest announces the block marked as mock.
    configurada: !!economicPropio,
    address: economicPropio ? economicPropio.walletAddress : null,
    chains: economicPropio ? economicPropio.chains : [],
    settlement: economicPropio ? economicPropio.settlement : null
  }
}

// ---------------------------------------------------------------------------
// PHASE 8.5 — the external assistant
//
// The gateway receives the instances already built, same as the swarm and
// the drive: whoever reads `upstreams.json` is bin.mjs, which owns the
// storage directory. Here it's only known that they exist and which registry
// row they correspond to.
//
// The Map's key is the store row's `id` (`upstream:<id>`), which is what the
// chosen candidate carries: that way dispatch doesn't have to search by model
// again or guess which of two upstreams from the same provider it was.
// ---------------------------------------------------------------------------
let upstreams = new Map()

// D19: sending the prompt to a third party is OFF unless the operator turns
// it on. The default lives here and not in the config so a missing, empty,
// or broken file means the same thing as a "no."
let upstreamOptIn = false

export function setUpstreams(lista) {
  upstreams = new Map()
  for (const u of lista || []) upstreams.set(`upstream:${u.id}`, u)
}

export function setUpstreamOptIn(valor) {
  upstreamOptIn = valor === true
  return upstreamOptIn
}

export function upstreamStatus() {
  return {
    optIn: upstreamOptIn,
    upstreams: [...upstreams.values()].map((u) => ({
      id: u.id,
      nodeId: `upstream:${u.id}`,
      label: u.label,
      model: u.model,
      displayName: u.displayName,
      maxTokens: u.maxTokens,
      // The environment variable's NAME, never its value.
      apiKeyEnv: u.apiKeyEnv,
      credencial: u.disponible()
    }))
  }
}

// An upstream's effective output cap: the lesser of what the client asked
// for and what the node allows. Calculated HERE -- not only inside
// `completar` -- because it's the number the reservation is estimated with,
// and a reservation calculated against a different cap than the one that's
// sent doesn't bound anything.
function topeDeSalida(node, pedido) {
  const up = upstreams.get(node && node.id)
  if (!up) return pedido
  return pedido > 0 ? Math.min(pedido, up.maxTokens) : up.maxTokens
}

// PHASE 9 / D9(a) — the output cap when the request GETS CHARGED at a fixed
// price.
//
// `topeDeSalida` returns the upstream's, and ZERO for everything else: today
// a peer and the local engine have no cap, and that's fine, because they
// charge nothing.
//
// With a 402 involved that stops working. D9(a) is "up to N output tokens
// for $X," and the DoD requires the 402 to declare that N: a fixed price for
// unbounded work is exactly what the decision warns not to do. So whenever
// there's a charge there's ALWAYS a cap, even where the free path doesn't
// need one.
//
// The number is declared BEFORE generating and enforced AFTER: they're the
// same one, and they have to be -- declaring one and cutting off with
// another means charging for different work than what was agreed.
const MAX_TOKENS_COBRADO = 2048

function topeDeSalidaCobrado(node, pedido) {
  const propio = topeDeSalida(node, pedido)
  if (propio > 0) return propio
  // A client can ask for LESS than the cap; it can't ask for more, or for none.
  return pedido > 0 ? Math.min(pedido, MAX_TOKENS_COBRADO) : MAX_TOKENS_COBRADO
}

// Prompt tokens, estimated by characters, ONLY for the reservation.
//
// The exact number is known by the provider's tokenizer and only arrives
// with the last chunk's `usage` -- after spending. Divided by 3, not by the
// ~4 characters per token that's the usual rule: the reservation is an UPPER
// bound, and erring high cuts off early while erring low lets spend past the
// cap slip through.
//
// BYTES ARE COUNTED, IN UTF-8, NOT CHARACTERS, and that's B6's fix. The
// previous version divided characters by 3 and claimed to be an upper bound,
// which is true in English and false in Chinese, Japanese, Korean, Arabic, or
// Hindi: there the ratio gets close to 1 token per character, and the
// reservation ended up well under the actual spend, exactly where the
// comment promised the opposite. In UTF-8 those alphabets take 3 bytes per
// character, so counting bytes lets a single divisor cover all of them.
//
// This isn't claimed to be a PROVABLE upper bound: a tokenizer with
// byte-fallback can, in the worst pathological case, emit one token per
// byte. It's a deliberately conservative estimate -- ~2 bytes per token
// covers real text in any of those alphabets with margin to spare -- and the
// provider's `usage` corrects the number at settlement time.
function estimarPromptTokens(messages) {
  let bytes = 0
  for (const m of messages || []) bytes += Buffer.byteLength(String((m && m.content) || ''), 'utf8')
  return Math.ceil(bytes / 2)
}

// PHASE 9 / D9 — OUTPUT tokens estimated from the accumulated TEXT.
//
// Not the same estimator as the one above, and it can't be: that one is a
// deliberate UPPER bound, because erring high on a reservation cuts off
// early and erring low lets spend through. This one decides WHERE a response
// GETS CUT OFF, and there the asymmetry flips: overestimating trims text
// from a client that already paid for it.
//
// And above all: counted from the TEXT, not from the deltas. The gateway
// increments its counter once per delta with content, and whoever decides
// how the stream gets chunked is the provider -- a peer emitting one
// character per delta would make a cap counted in deltas trip at 2048
// characters. Text doesn't depend on chunking. Same argument as why D24's
// attestation carries `outputHash` and not a count.
//
// It's an ESTIMATE and doesn't match the model's tokenizer: ~4 bytes per
// token is the usual rule for Latin text and falls short for CJK. That's why
// the number declared in the 402 and the one enforced are the same one, but
// neither is a measurement. Stated in the README, not hidden.
function estimarTokensDeSalida(texto) {
  return Math.floor(Buffer.byteLength(String(texto || ''), 'utf8') / 4)
}

// ---------------------------------------------------------------------------
// Launching the local agent from the page.
//
// The gateway doesn't know HOW a swarm gets built -- that lives in bin.mjs,
// which is the only owner of the Corestore. It only knows something builds
// it and that it takes time. Without this, "put your machine to work"
// meant going back to the terminal and restarting the process with another
// flag, which is exactly what a button can't ask anyone to do.
// ---------------------------------------------------------------------------
let launcher = null
let launchState = { status: 'offline', message: null }

// The panel's own credential. `keyForNode` reuses the existing entry for the
// same id, so requesting one on every load returns the SAME key instead of
// filling the registry with orphans.
//
// The panel needs one because the gate stopped accepting requests without
// Authorization: if the browser didn't send a credential, the chat page
// would be the one client that can't talk to its own gateway.
const PANEL_KEY_ID = 'panel'

export function setLauncher(fn) {
  launcher = fn
}

export function agentStatus() {
  if (swarmRef) {
    return {
      status: 'live',
      operator: swarmRef.operator,
      publicKey: swarmRef.identity.publicKey.toString('hex'),
      verifiedPeers: swarmRef.verifiedPeers().length,
      canLaunch: launcher !== null,
      message: null
    }
  }
  return {
    status: launchState.status,
    operator: null,
    publicKey: null,
    verifiedPeers: 0,
    canLaunch: launcher !== null,
    message: launchState.message
  }
}

// State of the last model change requested from the Provider panel.
// `null` = one was never requested in this session (the model `serve
// --swarm` started with is simply ready, not "loading").
let modelLoadState = null

function currentModelEntry() {
  return swarmRef && swarmRef.models && swarmRef.models[0] ? swarmRef.models[0] : null
}

// An attempt against ONE peer. Always resolves (never rejects) with the
// result, including whether it managed to emit any chunk at all -- which is
// the piece of data D4 uses to decide whether it can retry against another
// candidate.
function streamFromPeer({
  node,
  model,
  messages,
  onChunk,
  onStart,
  signal = null,
  // PHASE 10 — the verified payment and the 402's cap. Forwarded to the
  // peer: whoever runs the model is the one who charges (full handoff), and
  // cuts off at the same point it attests. `null` when the request didn't
  // come from a paid path.
  pago = null,
  tope = 0
}) {
  return new Promise((resolve) => {
    let started = false
    let finished = false
    let timer = null
    let requestId = null
    // PHASE 10 / D27 case 1 — once cancel has been requested, a late
    // `chat:chunk` can no longer stretch the idle-timeout timer: the only
    // thing still being waited for is `chat:done` with the partial
    // attestation.
    let cancelPedido = false

    const finish = (r) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      // If it cuts off from a timeout or an error, the peer gets told so it
      // stops generating: continuing to spend its CPU on tokens that have
      // nowhere to go is exactly what chat:cancel exists to prevent.
      if (!r.ok && requestId) swarmRef.cancelChat(requestId)
      resolve({ ...r, started })
    }

    // PHASE 9 / D27 — a DELIBERATE cutoff isn't a peer failure.
    //
    // There are two: the client closed the tab (case 1) and the token cap
    // the 402 declared got hit (case 3). In both, what the peer emitted up
    // to that point is valid, the client received it, and D27 decides it
    // gets charged. Without this the request used to sit waiting for the
    // idle-timeout clock —60 seconds— and end up as `peer_stalled`, i.e. as
    // if the peer had failed: what had actually been served neither got
    // charged nor attested.
    //
    // With `started` false it's the other way around: not a single token
    // came out, there's nothing to charge or attest, and that's a cutoff
    // with no result.
    const onAbort = () => {
      if (finished) return
      if (requestId) swarmRef.cancelChat(requestId)
      if (!started) {
        return finish({
          ok: false,
          code: 'aborted',
          message: 'the request was cut off before the first token'
        })
      }
      // PHASE 10 / D27 case 1 — the client left but the peer ALREADY served a
      // prefix and is attesting to it. The attempt is NOT closed on the
      // spot: `cancelChat` keeps the chat alive for a short window and the
      // peer sends a late `chat:done` with its partial signed attestation;
      // that `onDone` closes here, with the pending signature, and
      // `registrarRuteado` attaches it to the receipt. This timeout is the
      // last resort if that `chat:done` doesn't arrive, not even the
      // synthetic one: the prefix gets charged, with no attestation from
      // this side.
      cancelPedido = true
      clearTimeout(timer)
      timer = setTimeout(
        () =>
          finish({
            ok: true,
            cortado: true,
            attestation: null,
            attestationMissing: 'the peer did not return a chat:done after the client cut off'
          }),
        LATE_DONE_FALLBACK_MS
      )
      timer.unref?.()
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const arm = (ms, message, code) => {
      clearTimeout(timer)
      timer = setTimeout(() => finish({ ok: false, message, code }), ms)
      timer.unref?.()
    }

    const payment = pago
      ? {
          authorization: pago.autorizacion,
          signature: pago.firma,
          requirements: pago.requisito,
          red: pago.red
        }
      : null

    requestId = swarmRef.chatRequest(
      node.peerKey,
      { model, messages, payment, maxTokens: tope },
      {
        onAccepted: () => {
          arm(
            FIRST_CHUNK_TIMEOUT_MS,
            'the peer accepted the request but sent no token',
            'peer_timeout'
          )
        },
        onChunk: (delta) => {
          started = true
          if (!cancelPedido) {
            arm(IDLE_TIMEOUT_MS, 'the peer stopped sending tokens mid-stream', 'peer_stalled')
          }
          onChunk(delta)
        },
        // PHASE 10 — `chat:done` carries the D24 attestation signed by the
        // peer (or the reason it's missing). Passed back up to attach it to
        // the receipt; the gateway does NOT settle a routed request (the
        // peer does, deferred).
        onDone: (extra) =>
          finish({
            ok: true,
            attestation: (extra && extra.attestation) || null,
            attestationMissing: (extra && extra.attestationMissing) || null
          }),
        onError: (message, code) => finish({ ok: false, message, code })
      }
    )

    if (!requestId)
      return finish({ ok: false, message: 'el par ya no esta conectado', code: 'peer_gone' })

    // The caller needs the requestId to be able to cancel if the HTTP client
    // leaves. This didn't used to exist and `requestIdEnVuelo` stayed null:
    // chat:cancel never had an id to send, so the peer kept generating for a
    // client that was already gone.
    if (onStart) onStart(requestId)

    arm(ACCEPT_TIMEOUT_MS, 'the peer did not acknowledge the request', 'peer_no_ack')
  })
}

// What ONE attempt cost, with the three different truths there can be:
//
//   1. Not a single token arrived. The provider generated nothing and isn't
//      going to bill us anything: charging the upper bound would mean
//      charging for a request that never happened. This is the case of the
//      hung provider and the one that rejects before starting -- and now
//      also the case of a candidate that failed and got retried elsewhere,
//      which can't be charged twice.
//
//   2. Tokens arrived AND the provider's `usage` arrived. Those are the REAL
//      tokens, counted by ITS tokenizer. That's what gets settled.
//
//   3. Tokens arrived and `usage` did NOT arrive. There was spend and we
//      don't know how much: the whole reservation gets charged, which is the
//      upper bound the spend was authorized with. Errs high, which is the
//      only side that doesn't go over the cap (B2). And it's said out loud: a
//      provider that doesn't send usage is something the operator has to see
//      and fix, not a silent gap between this ledger and the end-of-month
//      bill.
//
// Deltas counted on this side are NOT usable to bill an external provider:
// they're SSE chunks, not tokens, and the input ones are simply never seen.
function costoDelIntento({ node, usoExterno, tokens, reserva }) {
  if (!esTercero(node)) {
    return costs.real({ model: claveDePrecio(node), completionTokens: tokens })
  }
  if (!usoExterno && tokens === 0) return 0
  if (!usoExterno) {
    const costo = reserva.micros || 0
    console.error(
      `[${node.id}] provider did not send "usage": settling against the reservation ` +
        `(${costs.formatUSD(costo)}), which is the upper bound, not the real cost`
    )
    return costo
  }
  return costs.real({
    model: claveDePrecio(node),
    promptTokens: Number(usoExterno.prompt_tokens) || 0,
    completionTokens: Number.isFinite(Number(usoExterno.completion_tokens))
      ? Number(usoExterno.completion_tokens)
      : tokens
  })
}

// An attempt against a candidate that is NOT a peer: the embedded engine, an
// upstream (our own or a third party's), or a mock from --demo mode.
//
// Returns the SAME shape as streamFromPeer and, like it, never rejects:
// { ok, started, code, message }. That symmetry is what lets a single loop
// walk candidates of any kind. There used to be two separate paths -- one
// with retry and one without -- and the retry stopped short at the boundary
// between peers and non-peers: if every peer failed, the local model never
// got tried even though it was in the same candidate list.
//
// `started` is the piece of data D4 decides with: once a token has gone out
// to the client, there's no retrying on another node, because a half-done
// response can't be picked back up on a different machine.
async function streamFromLocal({
  node,
  messages,
  prompt,
  maxSalida,
  signal,
  onChunk,
  onUsage,
  onFinish
}) {
  let started = false
  // Starts BEFORE `ensureRealModel()` on purpose: model loading is exactly
  // the stretch where nothing gets emitted and where you start wondering if
  // the process died.
  const progreso = logInferencia
    ? new InferenceProgress({ model: node.modelId, node: node.id }).start()
    : null
  try {
    let crudos
    if (node.kind === 'real') {
      const mid = await ensureRealModel()
      crudos = engineMod.complete({ modelId: mid, history: messages })
    } else if (node.kind === 'upstream') {
      // The registry row and the instance that knows how to talk to the API
      // are two different things: the row can outlive a config re-read that
      // dropped the upstream, and in that case it has to fail and say so --
      // not fall back to the mock, which would return made-up text under a
      // real provider's headers.
      const up = upstreams.get(node.id)
      if (!up) throw new Error('the external assistant is no longer configured on this node')
      if (!up.disponible()) {
        throw new Error(
          'missing external assistant credential: set the ' + up.apiKeyEnv + ' environment variable'
        )
      }
      crudos = up.completar({ messages, maxTokens: maxSalida, signal, onUsage, onFinish })
    } else {
      crudos = mockTokens(node, prompt)
    }

    for await (const delta of crudos) {
      // Cutting the `for await` closes the generator, and completar()'s
      // finally aborts the fetch. That's why leaving is enough: there's no
      // need to manually propagate the cancellation down to the provider's
      // socket.
      if (signal.aborted) break
      started = true
      if (progreso) progreso.chunk(delta)
      onChunk(delta)
    }
    if (progreso) progreso.done(signal.aborted ? 'cancelled' : 'done')
    return { ok: true, started, code: null, message: null }
  } catch (err) {
    // PHASE 9 / D27 — if WE were the ones who cut it off, it isn't a
    // provider failure.
    //
    // B3 wired this signal to the external fetch, so aborting doesn't make
    // the `for await` exit through the `break` above: it makes the generator
    // THROW. Without this guard, a client closing the tab or a D9 cap
    // tripping used to get reported as `upstream_error`, and with that a
    // prefix the client HAD received got neither settled nor attested --
    // exactly the opposite of what D27 decides.
    //
    // `started` is the condition: with not a single token there's no prefix
    // to charge, and there the cutoff is still a request with no result. And
    // the signal is ONLY ours -- the provider protocol's clocks live inside
    // `completar()` with their own controller (B16) --, so a hung provider
    // doesn't come through here.
    if (signal.aborted && started) {
      if (progreso) progreso.done('cancelled')
      return { ok: true, started, cortado: true, code: null, message: null }
    }
    const message = String((err && err.message) || err)
    if (progreso) progreso.done('failed')
    return {
      ok: false,
      started,
      // A 429 from the provider is "can't right NOW," same as a peer's
      // at_capacity: the loop treats it as saturation and tries the next
      // one. It's the only way to react to an exhausted daily quota, which
      // the ledger can't see because it isn't measured in dollars.
      code: /\b429\b/.test(message)
        ? 'at_capacity'
        : esTercero(node)
          ? 'upstream_error'
          : 'local_error',
      message
    }
  } finally {
    // `done()` already stops the timer, but an exit path that doesn't call it
    // would leave a live interval per request. The `finally` is the
    // guarantee.
    if (progreso) progreso.stop()
  }
}

// Serves a request by walking candidates IN ORDER until one answers.
//
// Used to be called handleRemoteChat and only looked at peers; the local
// engine and upstreams had their own path with no retry, and once a node was
// chosen the request was bound to it. Now there's a single walk for every
// kind: if the best candidate fails BEFORE the first token -- it's
// saturated, has no credential, there's no swarm, it's out of daily
// quota -- the next one is tried, whatever kind it is.
// PHASE 9 / D12 — settle and leave the receipt recoverable.
//
// Happens AFTER serving. If it fails, the client already received its
// tokens and this node ends up not getting paid: that's the price of not
// putting an on-chain transaction in front of TTFT, accepted by D12, and
// what Phase 10 actually fixes by accumulating receipts instead of settling
// one at a time.
//
// Never throws. A settlement that fails can't take down a response that
// already went out fine.
const recibos = new Map()

// How many receipts get kept. It's process memory, not a ledger: the real
// ledger is the chain. This exists so a client that lost the SSE event can
// recover it in the following minutes.
const MAX_RECIBOS = 200

// PHASE 9 / D25 — prefill and decode, separated, and where each number came
// from.
//
// D22 (flat pricing) is NOT touched: this RECORDS, it doesn't price. And it
// doesn't change the routing math, which still asks the ledger for the price
// in micro-dollars the way Phase 8 settled it — neither `estimarRequest` nor
// `costoDelIntento` reads anything from here.
//
// The field that matters just as much as the two numbers is `tokensFuente`,
// and it exists for a reason the gateway itself already had written down:
// what this process counts are SSE CHUNKS, not tokens, and it never sees the
// input ones directly. When the provider sends `usage` those are the real
// tokens, counted by its tokenizer; when it doesn't, what's left is a prompt
// estimate and a delta count. They're two different things and without this
// field they read the same: Phase 10 is going to want to settle against this
// series and has to be able to tell them apart.
function tokensD25({ usoExterno, tokens, promptTokens }) {
  const decodeReal = usoExterno && Number.isFinite(Number(usoExterno.completion_tokens))
  const prefillReal = usoExterno && Number.isFinite(Number(usoExterno.prompt_tokens))

  return {
    tokensPrefill: prefillReal ? Number(usoExterno.prompt_tokens) : promptTokens,
    tokensDecode: decodeReal ? Number(usoExterno.completion_tokens) : tokens,
    // 'proveedor' only if BOTH came from usage. With just one, the pair
    // stops being comparable to another, and saying "proveedor" for half of
    // it would be worse than saying "gateway": it would suggest there's a
    // measurement where there's an estimate.
    tokensFuente: decodeReal && prefillReal ? 'proveedor' : 'gateway'
  }
}

// PHASE 9 / D24 — the artifact where the provider attests to WHAT IT SERVED.
//
// Returns `{ atestacion }` or `{ sinAtestacion: motivo }`. Never a
// half-done attestation: the reason travels in the receipt so the absence is
// READABLE, which is the difference between a missing field and a mock that
// looks functional.
//
// The rule for WHO can sign lives in `atestacion.porQueNoSeFirma` -- and in
// particular the peer's, which matters most and is easiest to loosen: this
// node does not attest to someone else's work.
async function atestacionDe({ id, node, messages, contenido, d25, finishReason }) {
  const payTo = economicPropio && economicPropio.walletAddress
  const motivo = atestacion.porQueNoSeFirma({
    node,
    walletAddress: payTo,
    tieneFirmante: !!firmarConWallet
  })
  if (motivo) return { sinAtestacion: motivo }

  const sinFirmar = atestacion.construir({
    requestId: id,
    modelId: node.modelId || null,
    // Declared, not measured. `runtime` tells apart the embedded engine from
    // a third party's API and from --demo mode's theater: a mock signed with
    // a real wallet is still a mock, and the artifact has to say so somewhere
    // visible.
    quantization: atestacion.cuantizacionDe(node.modelId),
    runtime: runtimeDe(node),
    promptHash: atestacion.hashDeMensajes(messages),
    outputHash: atestacion.hashDe(contenido),
    tokensPrefill: d25.tokensPrefill,
    tokensDecode: d25.tokensDecode,
    finishReason,
    providerPubkey: payTo
  })

  const firmada = await atestacion.firmar(sinFirmar, firmarConWallet)
  if (!firmada) return { sinAtestacion: 'the wallet could not sign the attestation' }
  return { atestacion: firmada }
}

// What it was generated with, for the attestation's `runtime` field. It's
// what this node can state firsthand, unlike `quantization`, which comes
// from the model's name and is therefore a claim about something else.
function runtimeDe(node) {
  if (!node) return 'unknown'
  if (node.kind === 'real') return 'llamacpp'
  if (node.kind === 'upstream') return 'upstream:' + node.id
  if (node.kind === 'mock') return 'mock'
  return node.kind || 'unknown'
}

// Stores an entry in the receipts Map and prunes on write -- not with a
// timer: a timer doesn't run while the process was idle, and it would keep a
// Map alive that nobody cares about.
function guardarRecibo(id, entry) {
  recibos.set(id, { ...entry, at: Date.now() })
  if (recibos.size > MAX_RECIBOS) {
    const sobran = recibos.size - MAX_RECIBOS
    let n = 0
    for (const k of recibos.keys()) {
      if (n++ >= sobran) break
      recibos.delete(k)
    }
  }
}

// PHASE 10 — a request served by A PEER. The routing gateway does NOT
// settle (it's a full handoff: whoever ran the model charges, deferred, from
// its own batch). Only the trail gets saved here, with the D24 attestation
// the peer signed and returned in `chat:done` -- verified, and tied to the
// wallet that peer charges with.
async function registrarRuteado({ id, node, ultimo }) {
  const cruda = ultimo && ultimo.attestation
  let att = null
  let motivo = (ultimo && ultimo.attestationMissing) || null

  if (cruda) {
    const v = await atestacion.verificar(cruda)
    const wPar = node && node.economic && node.economic.walletAddress
    if (!v.ok) {
      motivo = `peer's attestation did not verify: ${v.reason}`
    } else if (wPar && v.firmante.toLowerCase() !== String(wPar).toLowerCase()) {
      // The signature is valid, but it isn't from the wallet the 402
      // declared as payTo: it isn't an attestation FOR THIS charge.
      motivo = `attestation was signed by ${v.firmante}, but the peer charges to ${wPar}`
    } else {
      att = cruda
    }
  } else if (!motivo) {
    motivo = 'the peer did not attach an attestation (cutoff, or old version)'
  }

  guardarRecibo(id, {
    recibo: null,
    // The peer settles in its own batch, on its own side; this node has no
    // SettleResponse to show. `servedByPeer` tells it apart from a local,
    // unsettled receipt.
    servedByPeer: true,
    atestacion: att,
    sinAtestacion: att ? undefined : motivo
  })
  return { recibo: null, cabecera: null, atestacion: att, sinAtestacion: att ? undefined : motivo }
}

// Decides the payment path based on who served the request: a peer charges
// deferred on its own side (registrarRuteado), this node settles right away
// (liquidarYRegistrar).
async function procesarPago({ pago, id, node, ultimo, messages, contenido, d25, finAtestado }) {
  if (!pago) return null
  if (node && node.kind === 'peer') {
    return registrarRuteado({ id, node, ultimo })
  }
  return liquidarYRegistrar(
    pago,
    id,
    await atestacionDe({ id, node, messages, contenido, d25, finishReason: finAtestado })
  )
}

async function liquidarYRegistrar(pago, id, extra = null) {
  // PHASE 10 — the SCHEMA decides, not a flag. A node whose signed manifest
  // declares `settlement: 'batch-receipts'` does NOT settle per request
  // (Phase 9): the receipt accumulates in the batch and the flush settles it
  // (by size, by time, or on `close`). It's the same verified payment with
  // deferred settlement — D12's insight. `onchain-per-job` (and any other
  // mode) settles right away.
  const diferido = !!(economicPropio && economicPropio.settlement === 'batch-receipts')

  let recibo = null
  let cabecera = null
  if (diferido) {
    console.log(`[x402] ${id}: deferred settlement (batch-receipts) — to the batch, not per request`)
  } else {
    recibo = await x402.liquidar({ pago, requisito: pago.requisito })
    if (recibo.success) {
      console.log(`[x402] settled ${id}: tx ${recibo.transaction} on ${recibo.network}`)
    } else {
      // Said loudly: this node served and did not get paid.
      console.error(
        `[x402] could NOT charge ${id}: ${recibo.errorReason || ''} ${recibo.errorMessage || ''}`
      )
    }
    try {
      cabecera = await x402.cabeceraDeRecibo(recibo)
    } catch (err) {
      console.error(`[x402] could not encode the receipt: ${(err && err.message) || err}`)
    }
  }

  // D24 — the attestation gets STORED alongside the receipt, which is where
  // D12 already required building something. The two artifacts prove
  // different halves of the same exchange: the receipt, that someone paid;
  // the attestation, that this node delivered this. `deferred` tells apart
  // "didn't settle per request because this node is batch-receipts" from
  // "settled and failed."
  guardarRecibo(id, { recibo, deferred: diferido || undefined, ...(extra || {}) })

  // PHASE 10 — the receipt enters the batch IF WE served it. When the 402's
  // `payTo` is our wallet, the EIP-3009 authorization the client signed is
  // ours to settle, now or deferred. When a peer answered, payTo pointed at
  // ITS wallet (D10): that receipt is its own, travels over Protomux signed
  // by it, and that's the other half of Phase 10 -- it doesn't accumulate
  // here.
  //
  // With `onchain-per-job`, `recibo.liquidacion` stores how the immediate
  // one went and `liquidarLote` retries the ones that failed. With
  // `batch-receipts`, it enters unsettled (`liquidacion: null`) and the
  // flush charges it for the first time.
  try {
    const miWallet = economicPropio && economicPropio.walletAddress
    const paraMi =
      pago &&
      pago.requisito &&
      miWallet &&
      String(pago.requisito.payTo || '').toLowerCase() === String(miWallet).toLowerCase()
    if (paraMi) {
      lote.agregar(
        lote.construirRecibo({
          requestId: id,
          red: pago.red,
          network: pago.requisito.network,
          asset: pago.requisito.asset,
          assetName: pago.requisito.extra && pago.requisito.extra.name,
          assetVersion: pago.requisito.extra && pago.requisito.extra.version,
          payTo: pago.requisito.payTo,
          payer: pago.payer,
          amount: (pago.autorizacion && pago.autorizacion.value) || pago.requisito.amount,
          authorization: pago.autorizacion,
          signature: pago.firma,
          requirements: pago.requisito,
          atestacion: (extra && extra.atestacion) || null,
          liquidacion: diferido
            ? null
            : {
                success: !!(recibo && recibo.success),
                transaction: (recibo && recibo.transaction) || ''
              }
        })
      )
    }
  } catch (err) {
    console.error(`[lote] could not accumulate the receipt for ${id}: ${(err && err.message) || err}`)
  }

  return { recibo, cabecera, deferred: diferido || undefined, ...(extra || {}) }
}

async function handleChatConReintentos({
  req,
  res,
  node,
  candidatos,
  model,
  messages,
  stream,
  // The account the reservation is charged against. The reservation opens
  // PER ATTEMPT, not once: price depends on the node, and with retries
  // across candidates at different prices a single reservation would bound
  // the wrong one's spend.
  cuenta = null,
  maxTokensPedido = 0,
  // The machine the client pinned, if it pinned one: cuts off the retry.
  pin = null,
  // Why this candidate was chosen and not another. Goes to the routing log.
  decision = null,
  motivo = null,
  // PHASE 9 — the verified payment, if the client paid instead of bringing a key.
  pago = null,
  // PHASE 9 / D9(a) — the output cap the 402 DECLARED, in tokens.
  //
  // The same number that traveled in `accepts[].outputTokenLimit`, and it has
  // to be: declaring one and cutting off with another means charging for
  // different work than what was agreed. Zero when there was no charge -- the
  // API-key path has no cap on this side, it's bounded by budget instead.
  //
  // Passed as a scalar and not recalculated per candidate: the client SIGNED
  // against the number it was declared, and if the retry lands on another
  // candidate the deal is still that one.
  topeCobrado = 0
}) {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  const prompt = lastUserText(messages)
  const promptTokens = estimarPromptTokens(messages)

  // Headers only get written once the first token arrives, not when the peer
  // is chosen. That's what makes D4 possible: as long as nothing has been
  // sent to the client, a failure can still travel as an HTTP status and
  // another peer can be tried.
  let headersSent = false
  let contenido = ''
  const startedAt = Date.now()

  // D7 on the SERVER side. These three numbers used to be measured in the
  // browser (pages.mjs) and got lost when the tab was closed: they were demo
  // evidence that didn't survive the demo. Measured here they enter the
  // persisted trail, so afterward you can say "this peer did 40 tok/s on
  // Tuesday" without anyone having had to watch the screen at the time.
  let ttftMs = null
  let tokens = 0
  // B14 — HOW the responder finished. `null` means "nobody said," which
  // isn't the same as `stop`: with no value, normal completion gets
  // reported, which is what it used to do for EVERY response.
  let finReal = null
  // What was estimated for the CURRENT attempt. Lives outside the loop
  // because `emitUnsafe` reads it when writing headers, and inside the loop
  // the reservation is a const each time around. With retries across
  // candidates at different prices, the header has to state the one for
  // whoever actually answered.
  let costoEstimado = 0

  // PHASE 9 / D27 case 3 — the token cap the 402 declared was hit.
  //
  // A separate variable from `cancelado` because they mean opposite things
  // for billing: `cancelado` is that the client left, this is that the
  // response ended as agreed. Both cut the stream and both GET CHARGED
  // (D27), but the attestation comes out with a different `finishReason`,
  // and that's exactly what makes it useful for something.
  let cortadoPorTope = false

  const emit = (delta) => {
    // PHASE 9 / D27 — after a cutoff, anything that keeps arriving does NOT
    // get in.
    //
    // It used to keep accumulating into `contenido` even after nothing more
    // was being written: the client saw N tokens and the gateway stored
    // N+k. With D24's attestation that stops being an accounting detail —
    // D27 requires that the partial's hash be the one for the prefix the
    // client ACTUALLY received, because otherwise there's nothing to verify
    // it against.
    if (cancelado || cortadoPorTope) return

    // The first delta with content is the first token, not the opening
    // chunk: that one only carries {role} and would arrive earlier,
    // measuring short.
    if (ttftMs === null) ttftMs = Date.now() - startedAt
    tokens++
    contenido += delta

    // PHASE 9 / D9(a) — the cap the 402 declared, enforced.
    //
    // This was MISSING: `topeDeSalidaCobrado` built `accepts[]`'s
    // `outputTokenLimit` and then nobody enforced it -- the generation path
    // used `topeDeSalida`, which for a peer, the local engine, and a mock
    // returns whatever the client asked for, i.e. zero, i.e. no cap. The 402
    // charged a fixed price declaring "up to N tokens" and generated with no
    // limit.
    //
    // D9 calls this non-negotiable on the `finish_reason` side: if it gets
    // cut off by the cap, it has to say `length`, not `stop`. Marked here
    // and reported by `finishReasonDe` further down.
    if (topeCobrado > 0 && estimarTokensDeSalida(contenido) >= topeCobrado) {
      cortadoPorTope = true
      finReal = 'length'
      // Cut off on both sides: to the peer over its own channel, to the
      // local engine and the external one via the signal. Not a failure --
      // `streamFromPeer` resolves ok:true if it had already started, and
      // `streamFromLocal`'s `for await` exits through the break and returns
      // ok:true just the same.
      if (requestIdEnVuelo) swarmRef.cancelChat(requestIdEnVuelo)
      cancelacion.abort()
    }

    if (!stream) return
    // Writing to a response the client already closed can throw. This
    // function is called by the swarm's FramedStream handler, so an
    // exception escaping from here bubbles up to the pipe's 'data' handler
    // and takes down the channel with that peer -- for ALL requests, not
    // just this one.
    try {
      emitUnsafe(delta)
    } catch (err) {
      cancelado = true
      if (requestIdEnVuelo) swarmRef.cancelChat(requestIdEnVuelo)
      console.log(`[gateway] could not write to the client: ${(err && err.message) || err}`)
    }
  }

  const emitUnsafe = (delta) => {
    if (!headersSent) {
      res.writeHead(200, {
        // `elegido`, not `node`: with retries, whoever answers may not be
        // whoever was chosen first, and the header names WHO ANSWERED. It
        // used to say the first attempt's, i.e. it lied in the one case
        // where the data matters.
        ...provenanceHeaders(elegido || node, costoEstimado),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const open = chunkEvent({ id, created, model, delta: { role: 'assistant' } })
      res.write(`data: ${JSON.stringify(open)}\n\n`)
      headersSent = true
    }
    const ev = chunkEvent({ id, created, model, delta: { content: delta } })
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  // The client closed the tab: the peer has to be told. Without this the
  // peer keeps generating for nobody and its slot stays occupied for
  // free -- in a marketplace that's CPU someone is paying for.
  let cancelado = false
  let terminado = false
  let requestIdEnVuelo = null

  // B3 -- the client left and the spend has to leave with it. On the peer's
  // side a chat:cancel gets sent; on the local and external side, this
  // signal is what cuts the `for await` and aborts the fetch to the
  // provider. Whatever keeps running after the client closed the tab is
  // dollars out of the operator's account.
  const cancelacion = new AbortController()
  const onClientGone = () => {
    // After finishing, the response's 'close' is the normal shutdown:
    // aborting there would fire an error over a request that went out fine.
    if (terminado) return
    cancelado = true
    if (requestIdEnVuelo) swarmRef.cancelChat(requestIdEnVuelo)
    cancelacion.abort()
  }
  req.on('close', onClientGone)
  res.on('close', onClientGone)

  const intentos = []
  let elegido = null
  let ultimo = null
  let usoExterno = null
  let costoTotal = 0
  // The candidate that got skipped for lack of balance, if another one
  // answered afterward. It's a MONEY decision and the trail has to be able
  // to tell it apart from a normal choice: without this, "chose local" and
  // "wanted the external one and couldn't afford it" look identical in the
  // panel.
  let degradado = null
  // The last rejected reservation. If NO candidate got to be tried for lack
  // of balance, this is what turns the failure into a 402 with real numbers
  // instead of a generic 502.
  let sinSaldo = null

  for (const cand of candidatos) {
    if (cancelado) break

    // A peer with no agent launched can't be tried -- but it does NOT cut
    // the list short: this machine's model can be further down, and before,
    // that case returned 503 without even looking at it.
    if (cand.kind === 'peer' && !swarmRef) {
      ultimo = {
        ok: false,
        code: 'agent_offline',
        message:
          'your node is offline, so the network is out of reach — launch your local agent to use it.'
      }
      intentos.push({ nodeId: cand.id, operator: cand.operator, ok: false, code: 'agent_offline' })
      continue
    }

    // PHASE 6.5 — the reservation happens PER ATTEMPT: after knowing who
    // it's about to be asked of (price depends on the node) and before
    // asking. A cap evaluated after the spend is a discount.
    const tope = topeDeSalida(cand, maxTokensPedido)
    const estimado = estimarRequest({ node: cand, maxTokens: tope, promptTokens })
    costoEstimado = estimado
    const reserva = budget.reserve(cuenta, estimado)
    if (!reserva.ok) {
      // Not enough for THIS candidate. Not the end of the road: the next
      // one might be free, and answering with the local engine is better
      // than refusing service. This is Phase 8.5's DoD degradation, now as
      // one more step in the walk instead of a special case.
      sinSaldo = reserva
      if (!degradado) {
        degradado = {
          de: cand.id,
          motivo:
            `${reserva.scope === 'nodo' ? 'presupuesto del nodo agotado' : 'presupuesto agotado'}: ` +
            `quedan ${costs.formatUSD(reserva.remaining)} de un tope de ${costs.formatUSD(reserva.cap)}`
        }
      }
      intentos.push({
        nodeId: cand.id,
        operator: cand.operator,
        ok: false,
        code: 'budget_exhausted'
      })
      continue
    }

    // What a failed attempt generated doesn't count toward the next one.
    // Without this, on the non-stream path -- where content gets joined and
    // sent at the end -- the response from whoever answered would come out
    // stuck to the chunk from whoever fell over, and the client would read
    // both halves as one.
    if (!headersSent) {
      contenido = ''
      tokens = 0
      ttftMs = null
      finReal = null
    }

    elegido = cand
    usoExterno = null
    let saturado = false
    store.beginRequest(cand.id)
    try {
      const r =
        cand.kind === 'peer'
          ? await streamFromPeer({
              node: cand,
              model,
              messages,
              onStart: (rid) => {
                requestIdEnVuelo = rid
                // The client left WHILE the request was being built: cancel
                // right away, without waiting for the peer to start
                // generating.
                if (cancelado) swarmRef.cancelChat(rid)
              },
              onChunk: emit,
              // D27 — the same signal that cuts off the local engine and the
              // external one. Without this, a cutoff from the client or the
              // cap left the peer generating until the idle-timeout clock
              // fired, and the request ended as if the peer had failed.
              signal: cancelacion.signal,
              // PHASE 10 — the payment gets forwarded (the peer charges it)
              // and the cap (it cuts off at the same point it attests).
              pago,
              tope
            })
          : await streamFromLocal({
              node: cand,
              messages,
              prompt,
              maxSalida: tope,
              signal: cancelacion.signal,
              onChunk: emit,
              onUsage: (u) => {
                usoExterno = u
              },
              onFinish: (f) => {
                finReal = f
              }
            })
      requestIdEnVuelo = null
      ultimo = r
      intentos.push({ nodeId: cand.id, operator: cand.operator, ok: r.ok, code: r.code || null })

      if (r.ok) break

      // D4: if even a single token has already been sent TO THE CLIENT,
      // there's no retrying. The context of a half-done response can't be
      // picked back up on another node.
      //
      // The condition is `headersSent` and not `r.started`, and the
      // difference is real: `started` says the PROVIDER started generating,
      // but on the non-stream path content gets joined and doesn't go out
      // until the end, so the client still hasn't seen anything and the
      // retry is still legitimate. Cutting off on `started` would give up on
      // retrying exactly when there was no reason not to.
      if (headersSent) break

      // Said it's full. From a peer that's fresher information than the last
      // `node:status`, which can be up to 2s stale (swarm.mjs:48); from an
      // upstream it's a 429, i.e. the provider's quota is exhausted. In both
      // cases choosing it again in the next few seconds just eats the same
      // rejection. S5 of NOTES-SATURACION.md.
      //
      // NOTED here and applied in the finally, AFTER endRequest. The other
      // way around -- which is how it used to be -- the outgoing endRequest
      // would knock down by one the counter markSaturated had just filled,
      // and the node ended up with exactly one free slot: i.e. not
      // saturated, i.e. eligible again for the next request. The mark
      // protected against nothing.
      if (r.code === 'at_capacity') saturado = true

      // With the machine pinned by the client there's no one else to retry:
      // asking for a specific node and getting another one's response is
      // exactly what the pin exists to prevent.
      if (pin) break

      console.log(
        `[gateway] ${cand.operator} failed before the first token (${r.code}), trying another one`
      )
    } finally {
      store.endRequest(cand.id)
      if (saturado) store.markSaturated(cand.id)
      // THIS attempt gets settled before moving to the next one. A
      // reservation that doesn't get settled stays committing balance until
      // the process restarts, and with retries there would be one per
      // candidate tried.
      const costo = costoDelIntento({ node: cand, usoExterno, tokens, reserva })
      budget.settle(reserva.id, costo)
      costoTotal += costo
    }
  }

  // PHASE 9 / D25 — the two dimensions, calculated once: read by D24's
  // attestation and the final trail, and they have to be the same number.
  const d25 = tokensD25({ usoExterno, tokens, promptTokens })

  // PHASE 9 / D27 — WHO CUT IT OFF decides, and decides two different things:
  // whether it gets charged and what the attestation says. The three cases,
  // in the order they get told apart:
  //
  //   1. the client closed the tab  -> PARTIAL attestation over the prefix
  //      it actually received, and it DOES get charged up to there;
  //   2. the provider went down     -> NO attestation and NO charge. Falls
  //      out on its own: without `ultimo.ok` this block is never entered
  //      and nothing ever settles;
  //   3. D9's cap got hit           -> full attestation, `length`, gets charged.
  //
  // Case 2 doesn't show up as a branch because it can't: it's the absence of
  // the other two. Reading it that way is deliberate -- a "don't charge"
  // case that depended on a written condition would be a case someone could
  // accidentally delete.
  const finAtestado = cortadoPorTope
    ? 'length'
    : cancelado
      ? 'client_cancelled'
      : finishReasonDe(finReal)

  try {
    if (ultimo && ultimo.ok) {
      // B14 — the empty-200 guard goes BEFORE the two paths split.
      //
      // It used to only be on the stream side, with the non-stream `return`
      // ahead of it: whoever asked without `stream: true` -- a curl, Open
      // WebUI, any OpenAI SDK's default -- got a 200 with `content: ""` and
      // `finish_reason: "stop"`. I.e. exactly what the comment below said
      // shouldn't be returned, in half the cases.
      if (!headersSent && contenido === '') {
        return sendError(res, 502, 'the peer ended the request without returning a single token', {
          type: 'server_error',
          code: 'empty_response'
        })
      }

      if (!stream) {
        // D12 — on the path WITHOUT streaming there's no problem: the
        // response gets built whole before a single byte is written, so it
        // settles HERE and the receipt travels in `X-PAYMENT-RESPONSE` as
        // the spec requires, with no deviation.
        //
        // PHASE 10 — except when a peer served it: there the gateway does
        // NOT settle and there's no `X-PAYMENT-RESPONSE` (the peer charges
        // it, deferred). The trail still ends up in `/v1/receipts/:id`.
        const recibo = await procesarPago({
          pago,
          id,
          node: elegido,
          ultimo,
          messages,
          contenido,
          d25,
          finAtestado
        })

        // The same provenance headers as the streaming path. Without this,
        // whoever asks without `stream:true` -- a curl, Open WebUI, any
        // OpenAI client on the default -- never finds out which machine
        // answered. The guarantee can't hold for one of the two response
        // shapes and not the other.
        return sendJson(
          res,
          200,
          {
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: contenido },
                finish_reason: finishReasonDe(finReal)
              }
            ]
          },
          {
            ...provenanceHeaders(elegido || node, costoEstimado),
            ...(recibo && recibo.cabecera ? { 'X-PAYMENT-RESPONSE': recibo.cabecera } : {})
          }
        )
      }

      // D12 — with streaming the headers already went out BEFORE the first
      // token, so the receipt can't travel in one. It goes as a FINAL SSE
      // EVENT, and that's the spec deviation D12 accepts in exchange for not
      // putting an on-chain transaction in front of TTFT.
      //
      // D12's condition is that the deviation can be discovered from the
      // response itself: a standard x402 client that looks for the header
      // and doesn't find it has to be able to find out WHY. Hence `x402Note`
      // and `receiptUrl`, which aren't part of the spec and are there on
      // purpose.
      if (pago) {
        // PHASE 10 — if a peer served it, `procesarPago` does NOT settle: it
        // saves the trail with the peer's attestation and returns
        // `recibo: null`. The SSE event below reflects that
        // (`paymentResponse: null`) and the x402 client finds out via
        // `x402Note` that settlement belongs to the peer.
        const recibo = await procesarPago({
          pago,
          id,
          node: elegido,
          ultimo,
          messages,
          contenido,
          d25,
          finAtestado
        })
        // The client may have left: D27 case 1 says it still settles and
        // gets attested -- the work was done and the prefix arrived --, but
        // writing to a closed socket throws, and that exception would take
        // down the finally's orderly `res.end()`. Settlement already
        // happened above: all that's lost is the notice, and it's still in
        // /v1/receipts.
        if (!cancelado) {
          try {
            res.write(
              `data: ${JSON.stringify({
                x402Version: 2,
                x402Note: recibo.servedByPeer
                  ? 'This was served by a peer and settlement is ITS OWN: it accumulates ' +
                    'this payment in its batch and settles it in batch (Phase 10). There is no ' +
                    'X-PAYMENT-RESPONSE because this gateway does not charge for work another ' +
                    'node served. The attestation the peer signed is below; the payment can be ' +
                    'recovered via receiptUrl.'
                  : recibo.deferred
                    ? 'This node declares batch-receipts settlement: the payment accumulates in ' +
                      'its batch and settles DEFERRED (by size, by time, or on shutdown), not ' +
                      'per request. That is why there is no X-PAYMENT-RESPONSE or tx yet. See D12 ' +
                      'and Phase 10. The payment can be recovered via receiptUrl.'
                    : 'The receipt travels as a final SSE event and not in X-PAYMENT-RESPONSE: ' +
                      'in streaming the headers go out before the first token, so settling in ' +
                      'order to write it would put an on-chain transaction in front of TTFT. ' +
                      'See D12 in the roadmap. It can also be recovered via receiptUrl.',
                paymentResponse: recibo.recibo || null,
                settledBy: recibo.servedByPeer
                  ? 'peer-batch'
                  : recibo.deferred
                    ? 'batch'
                    : 'gateway',
                // D24 — the attestation travels with the receipt, or the
                // reason there isn't one. An absence with a reason is data;
                // a silent absence is a hole someone will read as "not
                // needed."
                attestation: recibo.atestacion || null,
                attestationMissing: recibo.sinAtestacion || undefined,
                receiptUrl: `/v1/receipts/${id}`
              })}

`
            )
          } catch (err) {
            console.log(`[gateway] could not write the receipt: ${(err && err.message) || err}`)
          }
        }
      }

      const close = chunkEvent({
        id,
        created,
        model,
        delta: {},
        finishReason: finishReasonDe(finReal)
      })
      res.write(`data: ${JSON.stringify(close)}\n\n`)
      res.write('data: [DONE]\n\n')
      return
    }

    // No candidate could do it. If nothing has been written yet, the failure
    // travels as an HTTP status carrying the last attempt's reason.
    //
    // The 402 comes first: running out of balance isn't a provider failure,
    // it's this node's own decision, and it deserves its own status and its
    // own numbers.
    if (!elegido && sinSaldo) {
      return sendError(
        res,
        402,
        // B13 — states WHICH of the two caps ran out. "You can't afford it"
        // without saying which cap was hit isn't actionable: lowering a
        // key's cap doesn't fix a node with no balance, and neither does the
        // reverse.
        `${sinSaldo.scope === 'nodo' ? 'presupuesto del nodo agotado' : 'presupuesto agotado'}: ` +
          `quedan ${costs.formatUSD(sinSaldo.remaining)} de un tope de ${costs.formatUSD(sinSaldo.cap)}`,
        { type: 'insufficient_quota', code: 'budget_exhausted' }
      )
    }

    const motivo = ultimo ? ultimo.message : 'no node is serving that model'
    const code = ultimo ? ultimo.code : 'no_peer'

    if (!headersSent) {
      // The product's gate: with no agent launched the network can't be
      // reached, and the message has to say the next step instead of just
      // refusing.
      if (code === 'agent_offline') {
        return sendError(
          res,
          503,
          'your node is offline, so the network is out of reach — launch your local agent to use it. Your own local model still answers.',
          { type: 'service_unavailable', code }
        )
      }
      // 502 when it was ANOTHER machine that failed -- a peer or a third
      // party's API --: the error isn't this gateway's, and a 500 would send
      // someone to check the wrong side. It's the same distinction any
      // proxy makes.
      const status = elegido && !esTercero(elegido) && elegido.kind !== 'peer' ? 500 : 502
      const prefijo = elegido && elegido.kind === 'peer' ? 'the remote peer could not respond: ' : ''
      return sendError(res, status, `${prefijo}${motivo}`, {
        type: 'server_error',
        code
      })
    }
    const payload = JSON.stringify({ error: { message: motivo, type: 'server_error', code } })
    res.write(`data: ${payload}\n\n`)
    res.write('data: [DONE]\n\n')
  } finally {
    if (headersSent || !stream) res.end()
    else if (!res.writableEnded) res.end()

    terminado = true
    const ms = Date.now() - startedAt
    const ok = !!(ultimo && ultimo.ok)

    // Already settled per attempt inside the loop; here only the total gets
    // reported. Settling again would charge the same request twice.
    const costoReal = costoTotal

    store.pushLog({
      modelId: model,
      // Where the tokens came from. 'local' is this machine -- with the
      // embedded engine or with an engine of our own behind HTTP --; 'peer'
      // is another machine on the network; 'upstream' is a third party's
      // API; 'mock' is --demo mode's theater. Telling them apart matters:
      // without this field, a --demo run produces a trail with made-up
      // tok/s that can't be told apart from a real one, and a local upstream
      // would inflate the external-consumption panel with requests that
      // never left the machine.
      target: targetDe(elegido),
      costMicros: costoReal,
      nodeId: elegido ? elegido.id : null,
      operator: elegido ? elegido.operator : null,
      candidatos: candidatos.length,
      reason: degradado
        ? `${degradado.motivo} — se degrado de ${degradado.de} a otro candidato`
        : `${intentos.length > 1 ? `${intentos.length} de ${candidatos.length} candidatos intentados — ` : ''}` +
          `${motivo || `${candidatos.length} candidato(s) para "${model}"`}`,
      // The trail has to be able to tell "chose local" apart from "wanted
      // the external one and couldn't afford it." Without this the two
      // entries look the same, and degradation -- which is a money
      // decision -- goes unaudited.
      degradado: degradado || undefined,
      // WHY this one was chosen and not another: the chosen one's load and
      // the load of the ones left behind. Phase 8's DoD -- the log used to
      // only be able to say "the first one," which isn't a reason.
      decision: decision || undefined,
      intentos: intentos.length > 1 ? intentos : undefined,
      ok,
      code: ok ? null : (ultimo && ultimo.code) || (sinSaldo ? 'budget_exhausted' : 'no_peer'),
      tokens,
      ttftMs,
      tokensPerSec: tokensPerSec({ tokens, ttftMs, ms }),
      ms,
      // PHASE 9 / D25 — the NEW fields. `tokens`, `ttftMs`, and `ms` stay as
      // they were: the panel and the historical trail are reading them, and
      // changing their meaning would turn old entries into something else
      // without warning.
      //
      // Prefill processes the prompt in parallel and is bound by compute;
      // decode generates token by token and is bound by memory bandwidth. A
      // single rate mixes two costs that don't scale the same way. D22 still
      // does NOT get touched: recording is cheap and it's the only way to
      // later have something to inform that decision with -- changing the
      // price today would mean deciding it with no data.
      tokensPrefill: d25.tokensPrefill,
      tokensDecode: d25.tokensDecode,
      tokensFuente: d25.tokensFuente,
      // D27 — how it finished, in the attestation's vocabulary and not
      // OpenAI's. Without this, in the trail a client cutoff and a complete
      // response look identical, which is exactly the most frequent case in
      // real use and where a provider has the most room to claim tokens
      // nobody received.
      finishReason: finAtestado
    })

    // Per-peer counters in the directory. The function had existed since
    // `directory.recordStat` was written and NOBODY was calling it: every
    // peer's stats stayed at zero forever, and the panel showed an empty
    // history that looked like a freshly-met peer. Counts the peer that
    // actually served the request -or the last one that tried, if all of
    // them failed-.
    if (elegido && elegido.peerKey) {
      store.recordPeerResult(elegido.peerKey, { ok, ms, tokens })
    }
  }
}

// The text that feeds the mock nodes: the user's last turn. The real node
// does NOT use this, it receives the whole `messages` as `history` and keeps
// the conversation's context.
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages[messages.length - 1].content
}

// OPTIONAL API key validation, and this asymmetry is deliberate:
//
//   - no Authorization header  -> passes. The panel is served from the same
//     origin and doesn't handle a credential; requiring one would mean
//     asking for a key to a house you're already inside. It also keeps any
//     old curl from the runbook working.
//   - with Authorization header  -> has to be a key issued by
//     /v1/connection. A mistyped key fails with 401 instead of answering
//     anyway, which is the only thing that makes the credential mean
//     anything.
//
// THIS IS NOT AUTHENTICATION: with no header there's no gate. This is what's
// appropriate for a demo where the gateway listens on localhost, and it's
// written here so nobody mistakes it for real security when reading the code
// later.
// The gate. It used to return null when there was NO header -- i.e. anyone
// who reached the port could spend your GPU without presenting anything, and
// the key only served to identify whoever bothered to send it.
//
// Now a missing credential is a rejection. The panel isn't exempt either: it
// requests its own from /v1/keys/panel and sends it like any other client,
// so there's ONE single authentication path and not a back door for the
// browser.
function rechazoPorKey(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header || typeof header !== 'string') {
    return 'missing api key: send the "Authorization: Bearer <api-key>" header'
  }
  if (!header.startsWith('Bearer '))
    return 'the Authorization header has to be "Bearer <api-key>"'
  const key = header.slice(7).trim()
  if (!key) return 'missing api key after "Bearer"'
  return apikeys.verifyKey(key) ? null : 'unknown or revoked api key'
}

// Which credential came in with the request, so consumption can be
// attributed to it. Called AFTER rechazoPorKey, so by this point it's
// already known to exist.
function keyLabelDe(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header || !header.startsWith('Bearer ')) return null
  const entry = apikeys.verifyKey(header.slice(7).trim())
  return entry ? entry.label : null
}

// WHICH ACCOUNT consumption gets attributed to (Phase 6.5). It's the API
// key's id, not its text: the id is stable and can be written to a file
// without the ledger ending up storing credentials in the clear.
//
// The account IS the key. There's no separate user model because it isn't
// needed yet: every external client -- a Telegram bot, a terminal, the
// panel -- already has its own, and that's exactly the granularity spend is
// meant to be cut at.
function cuentaDe(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header || !header.startsWith('Bearer ')) return null
  const entry = apikeys.verifyKey(header.slice(7).trim())
  return entry ? entry.id : null
}

// The UPPER BOUND of what this request is going to cost, in micro-dollars.
//
// Today it returns zero for everything, and that's not a placeholder: it's
// the real price. Local inference doesn't cost dollars and neither does a
// peer's -- P2P payment is Phase 9, in USD₮ and against the provider's
// wallet, not against this cap. The only thing that costs dollars is the
// external assistant, which is Phase 8.5.
//
// The function exists anyway, and the gateway calls it on the common path,
// so the reservation and settlement stay EXERCISED before there's any real
// money involved. A cutoff mechanism that gets its first run the day it
// starts charging is an untested cutoff mechanism.
// Which key the price gets asked from costs.mjs with.
//
// For an upstream it's the ROW'S ID, not the modelId, and the difference
// isn't cosmetic: two nodes can serve the same model at different prices --
// a network peer serving llama1b for free and a third party's API charging
// for the same name. Indexed by modelId, the external one's price would also
// get charged to the peer, which charges nothing. The price belongs to
// WHOEVER answers.
function claveDePrecio(node) {
  if (!node) return null
  return node.kind === 'upstream' ? node.id : node.modelId
}

// PHASE 9 — the floor of an x402 charge, in micro-dollars.
//
// P2P inference is worth ZERO to the ledger, and that's correct: that
// counter measures dollars this node pays a third party, and a peer doesn't
// get paid in dollars. But a 402 that asks for zero isn't a charge. This is
// the number that turns "costs me nothing" into "this is what it comes to,"
// and it's a business call: USD 0.001, the amount the roadmap says to start
// with (risk #2).
const PRECIO_MINIMO_MICROS = 1000

function estimarRequest({ node, maxTokens = 0, promptTokens = 0 }) {
  const clave = claveDePrecio(node)
  if (!clave || !costs.conocido(clave)) return 0
  return costs.estimar({ model: clave, promptTokens, maxTokens })
}

// PHASE 9 / D10 — a specific candidate's 402.
//
// Returns the challenge's body, or null if this candidate can't be charged
// for. Null is NOT an error: a peer that declares no wallet, or a node with
// no usable network, are legitimate states -- and the caller has to be able
// to tell them apart from "payment required" so it doesn't answer 402
// without saying who to pay.
//
// `payTo` comes from the candidate's SIGNED manifest (store.mjs saves it
// when verifying it), or from our own wallet if this node is the one about
// to answer. Never from a constant: D10 decides the provider gets paid
// DIRECTLY, and if the gateway put in its own address it would be the
// middleman the README promises doesn't exist.
async function cobroDe({ node, maxTokensPedido, req }) {
  if (!node) return null

  const propio = node.kind !== 'peer'
  const payTo = propio
    ? economicPropio && economicPropio.walletAddress
    : node.economic && node.economic.walletAddress
  if (!payTo) return null

  // The output cap that's going to be enforced, which is the number that
  // makes D9(a)'s fixed price honest: "up to N tokens for $X." The SAME one
  // the gateway later enforces gets declared here.
  const maxTokens = topeDeSalidaCobrado(node, maxTokensPedido)

  // What it would cost to serve. For the P2P and local path this returns
  // zero today -- the ledger's price is zero because P2P payment is exactly
  // this phase --, so a declared minimum gets charged instead of zero: a
  // 402 that asks for zero isn't a charge, and giving it away isn't what the
  // node agreed to either by declaring a wallet.
  const estimado = estimarRequest({ node, maxTokens, promptTokens: 0 })
  const micros = Math.max(estimado, PRECIO_MINIMO_MICROS)

  const proto = 'http'
  const host = req.headers.host || 'localhost'
  try {
    const desafio = await x402.desafio({
      payTo,
      micros,
      maxTokens,
      recurso: `${proto}://${host}/v1/chat/completions`,
      descripcion: `Inferencia de ${node.modelId} en ${node.operator}, hasta ${maxTokens} tokens de salida`
    })
    if (!desafio) return null
    // Everything it took to build it gets returned, because verification has
    // to use exactly the same numbers. Recalculating them on the other side
    // is the easiest way to reject a correct payment.
    return { desafio, payTo, micros, maxTokens }
  } catch (err) {
    // A badly built 402 is worse than none: the client would sign an
    // authorization against the wrong data. Logged, and falls back to 401.
    console.error(`[x402] could not build the 402: ${(err && err.message) || err}`)
    return null
  }
}

// Verifies the X-PAYMENT against the charge that was offered.
//
// The client picks ONE of the networks in `accepts[]`, so it's checked
// against whichever the payment says. If it doesn't say any, it's checked
// against the first one offered, which is D15's preferred one.
async function verificarCobro(cobro, cabecera) {
  let red = null
  try {
    const sobre = JSON.parse(Buffer.from(String(cabecera), 'base64').toString('utf8'))
    const elegida = cobro.desafio.accepts.find((a) => a.network === sobre.network)
    red = elegida ? redDe(elegida.network) : null
  } catch {
    // An unreadable header gets rejected by `verificarPago` with its own reason.
  }
  if (!red) red = redDe(cobro.desafio.accepts[0].network)

  return x402.verificarPago(cabecera, {
    payTo: cobro.payTo,
    activo: await x402.activoDe(red),
    micros: cobro.micros,
    red
  })
}

// The EXACT requirement that was signed against, which is what settlement
// has to happen against. Recalculating it would mean settling against
// different numbers than the ones the client accepted.
function requisitoDe(cobro, red) {
  const id = x402.CAIP2[red]
  return cobro.desafio.accepts.find((a) => a.network === id) || cobro.desafio.accepts[0]
}

function redDe(caip2) {
  for (const [nombre, id] of Object.entries(x402.CAIP2)) if (id === caip2) return nombre
  return null
}

async function handleChat(req, res) {
  // PHASE 9 / D16 — THREE access paths that don't step on each other:
  //
  //   local: true                 free, no network, no payment. The
  //                               README's exception holds.
  //   Authorization: Bearer …     the key issued by the panel. The path for
  //                               a human who already set up a bot.
  //   neither key nor payment     402.
  //
  // 402 as the DEFAULT FOR STRANGERS is the whole phase: it's what lets an
  // agent consume without registering anything. And it doesn't replace
  // keys -- it coexists with them, which is what D16 decides.
  //
  // Rejection for a missing key can no longer be a plain 401: if this node
  // can charge, whoever brings no credential isn't badly authenticated,
  // they're unpaid, and those are two different responses. Decided AFTER
  // choosing a candidate, because the 402 has to say how much and to whom,
  // and both depend on who's about to answer.
  const sinCredencial = rechazoPorKey(req)

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendError(res, 400, 'invalid body, expected JSON')
  }

  const norm = normalizeRequest(body)
  if (norm.error) return sendError(res, 400, norm.error)

  const { model, messages, stream, local, pin } = norm

  // With swarm peers there can be TWO nodes serving the same modelId,
  // something that didn't happen with the simulated registry. All of them
  // get pulled so how many there were can be logged. Choosing between them
  // is NO LONGER taking the first one: pickCandidate decides by load (D6,
  // closed in Phase 8) and the reason stays in the log, so the decision gets
  // audited instead of guessed at.
  let candidatos = store.findAllByModelId(model)

  // "local only": the prompt doesn't leave this machine. Filtered BEFORE
  // choosing -- if the only candidate was remote, the 404 below has to say
  // there's nobody local, and not route to the network anyway.
  //
  // An upstream falls under the same filter as a peer, and that line is
  // literal in Phase 8.5's DoD: `local: true` never leaves the machine, opt-in
  // or not. A third party on the other end of an API is no less "outside"
  // than a network peer -- it's more so, because it also keeps logs.
  // Counted BEFORE any filter: if `local` removes them, the error further
  // down has to be able to say there was one and why it wasn't used.
  const externos = candidatos.filter(esTercero)

  // A LOCAL upstream survives this filter, and it has to: the request says
  // "don't let it leave this machine," and a llama-server on localhost
  // doesn't. Filtering it out would leave the one case where the lock and
  // the capacity aren't in conflict with no answer.
  if (local) candidatos = candidatos.filter((n) => n.kind !== 'peer' && !esTercero(n))

  // D19 — the external's other two conditions. Applied as a candidate
  // FILTER and not as an `if` in dispatch: an ineligible upstream has to be
  // invisible to pickCandidate, or it would end up winning on load (always
  // 0) and only get rejected right after.
  let vetoExterno = null
  if (externos.length > 0) {
    // Only the HARD rules filter. "There's local capacity" isn't here
    // anymore: it became a position in the list, further down, because a
    // candidate's declared capacity doesn't prove that candidate works.
    if (local) {
      vetoExterno = {
        code: 'local_only',
        message: 'the request asks that nothing leave this machine'
      }
    } else if (!upstreamOptIn) {
      vetoExterno = {
        code: 'upstream_opt_in_required',
        message:
          'there is an external assistant configured, but sending the prompt to a third party is off. ' +
          'Turn it on with POST /v1/upstream/opt-in or with "optIn": true in upstreams.json.'
      }
    }
    // The opt-in and the `local: true` lock are HARD rules: they take the
    // external one out of the list for good. D19's third condition -- "no
    // local capacity" -- can't be one, and that's the difference that showed
    // up while testing it with a local engine that was down:
    //
    //   a candidate's DECLARED capacity doesn't say that candidate works. A
    //   llama-server that isn't up announces 0/2 -- i.e. "I have room" --,
    //   the external one got vetoed because of that, the local one failed,
    //   and there was nowhere to fall back to. The fallback only existed on
    //   paper.
    //
    // So the external one stops getting filtered out and moves to the END of
    // the list instead. With the candidate walk, ending up last IS the
    // condition: it gets tried once the home ones couldn't, measured by what
    // actually happened and not by what they announced. And as long as one
    // from home answers, the prompt doesn't go out.
    if (vetoExterno) candidatos = candidatos.filter((n) => !esTercero(n))
  }

  // Every candidate there was happened to be external and got vetoed. The
  // generic 404 further down would say "no nodes serving that model," which
  // is false: there is one, and it wasn't used because of a decision. Saying
  // what that decision is is the only actionable thing for whoever gets the
  // error.
  if (candidatos.length === 0 && externos.length > 0 && vetoExterno) {
    const detalle =
      vetoExterno.code === 'local_only'
        ? `"${model}" solo lo sirve un asistente externo, y ${vetoExterno.message}`
        : vetoExterno.message
    return sendError(res, 503, detalle, {
      type: 'service_unavailable',
      code: vetoExterno.code
    })
  }

  // PHASE 8 — price enters routing.
  //
  // `pickCandidate` gets passed a function already BOUND TO THIS REQUEST: a
  // candidate's cost isn't a property of the candidate, it depends on the
  // prompt and the output cap. A long prompt against an expensive model and
  // the same prompt against a free one don't get compared by a rate, they get
  // compared by the number it's actually going to cost this person for THIS
  // question.
  //
  // It's exactly `estimarRequest`, the same function the budget reservation
  // gets opened with a few lines down. Being the SAME one matters: routing by
  // one number and charging by another would mean choosing with information
  // that isn't what later gets deducted.
  const promptTokensDelRuteo = estimarPromptTokens(messages)
  const eleccion = pickCandidate(candidatos, {
    statsFor: store.statsFor,
    precioDe: (cand) =>
      estimarRequest({
        node: cand,
        maxTokens: topeDeSalida(cand, norm.maxTokens || 0),
        promptTokens: promptTokensDelRuteo
      }),
    pin
  })

  // The client pinned a machine that's no longer among the candidates. It
  // does NOT route to another one: whoever picks a machine wants that one,
  // and answering with another one without saying so would empty the
  // feature of its point. The 404 says which one it asked for.
  if (pin && !eleccion.node) {
    return sendError(res, 404, eleccion.reason, { code: 'node_not_found' })
  }

  // The BEST candidate, not the only one: whoever walks the list is
  // handleChatConReintentos. Only used here for the errors further down,
  // which talk about the one chosen first.
  const node = eleccion.node

  // PHASE 9 — payment, only here, because before neither how much nor to
  // whom was known.
  let pagoVerificado = null
  // D9(a) — the cap DECLARED in the 402, so it can be ENFORCED afterward.
  // Zero as long as there's no charge: the API-key path is bounded by
  // budget instead.
  let topeDeclarado = 0
  if (sinCredencial) {
    const cobro = await cobroDe({ node, maxTokensPedido: norm.maxTokens || 0, req })

    // This node can't charge -- no wallet, or no usable network -- so the
    // only path left is the usual one: the key.
    if (!cobro) return sendError(res, 401, sinCredencial)

    const cabecera = req.headers['x-payment'] || req.headers['X-PAYMENT']
    if (!cabecera) {
      // 402, not 401: it isn't missing a credential, it's missing payment.
      // Two different fixes on the client's side and they deserve two
      // different responses.
      return sendJson(res, 402, cobro.desafio, provenanceHeaders(node, 0))
    }

    // D12 — verification is SYNCHRONOUS and doesn't touch the chain. It's
    // the part that protects the provider from spending GPU for free, and it
    // happens BEFORE generating a single token: afterward would be too
    // late, which is the whole point.
    const verificado = await verificarCobro(cobro, cabecera)
    if (!verificado.ok) {
      // Answers 402 again, with the challenge, and not 400: the client can
      // sign again. A 400 would say "your request is wrong" when what's
      // wrong is the payment, and it wouldn't give it anything to sign
      // against again.
      console.error(`[x402] payment rejected: ${verificado.motivo}`)
      return sendJson(
        res,
        402,
        { ...cobro.desafio, error: verificado.motivo },
        provenanceHeaders(node, 0)
      )
    }
    console.log(
      `[x402] payment verified from ${verificado.payer.slice(0, 10)}… for ${cobro.micros} micros`
    )
    pagoVerificado = { ...verificado, requisito: requisitoDe(cobro, verificado.red) }
    // The SAME number that traveled in `accepts[]`, not a recalculated one.
    // D9 says it plainly: it's declared before generating and enforced
    // afterward, and they have to be the same. Until now it was declared and
    // not enforced.
    topeDeclarado = cobro.maxTokens
  }
  // The scored order, not arrival order: if the best one fails before the
  // first token, D4 retries on the second BEST, not the next one in the
  // list.
  //
  // With one caveat: third parties go to the back, no matter how low their
  // load is (it's always low: it's an API that isn't ours). D19's third
  // condition applied as POSITION instead of a filter -- see the note
  // above --, and `partition` keeps it stable, so among themselves they keep
  // the load order pickCandidate gave them.
  const orden = eleccion.orden
  const propios = orden.filter((n) => !esTercero(n))
  // D19's third condition: as long as someone from home can serve RIGHT NOW,
  // the external one goes to the back. If they're all saturated it isn't
  // held back: there pickCandidate's order already puts whoever has room
  // first, and the external one is the only one that does. It's the case
  // the roadmap asks for -- saturated network, the request goes out -- and
  // delaying it would break that too.
  candidatos = propios.some((n) => !estaSaturado(n))
    ? [...propios, ...orden.filter(esTercero)]
    : orden
  // Plain `motivo` is already used by the API-key rejection further up.
  const motivoRuteo = eleccion.reason
  const decision = eleccion.decision
  if (!node) {
    // D5: never a silent hang. The message says which models ARE around
    // right now, which is the only actionable thing for whoever gets it --
    // and it's the most likely case if someone points a client with a
    // different default model.
    const disponibles = store
      .listNodes()
      .filter((n) => n.status === 'online')
      .map((n) => n.modelId)
    const detalle = disponibles.length
      ? `available: ${disponibles.join(', ')}`
      : 'no node connected right now'
    return sendError(res, 404, `no nodes serving "${model}"; ${detalle}`, {
      code: 'model_not_found'
    })
  }

  // The candidate walk, the per-attempt reservation, the streaming, the
  // settlement, and the trail all live there. handleChat chooses WHICH
  // candidates there are and in what order; that other function tries them
  // until one answers.
  return await handleChatConReintentos({
    req,
    res,
    node,
    candidatos,
    model,
    messages,
    stream,
    cuenta: cuentaDe(req),
    maxTokensPedido: norm.maxTokens || 0,
    pin,
    decision,
    motivo: motivoRuteo,
    // FASE 9 — el pago ya verificado, para liquidarlo DESPUES de servir (D12).
    pago: pagoVerificado,
    topeCobrado: topeDeclarado
  })
}

async function onRequest(req, res) {
  const pathname = req.url.split('?')[0]

  try {
    // `/` is the chat. What used to be there -the marketplace grid- now
    // lives at /network: picking a node by hand stopped being the step
    // before asking something and became what you look at when you want to
    // see the network.
    if (req.method === 'GET' && pathname === '/') {
      const { CHAT_HTML } = await import('./pages.mjs')
      return sendHtml(res, CHAT_HTML)
    }
    if (req.method === 'GET' && pathname === '/network') {
      const { NETWORK_HTML } = await import('./pages.mjs')
      return sendHtml(res, NETWORK_HTML)
    }
    if (req.method === 'GET' && pathname === '/node') {
      const { NODE_HTML } = await import('./pages.mjs')
      return sendHtml(res, NODE_HTML)
    }
    if (req.method === 'GET' && pathname === '/admin') {
      const { ADMIN_HTML } = await import('./pages.mjs')
      return sendHtml(res, ADMIN_HTML)
    }
    // The old routes still resolve: there are commands, screenshots, and a
    // README that name them, and a 404 after a rename is a regression for
    // whoever had the link saved.
    if (req.method === 'GET' && (pathname === '/proveedor' || pathname === '/cliente')) {
      res.writeHead(302, { Location: pathname === '/proveedor' ? '/node' : '/' })
      return res.end()
    }

    // -----------------------------------------------------------------------
    // THIS gateway's credentials.
    //
    // There are several on purpose: if there were just one, every new bot
    // would force sharing the same credential, and revoking for one would
    // mean revoking for all. With one key per client, one can be cut off
    // without touching the rest, and the trail can say which one requested
    // what.
    //
    // The key authenticates against YOUR gateway, not against the remote node
    // that ends up serving: it's the gateway that later decides where to
    // route. That's why this lives in "My Node" and not on a peer's card.
    // -----------------------------------------------------------------------

    // The panel's own credential. Created on its own the first time and
    // reused by nodeId, so the browser doesn't generate a new key on every
    // reload.
    if (req.method === 'GET' && pathname === '/v1/keys/panel') {
      const entry = apikeys.keyForNode(PANEL_KEY_ID, 'web panel')
      return sendJson(res, 200, { id: entry.id, label: entry.label, key: entry.key })
    }

    // Managing credentials requires presenting one. The only exception is
    // /v1/keys/panel above, which is the bootstrap: the browser has to be
    // able to get ITS OWN key before it can authenticate with it.
    //
    // Honest limit: the gateway only listens on 127.0.0.1, so this doesn't
    // defend against another process on the same machine -- which can ask
    // the bootstrap for the key just like the panel does. It defends against
    // the rest of the network if the bind ever stops being loopback, and it
    // makes consumption attributable per client, which is what having
    // several keys is about.
    if (pathname === '/v1/keys' || pathname.startsWith('/v1/keys/')) {
      const motivoKeys = rechazoPorKey(req)
      if (motivoKeys) return sendError(res, 401, motivoKeys)
    }

    // Revoke EVERYTHING. Goes before the /v1/keys/:id match so "revoke-all"
    // doesn't get read as a key's id.
    if (req.method === 'POST' && pathname === '/v1/keys/revoke-all') {
      const revoked = apikeys.reset()
      // The panel would be left without a credential and unable to chat
      // anymore: a new one gets issued to it on the spot.
      apikeys.keyForNode(PANEL_KEY_ID, 'web panel')
      return sendJson(res, 200, { revoked, keys: apikeys.listKeysFull() })
    }

    if (pathname === '/v1/keys') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { keys: apikeys.listKeysFull() })
      }
      if (req.method === 'POST') {
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch {
          /* no body: default label is kept */
        }
        const raw = typeof body.label === 'string' ? body.label.trim() : ''
        const entry = apikeys.createKey({ label: raw ? raw.slice(0, 40) : 'unnamed client' })
        return sendJson(res, 201, {
          id: entry.id,
          label: entry.label,
          key: entry.key,
          createdAt: entry.createdAt,
          lastUsedAt: null
        })
      }
    }

    const keyMatch = pathname.match(/^\/v1\/keys\/([^/]+)$/)
    if (req.method === 'DELETE' && keyMatch) {
      const id = decodeURIComponent(keyMatch[1])
      if (!apikeys.revokeKey(id)) return sendError(res, 404, 'no such api key')
      return sendJson(res, 200, { revoked: 1, keys: apikeys.listKeysFull() })
    }

    // ---- el agente local: estado y lanzamiento ----------------------------
    if (req.method === 'GET' && pathname === '/v1/agent') {
      return sendJson(res, 200, agentStatus())
    }
    if (req.method === 'POST' && pathname === '/v1/agent/launch') {
      if (swarmRef) return sendJson(res, 200, agentStatus())
      if (!launcher) {
        return sendError(
          res,
          503,
          'this gateway cannot launch an agent by itself — restart it with "pyrusllm serve --swarm"',
          { type: 'service_unavailable', code: 'no_launcher' }
        )
      }
      if (launchState.status === 'launching') return sendJson(res, 200, agentStatus())

      // Responds BEFORE it finishes: joining the topic is fast, but the
      // first peer takes ~17s to show up via the DHT, and leaving the POST
      // hanging that whole time reads as the button not having worked.
      launchState = { status: 'launching', message: null }
      sendJson(res, 202, agentStatus())
      ;(async () => {
        try {
          await launcher()
          launchState = { status: 'live', message: null }
        } catch (err) {
          launchState = { status: 'error', message: (err && err.message) || String(err) }
        }
      })()
      return
    }

    // ---- orchestrator: task assignment y status ---
    if (req.method === 'POST' && pathname === '/v1/orchestrator/tasks') {
      const body = await parseBody(req)
      // { tickets: [{id, spec, allowedFiles}], driveKey }
      if (!body.driveKey || !Array.isArray(body.tickets)) {
        return sendError(res, 400, 'missing driveKey or tickets')
      }
      // Almacena en store (temporal, mientras el nodo corre)
      const tasks = Object.fromEntries(body.tickets.map(t => [t.id, { ...t, status: 'pending' }]))
      store.set('orchestrator:tasks', JSON.stringify({ driveKey: body.driveKey, tasks }))
      return sendJson(res, 200, { status: 'accepted', count: body.tickets.length })
    }

    if (req.method === 'GET' && pathname === '/v1/orchestrator/status') {
      const tasksJson = store.get('orchestrator:tasks')
      const data = tasksJson ? JSON.parse(tasksJson) : { tasks: {} }
      return sendJson(res, 200, data)
    }

    // Strict OpenAI format: what a third-party client reads.
    if (req.method === 'GET' && pathname === '/v1/models') {
      const created = Math.floor(Date.now() / 1000)
      const data = store
        .listNodes()
        .filter((n) => n.status === 'online')
        // B12 -- `owned_by` used to say the operator, i.e. "OpenRouter
        // (external)": it was the third door through which you could read
        // which provider is paying for this node, and the only one of the
        // three that can't be closed off with a credential. An OpenAI
        // client has to be able to discover the catalog BEFORE having a
        // key -- closing this route would break exactly the compatibility
        // that's the reason it exists -- so the data gets closed off
        // instead of the door.
        //
        // The `id` no longer gives anything away: since `anunciadoComo` the
        // catalog carries the name THIS network advertises the model
        // under, not the provider's.
        .map((n) => ({ id: n.modelId, object: 'model', created, owned_by: 'pyrusllm' }))
      return sendJson(res, 200, { object: 'list', data })
    }
    // Rich marketplace view: price, operator, load. Consumed by the panels;
    // not part of the OpenAI protocol, which is why it lives on its own.
    //
    // B12 -- requires a credential, for the same reason B7 put one on
    // /v1/upstream. `toPublic` returns `operator` ("OpenRouter (external)")
    // and `pricing` ("USD 0.20 / per 1m completion tokens"), which is
    // EXACTLY what that route protects: who the provider is and what they
    // get paid. Closing off one of the two and leaving the other open
    // protected nothing -- you'd just need to ask for the data through the
    // door next to it.
    if (req.method === 'GET' && pathname === '/v1/nodes') {
      const motivoNodos = rechazoPorKey(req)
      if (motivoNodos) return sendError(res, 401, motivoNodos)

      // `swarm: null` is the signal the Provider panel uses to show the
      // onboarding block: this gateway is running (`serve`/`serve --demo`)
      // but hasn't joined the P2P network yet.
      const swarm = swarmRef
        ? {
            operator: swarmRef.operator,
            publicKey: swarmRef.identity.publicKey.toString('hex'),
            verifiedPeers: swarmRef.verifiedPeers().length
          }
        : null
      return sendJson(res, 200, { nodes: store.listNodes(), swarm })
    }
    // PHASE 8.5 — the external assistant's status and its on/off switch.
    //
    // The opt-in can be flipped live and not only from the file: the real
    // case is "the network got saturated in the middle of a demo." What
    // CANNOT be done over HTTP is configuring a new upstream or changing its
    // credential: that lives on the operator's disk.
    if (req.method === 'GET' && pathname === '/v1/upstream') {
      // B7 -- requires a credential, same as the POST. The response carries
      // no secrets (the environment variable's NAME, never its value), but
      // it does carry who the provider is, which models get paid for, and
      // whether the credential is loaded. With that, anyone who reaches the
      // port knows whether there's a funded account on the other end and
      // against which API. Every other route that talks about money already
      // requires a key; this one had been left out.
      const rechazoLectura = rechazoPorKey(req)
      if (rechazoLectura) return sendError(res, 401, rechazoLectura)
      return sendJson(res, 200, upstreamStatus())
    }
    if (req.method === 'POST' && pathname === '/v1/upstream/opt-in') {
      // Requires a credential same as /v1/chat/completions: flipping the
      // opt-in on is authorizing spend against the operator's account.
      // Leaving it open would mean letting anyone who reaches the port
      // start spending their money.
      const rechazo = rechazoPorKey(req)
      if (rechazo) return sendError(res, 401, rechazo)

      let cuerpo = {}
      try {
        cuerpo = await readJsonBody(req)
      } catch {
        return sendError(res, 400, 'invalid body, expected JSON')
      }
      if (typeof cuerpo.enabled !== 'boolean') {
        return sendError(res, 400, 'missing "enabled" (boolean)')
      }
      setUpstreamOptIn(cuerpo.enabled)
      console.log(`[upstream] opt-in ${upstreamOptIn ? 'ON' : 'off'} via HTTP`)
      return sendJson(res, 200, upstreamStatus())
    }
    // B12 -- and this is the most exposing of the three. Besides the
    // provider and its price, every entry carries `costMicros` -- the spend
    // in dollars, request by request -- and `degradado`, which is the trail
    // of money decisions. It used to be the only route in the system from
    // which you could read how much the operator was spending without
    // presenting anything.
    // PHASE 7 — where this node gets paid.
    //
    // Requires a credential under the same criterion as B12: it's money
    // information. The honest limit is that the address is NOT a secret --
    // it travels in the signed manifest announced to the whole network, and
    // it has to, because it's who has to be paid. What the gate protects is
    // any third party being able to ask the port whether this machine
    // charges.
    if (req.method === 'GET' && pathname === '/v1/wallet') {
      const motivoWallet = rechazoPorKey(req)
      if (motivoWallet) return sendError(res, 401, motivoWallet)
      return sendJson(res, 200, walletStatus())
    }
    // PHASE 9 / D12 — recovering the receipt for a request that was paid for.
    //
    // Exists because with streaming the receipt travels as a final SSE
    // event, and a client that cut the connection before the last event
    // would be left without it. Requires NO credential: whoever paid has
    // none -- that's the whole point of the 402 -- and the completion's id
    // is already secret enough to recover a piece of data that also ends up
    // public on the chain anyway.
    if (req.method === 'GET' && pathname.startsWith('/v1/receipts/')) {
      const id = decodeURIComponent(pathname.slice('/v1/receipts/'.length))
      const guardado = recibos.get(id)
      if (!guardado) {
        return sendError(res, 404, 'no receipt for that id', { code: 'receipt_not_found' })
      }
      // The settlement receipt is still returned FLATTENED at the root: it's
      // the shape clients and the test already read, and nesting it now
      // would break whoever looks for `transaction` where it used to be.
      // D24's attestation enters alongside, in its own key.
      return sendJson(res, 200, {
        id,
        ...guardado.recibo,
        // PHASE 10 — a routed request isn't charged by this gateway: the
        // peer accumulates it in its own batch. Without this, a client that
        // sees `attestation` but no `transaction` doesn't know whether
        // settlement failed or was simply never ours.
        ...(guardado.servedByPeer ? { settledBy: 'peer-batch', success: undefined } : {}),
        // PHASE 10 — this node declares batch-receipts: it served, it
        // accumulated the payment in its batch, and it settles deferred.
        // There's no `transaction` on this side yet, and `success` left
        // undefined says so.
        ...(guardado.deferred ? { settledBy: 'batch', success: undefined } : {}),
        // D24 — what this node served, signed by its wallet. `null` with a
        // reason when there isn't one: the normal case is that whoever
        // served it was a peer, and there the attestation is signed by it
        // (Phase 10), not by us.
        attestation: guardado.atestacion || null,
        attestationMissing: guardado.sinAtestacion || undefined
      })
    }
    if (req.method === 'GET' && pathname === '/v1/routing-log') {
      const motivoLog = rechazoPorKey(req)
      if (motivoLog) return sendError(res, 401, motivoLog)
      return sendJson(res, 200, { log: store.getLog() })
    }

    // PHASE 6.5 — how much this account has spent and how much it has left.
    //
    // Requires a credential same as /v1/chat/completions: the balance
    // belongs to ONE account, and with no key there's no account to answer
    // for. Returning the balance to whoever reaches the port would mean
    // telling a third party how much the owner is spending.
    if (req.method === 'GET' && pathname === '/v1/budget') {
      const motivo = rechazoPorKey(req)
      if (motivo) return sendError(res, 401, motivo)

      const uso = budget.usage(cuentaDe(req))
      const nodo = budget.nodeUsage()
      return sendJson(res, 200, {
        period: uso.period,
        // The micros are the truth; the strings are so the panel doesn't
        // have to know about the unit. Both go out, not just one: a client
        // that wants to compare or add needs the integer, not "USD 0.0135."
        spent_micros: uso.spent,
        reserved_micros: uso.reserved,
        cap_micros: uso.cap,
        remaining_micros: uso.remaining,
        spent: costs.formatUSD(uso.spent),
        reserved: costs.formatUSD(uso.reserved),
        cap: costs.formatUSD(uso.cap),
        remaining: costs.formatUSD(uso.remaining),
        // B13 — the NODE's cap goes next to the account's, because whichever
        // one actually cuts things off could be either. Showing only the
        // account's used to make a client with plenty of balance left see
        // "I have USD 20 left" and still get a 402, with nothing to explain
        // it.
        node: {
          spent_micros: nodo.spent,
          reserved_micros: nodo.reserved,
          cap_micros: nodo.cap,
          remaining_micros: nodo.remaining,
          spent: costs.formatUSD(nodo.spent),
          cap: costs.formatUSD(nodo.cap),
          remaining: costs.formatUSD(nodo.remaining)
        }
      })
    }

    // The month's breakdown: how much each account consumed. What gets billed.
    if (req.method === 'GET' && pathname === '/v1/budget/report') {
      const motivo = rechazoPorKey(req)
      if (motivo) return sendError(res, 401, motivo)

      const periodo = new URLSearchParams(req.url.split('?')[1] || '').get('period')
      const rep = budget.report({ period: periodo || null })
      return sendJson(res, 200, {
        period: rep.period,
        found: rep.found,
        total_micros: rep.total,
        total: costs.formatUSD(rep.total),
        accounts: rep.accounts.map((a) => ({
          account: a.account,
          spent_micros: a.spent,
          spent: costs.formatUSD(a.spent)
        }))
      })
    }

    // PHASE 6.6 — the other side of the same mirror: how much this node GAVE
    // AWAY for free.
    //
    // /v1/budget looks inward (what this machine consumed and has left);
    // this looks outward (what this machine lent to others). Two different
    // counters, on purpose: the one above is kept by the gateway because
    // it's the one spending, and this one is kept by the provider because
    // it's the one lending out the GPU. D18 and D23, the same principle
    // applied to both sides.
    //
    // The peer's key is shown truncated. Whole it adds nothing on a screen
    // and it's another person's network identifier: no reason to leave it
    // written out in full in the panel's view.
    if (req.method === 'GET' && pathname === '/v1/quota') {
      const motivo = rechazoPorKey(req)
      if (motivo) return sendError(res, 401, motivo)

      const cfg = quota.config()
      const filas = quota.listar()
      return sendJson(res, 200, {
        quota_tokens: cfg.tokens,
        window_hours: cfg.horas,
        // What got given away in the window, summed up. The number that
        // matters to the node's owner: how much GPU they put in out of
        // pocket today.
        given_tokens: filas.reduce((acc, f) => acc + f.used, 0),
        peers: filas.map((f) => ({
          peer: f.peerKey.slice(0, 8) + '…',
          used: f.used,
          remaining: f.remaining,
          quota: f.quota
        }))
      })
    }

    // The FULL series, from the Hyperbee. `/v1/routing-log` returns the ring
    // of 30 the panel paints; that's not enough for an audit -- 30 entries
    // fill up in a single test session and the demo's evidence gets left
    // out. This is the route scripts/auditoria.js consumes.
    //
    // Goes out with the node's identity alongside on purpose: a loose JSONL
    // doesn't say WHO generated it, and an audit that can't attribute the
    // trail to a public key doesn't prove much.
    if (req.method === 'GET' && pathname === '/v1/audit') {
      const q = req.url.split('?')[1] || ''
      const pedido = Number(new URLSearchParams(q).get('limit'))
      const limit = Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, 10000) : 500

      return sendJson(res, 200, {
        generadoEn: new Date().toISOString(),
        nodo: swarmRef
          ? {
              operator: swarmRef.operator,
              publicKey: swarmRef.identity.publicKey.toString('hex'),
              verifiedPeers: swarmRef.verifiedPeers().length
            }
          : null,
        // `false` when the gateway runs with no `--data`: then the trail is
        // just the in-memory ring and dies with the process. Stating it
        // matters, because it changes what the evidence can actually claim.
        persistido: store.getDirectory() !== null,
        log: await store.getLogHistory(limit)
      })
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      return await handleChat(req, res)
    }

    // -----------------------------------------------------------------------
    // Own manifest: editing displayName/tags/capacity/model from the
    // Provider panel. See docs/superpowers/specs/2026-08-22-panel-
    // proveedor-onboarding-schema-design.md.
    //
    if (pathname === '/v1/swarm/manifest') {
      if (!swarmRef) {
        return sendError(res, 503, 'no active swarm (run with "serve --swarm")', {
          type: 'service_unavailable'
        })
      }

      if (req.method === 'GET') {
        const { availableModels, systemInfo } = await import('./hardware.mjs')
        return sendJson(res, 200, {
          manifest: swarmRef.manifest(),
          hardware: systemInfo(),
          models: availableModels(),
          modelLoad: modelLoadState
        })
      }

      if (req.method === 'POST') {
        // S3 in NOTES-SATURACION.md: this used to be the ONLY route that
        // mutates state with no gate. Chat, upload, fetch, kick, and a
        // node's patch already required the key; this one let anything
        // running on localhost change this node's announced model, tags,
        // and capacity -- and the node would re-sign it with its identity.
        // Announcing on someone's behalf is at least as sensitive as
        // spending their tokens.
        const motivoManifiesto = rechazoPorKey(req)
        if (motivoManifiesto) return sendError(res, 401, motivoManifiesto)

        let body
        try {
          body = await readJsonBody(req)
        } catch {
          return sendError(res, 400, 'invalid body, expected JSON')
        }

        const current = currentModelEntry()
        if (!current) return sendError(res, 500, 'this node has no model announced')

        // A model change is the only thing that triggers a heavy load -- it
        // responds right away with "loading" and the panel polls the GET
        // above, instead of leaving the request hanging while 5+ GB load.
        if (typeof body.modelId === 'string' && body.modelId !== current.modelId) {
          const { MODEL_INFO } = await import('./models.mjs')
          const { fitsInMemory, systemInfo } = await import('./hardware.mjs')
          const info = MODEL_INFO[body.modelId]
          if (!info) {
            return sendError(res, 400, `unknown model: "${body.modelId}"`)
          }
          if (!fitsInMemory(info.sizeGB, systemInfo().totalMemGB)) {
            return sendError(
              res,
              400,
              `"${info.displayName}" needs ~${info.sizeGB.toFixed(1)} GB and this machine doesn't have it`
            )
          }

          modelLoadState = { status: 'loading', modelId: body.modelId }
          sendJson(res, 200, { status: 'loading', modelId: body.modelId })

          // No await: the request has ALREADY responded. Everything below
          // runs in the background and the panel sees it via the GET above.
          ;(async () => {
            try {
              await swarmRef.provider.preloadModel(body.modelId)
              const updated = [{ ...current, modelId: body.modelId, displayName: info.displayName }]
              swarmRef.provider.models = updated
              swarmRef.updateAnnouncement({ models: updated })

              // Without this, /v1/nodes -what the panels read- kept
              // showing the OLD modelId even after the signed manifest and
              // the Provider had already changed: the store's row is a
              // third place where the announced model lives, and it stayed
              // out of sync. `registerLocal` deletes this same node's
              // previous row before creating the new one (see store.mjs).
              const oldStoreId = store.localNodeIdFor(current.modelId)
              const oldStoreNode = oldStoreId ? store.getNode(oldStoreId) : null
              store.registerLocal({
                modelId: body.modelId,
                displayName: info.displayName,
                operator: swarmRef.operator,
                tags: swarmRef.tags,
                pricing: oldStoreNode ? oldStoreNode.pricing : undefined,
                maxConcurrentRequests: updated[0].maxConcurrentRequests
              })

              modelLoadState = { status: 'ready', modelId: body.modelId }
            } catch (err) {
              // The old model is still the one announced: neither
              // provider.models nor swarmRef.models got touched, so the
              // node keeps responding with exactly what it already
              // promised.
              modelLoadState = {
                status: 'error',
                modelId: body.modelId,
                message: (err && err.message) || String(err)
              }
            }
          })()
          return
        }

        // Changes with no loading: displayName/maxConcurrentRequests (per
        // model) and tags (node-wide).
        const patched = { ...current }
        if (typeof body.displayName === 'string') {
          patched.displayName = body.displayName.slice(0, 80)
        }
        if (Number.isFinite(body.maxConcurrentRequests) && body.maxConcurrentRequests > 0) {
          patched.maxConcurrentRequests = Math.floor(body.maxConcurrentRequests)
        }
        const updated = [patched]
        swarmRef.provider.models = updated

        // The other half of S2: changing the number in the manifest has to
        // change the limit the Provider enforces. `provider.models` already
        // got updated here, but `maxConcurrent` -- the one number that
        // rejects requests, provider.mjs:169 -- stayed at its startup
        // value. The node ended up announcing a capacity it didn't honor,
        // which is exactly what the signed manifest exists to prevent.
        swarmRef.provider.maxConcurrent =
          updated.reduce(
            (n, m) => n + (Number.isFinite(m.maxConcurrentRequests) ? m.maxConcurrentRequests : 0),
            0
          ) || 1

        // And the registry row, which is where the `node:status` peers see
        // comes from: without this the network would keep seeing the old
        // capacity.
        const filaLocal = store.localNodeIdFor(patched.modelId)
        if (filaLocal) {
          const fila = store.getNode(filaLocal)
          if (fila) fila.maxConcurrentRequests = patched.maxConcurrentRequests
        }

        const tags = Array.isArray(body.tags)
          ? body.tags.map((t) => String(t).slice(0, 24)).slice(0, 10)
          : undefined

        const fresh = swarmRef.updateAnnouncement({ models: updated, tags })
        return sendJson(res, 200, { manifest: fresh })
      }
    }

    // -----------------------------------------------------------------------
    // Files (Hyperdrive). See qvac/files.mjs.
    //
    // Only exists with `serve --swarm` and without --no-store: no Corestore
    // means no drive. Responds 503 with a readable reason instead of 500,
    // because "not enabled" and "it broke" are different things for whoever
    // reads it.
    // -----------------------------------------------------------------------
    if (pathname === '/v1/files' || pathname.startsWith('/v1/files/')) {
      if (!filesApi) {
        return sendError(
          res,
          503,
          'files require "serve --swarm" (the Corestore is needed)',
          {
            type: 'service_unavailable'
          }
        )
      }
    }

    // What THIS machine publishes, or -with ?link=/?key=- what another one
    // does. Listing a remote drive does NOT download the blobs: a
    // Hyperdrive's metadata replicates separately, so a 40 GB drive can be
    // browsed and a single file downloaded.
    if (req.method === 'GET' && pathname === '/v1/files') {
      const q = new URLSearchParams(req.url.split('?')[1] || '')
      const link = q.get('link')
      const key = q.get('key')
      const peerKey = q.get('peerKey')
      try {
        if (peerKey) {
          // The panel only knows the node's peerKey (comes from
          // toPublic()), not the drive's key -- the peer announces that on
          // its own via files:announce (swarm.mjs) and only the swarm
          // knows how to tie it to the peer.
          if (!swarmRef) {
            return sendError(res, 503, 'a peer\'s files require "serve --swarm"', {
              type: 'service_unavailable'
            })
          }
          const par = swarmRef.peersWithFiles().find((p) => p.peerKey === peerKey)
          if (!par) {
            return sendError(
              res,
              404,
              'that peer has not announced any files (has not connected yet, or published nothing)'
            )
          }
          const files = await filesApi.listRemote(par.driveKey, '/', { timeoutMs: 20000 })
          return sendJson(res, 200, { keyHex: par.driveKey, remote: true, files })
        }
        if (link || key) {
          const { parseLink } = await import('./files.mjs')
          const keyHex = key || parseLink(link).keyHex
          if (!/^[0-9a-f]{64}$/.test(keyHex)) {
            return sendError(res, 400, 'the drive key has to be 32-byte hex')
          }
          const files = await filesApi.listRemote(keyHex, '/', { timeoutMs: 20000 })
          return sendJson(res, 200, { keyHex, remote: true, files })
        }
        return sendJson(res, 200, {
          keyHex: filesApi.keyHex,
          remote: false,
          files: await filesApi.list('/')
        })
      } catch (err) {
        return sendError(
          res,
          502,
          'could not read the drive: ' + (err && err.message ? err.message : err)
        )
      }
    }

    // Publish. The body is the file's raw BYTES and the name travels in the
    // query: no multipart means no parser to write, and the browser can
    // send a File as fetch()'s body as-is. Written to disk via stream and
    // not to memory -- a 200 MB PDF buffered whole takes down the process.
    if (req.method === 'POST' && pathname === '/v1/files/upload') {
      // Same optional gate as /v1/chat/completions (see rechazoPorKey):
      // without this check, anyone on the venue's wifi could write up to
      // 512 MB to this disk and publish it on the DHT under this node's name.
      const motivoUpload = rechazoPorKey(req)
      if (motivoUpload) return sendError(res, 401, motivoUpload)

      const q = new URLSearchParams(req.url.split('?')[1] || '')
      const nombre = sanitizeFilename(q.get('name') || '')
      if (!nombre) return sendError(res, 400, 'missing "name" in the query')

      try {
        const guardado = await recibirArchivo(req, nombre)
        const info = await filesApi.share(guardado, nombre)
        return sendJson(res, 200, info) // { path, bytes, link }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err)
        const code = msg.includes('too large') ? 413 : 500
        return sendError(res, code, 'could not publish: ' + msg)
      }
    }

    // Download a file from another drive onto this machine's disk.
    if (req.method === 'POST' && pathname === '/v1/files/fetch') {
      const motivoFetch = rechazoPorKey(req)
      if (motivoFetch) return sendError(res, 401, motivoFetch)

      let body
      try {
        body = await readJsonBody(req)
      } catch {
        return sendError(res, 400, 'invalid body, expected JSON')
      }
      if (typeof body.link !== 'string') return sendError(res, 400, 'missing "link"')

      try {
        const { parseLink } = await import('./files.mjs')
        const { keyHex, path: ruta } = parseLink(body.link)
        if (ruta === '/')
          return sendError(res, 400, 'the link points at the whole drive, not a file')

        const fs = await import('bare-fs')
        const path = await import('bare-path')
        const destino = path.default.join(descargasDir(), path.default.basename(ruta))
        await fs.default.promises.mkdir(descargasDir(), { recursive: true })

        const r = await filesApi.pull(keyHex, ruta, destino, { timeoutMs: 60000 })
        return sendJson(res, 200, { destino, bytes: r && r.bytes ? r.bytes : null })
      } catch (err) {
        return sendError(res, 502, 'could not download: ' + (err && err.message ? err.message : err))
      }
    }

    // /v1/connection/:id was removed: it issued a credential PER REMOTE
    // NODE, as if there were a key "for talking to this provider." That's
    // not how it works -- the key authenticates against THIS gateway, and
    // it's the one that routes afterward. Credentials are managed at
    // /v1/keys.

    const kickMatch = pathname.match(/^\/v1\/nodes\/([^/]+)\/kick$/)
    if (req.method === 'POST' && kickMatch) {
      // Without this, anyone on the same network could empty the live panel
      // by kicking other people's nodes -- the same optional gate that
      // already protects the chat.
      const motivoKick = rechazoPorKey(req)
      if (motivoKick) return sendError(res, 401, motivoKick)

      const node = store.kick(decodeURIComponent(kickMatch[1]))
      return node ? sendJson(res, 200, node) : sendError(res, 404, 'unknown node')
    }

    const nodeMatch = pathname.match(/^\/v1\/nodes\/([^/]+)$/)
    if (req.method === 'POST' && nodeMatch) {
      const motivoPatch = rechazoPorKey(req)
      if (motivoPatch) return sendError(res, 401, motivoPatch)

      const id = decodeURIComponent(nodeMatch[1])
      if (!store.getNode(id)) return sendError(res, 404, 'unknown node')

      let patch
      try {
        patch = await readJsonBody(req)
      } catch {
        return sendError(res, 400, 'invalid body, expected JSON')
      }

      // `updated` used to get overwritten with the result of each set: an
      // invalid status returned null and the endpoint answered 404 "unknown
      // node" -even though the node existed AND the pricing had already
      // been applied-.
      //
      // EVERYTHING gets validated before touching anything: a request with
      // one invalid field can't leave the other one half-applied. The
      // node's existence is checked once, above.
      const hasPricing = patch.pricing !== undefined
      const hasStatus = patch.status !== undefined

      if (!hasPricing && !hasStatus) {
        return sendError(res, 400, 'nothing to update: send "pricing" or "status"')
      }
      if (hasPricing && typeof patch.pricing !== 'string') {
        return sendError(res, 400, '"pricing" has to be a string')
      }
      if (hasStatus && patch.status !== 'online' && patch.status !== 'offline') {
        return sendError(res, 400, '"status" has to be "online" or "offline"')
      }

      let updated = null
      if (hasPricing) updated = store.setPricing(id, patch.pricing)
      if (hasStatus) updated = store.setStatus(id, patch.status)
      return sendJson(res, 200, updated)
    }

    sendError(res, 404, 'not found', { code: 'not_found' })
  } catch (err) {
    console.error('[gateway] error:', err)
    if (!res.headersSent) {
      sendError(res, 500, String((err && err.message) || err), { type: 'server_error' })
    }
  }
}

export function createGateway({
  port = 8787,
  gpuLayers: gpu,
  demo = false,
  model,
  ctx,
  logInference = false
} = {}) {
  gpuLayers = Number.isFinite(gpu) ? gpu : undefined
  // The model the engine loads. Chosen by whoever starts the gateway, and
  // it's the SAME one `bin.mjs` announces in the manifest: a single source.
  if (model) modeloLocal = model
  if (Number.isFinite(ctx)) ctxLocal = ctx
  logInferencia = logInference === true

  // Without --demo the gateway starts EMPTY: zero nodes, zero mocks. It's
  // Phase 3's real state before a peer announces itself over the swarm, and
  // it makes D5's error path the default instead of a branch nobody
  // exercises.
  if (demo) {
    store.seed()
    store.startFluctuation()
  }

  const server = http.createServer(onRequest)

  // Without this handler, starting with the port already taken throws an
  // `Uncaught Error: address already in use` with a bare-tcp stack and
  // nothing else. It's the demo's most likely error -an old gateway was
  // left running- and the message has to say what to do.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n[gateway] port ${port} is already in use.`)
      console.error('[gateway] close the other gateway, or start with --port <another one>.\n')
    } else {
      console.error('\n[gateway] could not open the server:', (err && err.message) || err)
    }
    Bare.exit(1)
  })

  // '127.0.0.1', not host-less: without this bare-http1 binds 0.0.0.0 even
  // though the log says "localhost," and anyone on the hackathon's wifi
  // reaches the gateway -including the files and admin routes, with no
  // credential-.
  server.listen(port, '127.0.0.1', () => {
    console.log('')
    console.log(`  [gateway] listening on http://localhost:${port}`)
    console.log(`  [gateway] chat:    http://localhost:${port}/`)
    console.log(`  [gateway] my node: http://localhost:${port}/node`)
    console.log(`  [gateway] network: http://localhost:${port}/network`)
    if (gpuLayers !== undefined) console.log(`  [gateway] gpu_layers: ${gpuLayers}`)
    if (demo) {
      console.log('  [gateway] --demo mode: SIMULATED nodes in the registry (see README)')
    } else {
      console.log('  [gateway] empty registry: no node announced yet.')
      console.log('  [gateway] for the demo with simulated nodes: serve --demo')
    }
    console.log('')
  })
  return server
}

export async function shutdownGateway() {
  store.stopFluctuation()
  // The ledger closes before the engine: an orderly shutdown has to leave
  // the last request's spend on disk, and the engine can take a while.
  budget.close()
  if (engineMod && realModelId) await engineMod.shutdown(realModelId)
}
