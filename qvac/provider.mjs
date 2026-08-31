// The side that SERVES inference to a remote peer. ROADMAP Phase 3.
//
// Handles `chat:request` messages that arrive over the FramedStream the swarm
// already has open (D1: there's no second connection, no HTTP hop to
// localhost).
//
// Lives in its own module instead of inside swarm.mjs because they're two
// different responsibilities: the swarm decides WHO you talk to, the provider
// decides WHAT gets answered. Only `serve --swarm` instantiates it, which is
// the full node; `peers` stays a side-effect-free diagnostic (decided: the
// hard-gate command can't start serving tokens while it's measuring).
//
// Protocol (extends D1's table):
//   chat:request   peer -> node   { requestId, model, messages, stream,
//                                  payment?, maxTokens? }   <- payment: Phase 10
//   chat:accepted  node -> peer   { requestId }            <- added
//   chat:chunk     node -> peer   { requestId, delta }
//   chat:done      node -> peer   { requestId, attestation?, attestationMissing? }  <- Phase 10
//   chat:error     node -> peer   { requestId, message, code }
//   chat:cancel    peer -> node   { requestId }            <- added
//
// `chat:accepted` exists because the model loads LAZILY -only on the first
// request- and that can take tens of seconds. Without an ack, the consumer
// can't tell "it's loading 807 MB" from "it hung", and would have to choose
// between a short timeout that kills legitimate loads or a long one that
// makes you wait for free against a dead peer.
//
// PHASE 10 — when the `chat:request` carries a `payment` (the EIP-3009
// authorization the CLIENT signed in favor of THIS node, forwarded by the
// gateway that routed it), this side does what the gateway does on a local
// charge: builds the D24 attestation of what it served, builds the x402
// receipt with that payment, and adds it to its own batch to settle later.
// The gateway that routed it NO LONGER settles routed requests (full
// handoff): whoever ran the model is the one who charges. The signed
// attestation comes back in `chat:done` for the other side's trail.
//
// What this side does NOT do: re-verify the authorization. It trusts that the
// gateway that routed it already ran `x402.verificarPago`. It's a deliberate
// decision (TTFT is what's measured) and its cost is that a compromised
// gateway can burn someone else's GPU.

import * as quota from './quota.mjs'
import * as atestacion from './atestacion.mjs'
import * as lote from './lote.mjs'
import * as payerStats from './payer-stats.mjs'

const MAX_MESSAGES = 64
const MAX_CONTENT_CHARS = 32000

export class Provider {
  constructor({
    engineLoader,
    store = null,
    maxConcurrent = 3,
    models = [],
    // PHASE 10 — this node's payout wallet and a FUNCTION that signs with it
    // (personal_sign EIP-191, WDK's `account.sign`). Same pattern as
    // `gateway.setWalletSigner`: no seed comes in here. Without both, a
    // routed request with payment still gets served but isn't attested or
    // accumulated, and `chat:done` says so with a reason.
    walletAddress = null,
    firmarConWallet = null
  } = {}) {
    // The loader is injected instead of importing engine.mjs up here:
    // importing the engine does a dlopen of the llamacpp addon (96 MB) right
    // away, and a node that hasn't received a request yet has no reason to
    // pay that cost.
    this.engineLoader = engineLoader
    this.store = store
    this.maxConcurrent = maxConcurrent
    this.models = models
    this.walletAddress = walletAddress
    this.firmarConWallet = typeof firmarConWallet === 'function' ? firmarConWallet : null

    this.engine = null
    // ANNOUNCED modelId -> modelId loaded by the engine. This used to be a
    // single scalar hardcoded to 'llama1b': with only one model in
    // swarmModels() it went unnoticed, but the day a second one gets added,
    // this node would accept the request (serves() validates it against
    // this.models) and would still serve the first model's weights -- exactly
    // what the signed manifest exists to prevent: announcing what you're
    // actually serving.
    this._modelIds = new Map()
    this._loading = new Map()

    // requestId -> { cancelled, peerKey }
    this.active = new Map()
  }

  // The modelIds this node can actually serve. A request for another model
  // gets rejected with a reason, not silence (same principle as D5 on the
  // HTTP side).
  serves(model) {
    return this.models.some((m) => m.modelId === model)
  }

  // Public wrapper around _ensureModel: the gateway uses it to preload a
  // model BEFORE announcing it (POST /v1/swarm/manifest) -- if the load
  // fails, the caller never gets to re-sign the manifest with a model this
  // node can't actually serve.
  async preloadModel(model) {
    return this._ensureModel(model)
  }

  _ensureModel(model) {
    if (this._modelIds.has(model)) return Promise.resolve(this._modelIds.get(model))
    if (!this._loading.has(model)) {
      const loading = (async () => {
        this.engine = this.engine || (await this.engineLoader())
        const { modelSrc } = await this.engine.resolveModel(model)
        const loadedId = await this.engine.loadModel({ modelSrc })
        this._modelIds.set(model, loadedId)
        return loadedId
      })()
      // A rejected promise that stays cached leaves THAT model dead for the
      // whole session: every later request gets the same rejection instantly.
      // Same bug that was already fixed in the gateway.
      loading.catch(() => {
        this._loading.delete(model)
      })
      this._loading.set(model, loading)
    }
    return this._loading.get(model)
  }

  // A peer sends whatever it wants. Nothing that comes in over the socket
  // gets passed to the engine unchecked: a `messages` with 100k entries is a
  // free OOM for whoever is lending their machine.
  _validate(msg) {
    if (typeof msg.requestId !== 'string' || msg.requestId === '') {
      return 'missing requestId'
    }
    if (typeof msg.model !== 'string' || msg.model === '') {
      return 'missing model'
    }
    if (!Array.isArray(msg.messages) || msg.messages.length === 0) {
      return 'messages must be an array with at least one message'
    }
    if (msg.messages.length > MAX_MESSAGES) {
      return `too many messages (${msg.messages.length} > ${MAX_MESSAGES})`
    }
    let total = 0
    for (const m of msg.messages) {
      if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
        return 'every message needs a string role and content'
      }
      total += m.content.length
    }
    if (total > MAX_CONTENT_CHARS) {
      return `prompt too long (${total} > ${MAX_CONTENT_CHARS} chars)`
    }
    return null
  }

  // Returns true if the message was meant for the provider (and was handled).
  handles(type) {
    return type === 'chat:request' || type === 'chat:cancel'
  }

  onMessage(peer, msg, send) {
    if (msg.type === 'chat:cancel') {
      const entry = this.active.get(msg.requestId)
      // Only the peer that opened the request can cancel it. Without this
      // check, any connected peer could cut off another one's stream.
      if (entry && entry.peerKey === peer.key) {
        entry.cancelled = true
        console.log(`[provider] ${msg.requestId} cancelled by the consumer`)
      }
      return
    }

    if (msg.type === 'chat:request') {
      // No await here: each request runs on its own and the channel keeps
      // reading. A slow request can't block the rest of the protocol
      // (node:status, other chats, another peer's manifest).
      this._serve(peer, msg, send).catch((err) => {
        console.error('[provider] uncaught error:', (err && err.message) || err)
      })
    }
  }

  async _serve(peer, msg, send) {
    const reply = (type, extra) => send({ type, requestId: msg.requestId, ...extra })

    const invalido = this._validate(msg)
    if (invalido) {
      return reply('chat:error', { message: invalido, code: 'invalid_request' })
    }

    if (!this.serves(msg.model)) {
      const propios = this.models.map((m) => m.modelId).join(', ')
      return reply('chat:error', {
        message: `this node doesn't serve "${msg.model}"; it serves: ${propios}`,
        code: 'model_not_found'
      })
    }

    // The peer's free quota (D23 / Phase 6.6). Deliberately goes BEFORE the
    // capacity limit: both reject before the first chunk, so D4 retries
    // either way, but the reason isn't interchangeable. "I'm full" invites
    // coming back in two seconds; "you ran out of quota" says exactly when it
    // refills. Answering the first when the second is what actually happened
    // sends the consumer into a retry that's going to fail anyway.
    const cuota = quota.check(peer.key)
    if (!cuota.ok) {
      return reply('chat:error', {
        message: cuota.reason,
        code: 'quota_exceeded',
        // The actionable piece of data: without this the consumer knows it
        // can't, but not when it could.
        resetsInMs: cuota.resetsInMs
      })
    }

    // Declared capacity = honored capacity. The manifest announces
    // maxConcurrentRequests and this is the only place that's enforced:
    // without the limit, the manifest's number would just be decorative.
    //
    // Rejected instead of queued on purpose: the consumer gets the error
    // BEFORE the first chunk, so D4 applies and retries on another
    // candidate. A queue would make the client wait with nobody knowing for
    // how long.
    if (this.active.size >= this.maxConcurrent) {
      return reply('chat:error', {
        message: `this node is at max capacity (${this.active.size}/${this.maxConcurrent})`,
        code: 'at_capacity'
      })
    }

    const entry = { cancelled: false, peerKey: peer.key }
    this.active.set(msg.requestId, entry)

    // The ack goes BEFORE loading the model: that's exactly what tells the
    // consumer "I'm alive and working, don't kill me on timeout".
    reply('chat:accepted', {})

    const localNodeId = this.store ? this.store.localNodeIdFor(msg.model) : null
    if (localNodeId) this.store.beginRequest(localNodeId)

    const t0 = Date.now()
    let deltas = 0
    let ttftMs = null
    // PHASE 10 — the accumulated text, for the D24 attestation's `outputHash`.
    // The hash is over the FULL text served, not over the delta count:
    // whoever chunks the stream is this side, and a hash that depended on the
    // chunking would be the hole D24 closes.
    let contenido = ''
    // PHASE 10 / D9 — the token cap the 402 declared, forwarded by the
    // gateway. Applied HERE so the attestation and what the client receives
    // are the SAME text: if the gateway trimmed it afterward, `outputHash`
    // would attest to more than was delivered. UTF-8 bytes / 4 estimate,
    // same as the gateway.
    const tope =
      Number.isFinite(Number(msg.maxTokens)) && Number(msg.maxTokens) > 0
        ? Number(msg.maxTokens)
        : 0
    let topeAlcanzado = false

    try {
      const modelId = await this._ensureModel(msg.model)

      // Cancelled while the model was loading: generation never starts.
      if (entry.cancelled) return

      for await (const delta of this.engine.complete({ modelId, history: msg.messages })) {
        if (entry.cancelled) {
          // `break` closes the async generator (calls its return()), which is
          // what cuts off generation on the SDK side. If the SDK still keeps
          // going internally there's no way to know from here, but at least
          // no more bytes get sent to anyone and the slot isn't held.
          console.log(`[provider] ${msg.requestId} cut off after ${deltas} deltas`)
          break
        }
        if (ttftMs === null) ttftMs = Date.now() - t0
        deltas++
        contenido += delta
        reply('chat:chunk', { delta })
        if (tope > 0 && Buffer.byteLength(contenido, 'utf8') / 4 >= tope) {
          topeAlcanzado = true
          console.log(`[provider] ${msg.requestId} cut off at the ${tope}-token cap`)
          break
        }
      }

      // PHASE 10 — the receipt for what was served, with the signed
      // attestation. Goes BEFORE `chat:done` so it can be attached. Only if
      // the request carried a payment (meaning: a gateway that charged routed
      // it), this node has something to sign with, and AT LEAST one token got
      // out: a cut-off with no output isn't charged or attested (D27 case 2),
      // same as on the gateway side.
      const finishReason = entry.cancelled ? 'client_cancelled' : topeAlcanzado ? 'length' : 'stop'
      let reciboRes = { attestation: null, motivo: null }
      if (msg.payment && deltas > 0) {
        reciboRes = await this._acumularReciboDelPar({ msg, contenido, deltas, finishReason })
      } else if (msg.payment) {
        reciboRes = { attestation: null, motivo: 'no token was served: not charged (D27)' }
      }

      if (!entry.cancelled) {
        reply('chat:done', {
          ...(reciboRes.attestation ? { attestation: reciboRes.attestation } : {}),
          ...(reciboRes.motivo ? { attestationMissing: reciboRes.motivo } : {})
        })
      } else if (msg.payment && deltas > 0) {
        // PHASE 10 / D27 case 1 — the client cut off, but this node served
        // and attested a chargeable prefix. The late `chat:done` carries that
        // attestation (or the reason if it couldn't be signed) so the
        // gateway can hang it off the routed request's trail instead of
        // leaving it with attestationMissing. The swarm on the other side
        // keeps the chat alive for a short window just to receive this.
        reply('chat:done', {
          ...(reciboRes.attestation ? { attestation: reciboRes.attestation } : {}),
          ...(reciboRes.motivo ? { attestationMissing: reciboRes.motivo } : {})
        })
      }
      console.log(
        `[provider] ${msg.requestId} ${entry.cancelled ? 'cancelled' : topeAlcanzado ? 'capped' : 'ok'}: ` +
          `${deltas} deltas in ${Date.now() - t0}ms`
      )
    } catch (err) {
      const message = String((err && err.message) || err)
      console.error(`[provider] ${msg.requestId} failed: ${message}`)
      // Still notified even if there were already chunks: the consumer needs
      // to know that what it has is incomplete. On its side, D4 decides
      // whether to retry (only if nothing had reached the client yet).
      reply('chat:error', { message, code: 'inference_failed' })
    } finally {
      this.active.delete(msg.requestId)
      if (localNodeId) this.store.endRequest(localNodeId)

      // What was ACTUALLY generated gets deducted, not what was requested. A
      // request cancelled at three tokens costs three, and one that failed
      // while loading the model costs nothing: the quota measures GPU
      // delivered, not attempts. It's in the finally for the same reason as
      // the budget settlement on the other side -- a stream that blows up
      // halfway through still consumed what it consumed.
      quota.registrar(peer.key, deltas)

      // The trail of what THIS node served FOR someone else. Without this
      // entry there was no way to know who consumed us: the routing log only
      // had outgoing traffic -what we requested- and half of the economic
      // relationship stayed invisible.
      //
      // `kind: 'served'` and not 'route': a routing entry says who we asked,
      // this one says who asked us. Mixing them into the same kind would
      // force guessing the direction from whatever fields they carry.
      if (this.store && typeof this.store.pushLog === 'function') {
        const ms = Date.now() - t0
        this.store.pushLog({
          kind: 'served',
          peerKey: peer.key,
          operator: this.store.operatorForPeer
            ? this.store.operatorForPeer(peer.key)
            : peer.key.slice(0, 8),
          modelId: msg.model,
          tokens: deltas,
          ttftMs,
          tokensPerSec: ttftMs !== null && ms > 0 ? +(deltas / (ms / 1000)).toFixed(2) : null,
          ms,
          ok: !entry.cancelled && deltas > 0,
          reason: entry.cancelled ? 'cancelled by the peer' : undefined
        })
      }
    }
  }

  // PHASE 10 — builds the D24 attestation of what was served, builds the
  // x402 receipt with the payment the gateway forwarded, and puts it in its
  // own batch to settle later. Returns `{ attestation, motivo }`:
  // `attestation` is the signed one (or null) and `motivo` says why it's
  // missing, so the absence is readable in `chat:done`.
  //
  // Never throws: a failure here can't take down the `chat:done` of a stream
  // that DID get served. The price of that failure is an un-accumulated
  // receipt -- work served and not charged --, and it's logged loudly.
  async _acumularReciboDelPar({ msg, contenido, deltas, finishReason }) {
    const p = msg.payment
    try {
      if (!this.walletAddress || !this.firmarConWallet) {
        return { attestation: null, motivo: 'this node has no wallet/signer to attest with' }
      }
      if (!p || !p.authorization || !p.signature || !p.requirements) {
        return { attestation: null, motivo: 'the forwarded payment is incomplete' }
      }
      // The 402 had to pay US. If payTo isn't our wallet, either the gateway
      // routed it wrong or the payment was tampered with: don't accumulate it.
      if (String(p.requirements.payTo || '').toLowerCase() !== this.walletAddress.toLowerCase()) {
        console.error(
          `[provider] ${msg.requestId}: the forwarded payment doesn't point to this node's wallet`
        )
        return { attestation: null, motivo: "the forwarded payment doesn't point to this node's wallet" }
      }

      const sinFirmar = atestacion.construir({
        requestId: msg.requestId,
        modelId: msg.model,
        quantization: atestacion.cuantizacionDe(msg.model),
        runtime: 'llamacpp',
        promptHash: atestacion.hashDeMensajes(msg.messages),
        outputHash: atestacion.hashDe(contenido),
        // No `usage` from this side: prefill isn't measured, decode is the
        // delta count. These are the numbers this node commits to standing
        // behind; the source (measured/estimated) is noted by the trail, not
        // by the attestation.
        tokensPrefill: 0,
        tokensDecode: deltas,
        finishReason,
        providerPubkey: this.walletAddress
      })
      const firmada = await atestacion.firmar(sinFirmar, this.firmarConWallet)
      if (!firmada) {
        return { attestation: null, motivo: 'the wallet could not sign the attestation' }
      }

      const recibo = lote.construirRecibo({
        requestId: msg.requestId,
        red: p.red || null,
        network: p.requirements.network,
        asset: p.requirements.asset,
        assetName: p.requirements.extra && p.requirements.extra.name,
        assetVersion: p.requirements.extra && p.requirements.extra.version,
        payTo: this.walletAddress,
        payer: p.authorization.from,
        amount: p.authorization.value,
        authorization: p.authorization,
        signature: p.signature,
        requirements: p.requirements,
        atestacion: firmada,
        liquidacion: null
      })
      lote.agregar(recibo)
      payerStats.observePayment({ payer: p.authorization.from, network: p.requirements.network })
      console.log(
        `[provider] ${msg.requestId}: receipt added to the batch (nonce ${recibo.nonce})`
      )
      return { attestation: firmada, motivo: null }
    } catch (err) {
      console.error(
        `[provider] ${msg.requestId}: could not accumulate the receipt: ${(err && err.message) || err}`
      )
      return { attestation: null, motivo: 'could not build the receipt for what was served' }
    }
  }

  // The peer disconnected: whatever was being generated for it has nowhere to go.
  cancelByPeer(peerKey) {
    let n = 0
    for (const [requestId, entry] of this.active) {
      if (entry.peerKey !== peerKey) continue
      entry.cancelled = true
      n++
      void requestId
    }
    if (n) console.log(`[provider] ${n} request(s) cut off: the peer left`)
  }

  async shutdown() {
    // All get marked as cancelled so in-flight loops cut off on the next
    // iteration instead of continuing to generate against a socket that's
    // no longer there.
    for (const entry of this.active.values()) entry.cancelled = true
    if (this.engine) {
      for (const loadedId of this._modelIds.values()) {
        await this.engine.shutdown(loadedId).catch(() => {})
      }
    }
  }
}
