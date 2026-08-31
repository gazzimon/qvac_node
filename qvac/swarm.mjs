// P2P discovery for the node. Phase 2-b of the ROADMAP.
//
// A fixed topic: every QVAC node finds itself there with no configuration.
// Each connection — inbound or outbound — carries ONE Protomux channel (D1),
// which is the SAME channel that carries chat:request/chat:chunk. There is no
// second connection for inference.
//
// Corestore replication also travels over THAT SAME socket, on other channels
// of the same multiplexer: the Hyperbee directory and the file Hyperdrives.
// One connection, one hole-punch, three things on top.
// (The socket used to be wrapped in FramedStream, which takes ownership of
// the stream and made it impossible to share. See the note in channel.mjs.)
//
// Protocol (JSON per message, D1's table):
//   manifest:announce  node -> peer   the signed manifest
//   node:status        node -> peer   { activeRequests, maxConcurrentRequests }
//   files:announce      node -> peer   { driveKey }  <- added, see files.mjs
//   node:info          node -> peer   { version, platform }  <- added, see network-stats.mjs
//   chat:request       peer -> node   { requestId, model, messages, stream,
//                                       payment?, maxTokens? }   <- Phase 10
//   chat:chunk         node -> peer   { requestId, delta }
//   chat:done          node -> peer   { requestId, attestation?, attestationMissing? }  <- Phase 10
//   chat:error         node -> peer   { requestId, message }
//
// PHASE 10 — `payment` is the EIP-3009 authorization the CLIENT signed in
// favor of the NODE that's going to serve (the 402's payTo = the peer's
// wallet, D10), forwarded as-is by the gateway that routed it:
// `{ authorization, signature, requirements, red }`. With that, whoever runs
// the model builds its receipt and accumulates it for batch settlement.
// `attestation` is the signed D24 from the peer that served, which comes back
// for the gateway's trail. A `chat:request` without `payment` is business as
// usual: served against the free quota, nothing gets attested.
//
// This file does discovery, the manifest handshake, and node:status. Chat
// transport is Phase 2-c/3 and hooks into `onMessage`.

import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import { openChannel, attachMux } from './channel.mjs'
import { buildManifest, signManifest, verifyManifest } from './manifest.mjs'

// Fixed topic, hardcoded on purpose: it's the "QVAC channel." Derived from a
// phrase by hash so it's reproducible from the code and not a hex blob nobody
// can audit at a glance.
//
// **v1, not v0**: the switch from FramedStream to Protomux is NOT wire
// compatible. A v0 node and a v1 node connect fine — the topic was the
// same — and then go silent until HANDSHAKE_TIMEOUT_MS fires, because
// neither understands the other's framing. Seen live: "didn't send a
// manifest, dropping," on loop, against a node that was perfectly healthy.
//
// Splitting the topic turns a silent incompatibility into a clean absence:
// during the OTA window, v0s keep seeing each other and v1s keep seeing each
// other, with no connections born dead and no logs that make it look like
// the network is down. Once the last node updates, v0 stays empty.
export const TOPIC_NAME = 'qvac-node:marketplace:v1'
export const TOPIC = crypto.data(Buffer.from(TOPIC_NAME))

const STATUS_INTERVAL_MS = 2000

// A peer that connected but hasn't sent a valid manifest yet is NOT a
// candidate. If it doesn't send one within this window, it's dropped: it
// could be another app that landed on the same topic, or a node running an
// incompatible version.
const HANDSHAKE_TIMEOUT_MS = 10000

// PHASE 10 / D27 case 1 — how long a chat is kept alive AFTER sending
// `chat:cancel` to the peer, waiting for its late `chat:done` with the
// partial attestation of what it managed to serve. Short: the client is
// already gone and on the other end the peer just has to close the stream it
// was already tearing down.
const CHAT_CANCEL_GRACE_MS = 1500

export class NodeSwarm {
  constructor({
    identity,
    models,
    operator,
    tags,
    store,
    corestore = null,
    directory = null,
    files = null,
    // Phase 7 — the `economic` block with the real payout address, or null if
    // this node has no wallet. Arrives already built from bin.mjs (wallet.mjs
    // knows about chains and settlement); here it just travels through to
    // buildManifest.
    economic = null,
    // Local-only, never gossiped: how many distinct handshake-verified
    // nodes this process has seen. Optional like store/directory/files --
    // `peers` without it behaves exactly as before. See network-stats.mjs
    // for why this is its own module instead of living in directory.mjs.
    networkStats = null,
    // What THIS node announces about itself over `node:info`: not part of
    // the signed manifest (v0's schema is frozen with additionalProperties:
    // false), so it's null unless the caller sets it.
    nodeInfo = null,
    onPeerChange = () => {}
  } = {}) {
    this.identity = identity || crypto.keyPair()
    this.models = models || []
    this.operator = operator || 'QVAC Node'
    this.tags = tags || []
    this.store = store || null
    this.onPeerChange = onPeerChange

    // All three are optional: `peers` (the hard-gate command) runs without
    // any of them and still measures the same thing as before. When they're
    // present, the connection also replicates and persists.
    this.corestore = corestore
    this.directory = directory
    this.files = files
    this.economic = economic
    this.networkStats = networkStats
    this.nodeInfo = nodeInfo

    this.swarm = null
    // peer's hex key -> { channel, manifest, status, socket, filesKey }
    this.peers = new Map()

    // High-water mark: peers whose manifest verified AT SOME POINT in this
    // session. `peers` only has the ones connected right now, and Phase 2's
    // DoD is "manifests were discovered and exchanged and verified" — an
    // event, not a state. Without this, a node that runs a few seconds longer
    // than the other reports zero peers and the runbook's gate falsely fails.
    this.everVerified = new Set()

    // D7: the number missing from NOTES.md. Measured as join -> first
    // connection, and join -> first verified manifest, which are different
    // things: the second is the one that counts for Phase 2's DoD.
    this.joinedAt = null
    this.firstPeerMs = null
    this.firstManifestMs = null

    this._statusTimer = null
    this._manifest = null

    // The side that SERVES (provider.mjs). Only `serve --swarm` sets this;
    // with it null the node announces and consumes but doesn't handle
    // chat:request.
    this.provider = null

    // The side that CONSUMES: requestId -> handlers for the in-flight request.
    this._chats = new Map()
    this._chatSeq = 0

    // `qvac/task/v0` (software factory). Listeners get every `task:*` message
    // from a verified peer and branch on `msg.type` themselves: the coordinator
    // side handles accept/progress/result, the `--accept-tasks` side handles
    // assign, and a node doing both registers both. A Set, not one slot,
    // because those two subsystems are independent.
    this._taskListeners = new Set()
  }

  setProvider(provider) {
    this.provider = provider
  }

  // fn(peer, msg, reply) where peer is { key, manifest }, msg is the raw
  // `task:*` object, reply(out) sends `out` back over this same channel.
  // Returns an unsubscribe function.
  addTaskListener(fn) {
    this._taskListeners.add(fn)
    return () => this._taskListeners.delete(fn)
  }

  // Send a `task:*` message to a verified peer by hex key. Returns false if
  // that peer is not connected (or never sent a manifest) — the caller decides
  // whether to place the ticket elsewhere.
  sendTask(peerKey, msg) {
    const peer = this.peers.get(peerKey)
    if (!peer || !peer.manifest) return false
    this._send(peer, msg)
    return true
  }

  // Changes node-level metadata (node-wide tags, or the whole `models` array
  // — displayName/maxConcurrentRequests/modelId are PER-MODEL fields in that
  // array, see manifest.mjs buildManifest) and re-announces to peers that are
  // ALREADY connected, not just ones that connect later.
  //
  // La identidad NO cambia -- es la misma clave de siempre, solo se re-firma
  // contenido nuevo con `this.identity.secretKey`. Quien llama (gateway.mjs)
  // es quien arma el array `models` con el campo que cambio ya mergeado, y
  // quien decide si un cambio de modelo tiene que esperar a que
  // `Provider._ensureModel` termine de cargar antes de llegar aca: este
  // metodo asume que `models` ya es lo que hay que anunciar, no dispara
  // ninguna carga por su cuenta.
  updateAnnouncement({ tags, models, economic } = {}) {
    if (tags !== undefined) this.tags = tags
    if (models !== undefined) this.models = models
    // Fase 11 — el bloque `economic` cambia cuando la wallet se crea DESPUES
    // del join (onboarding desde el panel). `manifest()` lo lee fresco al
    // re-armar, asi que alcanza con dejarlo aca antes de invalidar la cache.
    if (economic !== undefined) this.economic = economic

    this._manifest = null // forces a re-sign on the next manifest()
    const fresh = this.manifest()

    for (const peer of this.peers.values()) {
      this._send(peer, { type: 'manifest:announce', manifest: fresh })
    }

    return fresh
  }

  // The manifest is built and signed ONCE per session: `publishedAt` doesn't
  // need to change on every announcement, and signing is the most expensive
  // step on this path.
  manifest() {
    if (!this._manifest) {
      this._manifest = signManifest(
        buildManifest({
          publicKey: this.identity.publicKey,
          models: this.models,
          operator: this.operator,
          tags: this.tags,
          // The schema's `directory` field stops being a mock (D2) once
          // there's a real Hyperbee behind it: the key signed here is the
          // one the peer uses to replicate it.
          directory: this.directory ? this.directory.descriptor() : null,
          // And the `economic` field stops being one once the node has a
          // wallet (Phase 7). It's what ties the NETWORK identity — the one
          // that signs this — to the PAYOUT identity: a peer that verifies
          // the signature knows THIS node declared THAT address.
          economic: this.economic
        }),
        this.identity.secretKey
      )
    }
    return this._manifest
  }

  async join() {
    // The swarm's identity IS the manifest's: the `publicKey` that signs is
    // the same one Hyperswarm presents itself with. Without this,
    // verifyManifest can't tie the signature to the socket's peer, and the
    // signature doesn't prove identity (see the long note in manifest.mjs).
    this.swarm = new Hyperswarm({ keyPair: this.identity })

    this.swarm.on('connection', (socket, info) => this._onConnection(socket, info))

    const discovery = this.swarm.join(TOPIC, { client: true, server: true })
    this.joinedAt = Date.now()

    // `flushed()` resolves once the topic is announced on the DHT, not once
    // there are peers. Still worth waiting for: without this, a `join()`
    // followed by an immediate exit never gets announced at all.
    await discovery.flushed()

    return {
      publicKey: this.identity.publicKey.toString('hex'),
      topic: TOPIC.toString('hex')
    }
  }

  _onConnection(socket, info) {
    const key = info.publicKey.toString('hex')

    // ORDER MATTERS. `attachMux` puts the multiplexer on `socket.userData`
    // BEFORE anyone else touches it. `corestore.replicate` looks for one
    // there and, if it doesn't find one, creates its own: two multiplexers
    // writing frames onto the same stream break the connection in a way that
    // from the outside reads as "the network dropped." See channel.mjs's
    // header.
    attachMux(socket)

    // Directory and drive replication over the SAME socket. Corestore serves
    // whatever it has by discoveryKey (`ondiscoverykey`), so this is enough
    // for a peer to download a file published by this node without opening
    // any new connection.
    if (this.corestore) this.corestore.replicate(socket)

    // The 16 MiB per-frame cap that `bits: 24` used to give isn't lost by
    // removing FramedStream: NoiseSecretStream caps at
    // MAX_ATOMIC_WRITE = 0xffffff, the same 16 MiB, and does it one layer
    // lower — before Protomux even gets to reserve anything. The topic is
    // public and comes from the code, so anyone can send that frame; the
    // manifest is ~2 KB and chat is capped at 32000 chars by
    // Provider._validate.
    // The peer object is declared BEFORE opening the channel so `onmessage`
    // doesn't capture a binding in a dead zone: protomux never delivers
    // anything synchronously, but relying on that is a trap waiting for
    // someone.
    const peer = { channel: null, socket, manifest: null, status: null, key, filesKey: null }

    const chan = openChannel(socket, {
      onmessage: (msg) => this._onMessage(peer, msg)
    })

    if (chan === null) {
      // There was already a control channel on this socket. That's a program
      // bug, not a network condition: better to cut it than to keep a mute
      // peer around.
      console.error(`[swarm] duplicate channel with ${key.slice(0, 8)}…, dropping`)
      socket.destroy()
      return
    }

    peer.channel = chan
    this.peers.set(key, peer)

    if (this.firstPeerMs === null && this.joinedAt !== null) {
      this.firstPeerMs = Date.now() - this.joinedAt
      console.log(`[swarm] first peer at ${this.firstPeerMs}ms (D7)`)
      // Into the trail too, not just the console: the D7 number used to be
      // measured once per session and died with the terminal's scrollback.
      // The bee keeps the series, which is what lets you see that discovery
      // takes ~17s on this network and 2s on another, instead of just
      // remembering it.
      this._logEvento('peer_first', `first peer at ${this.firstPeerMs}ms`, this.firstPeerMs)
    }

    console.log(`[swarm] connected ${key.slice(0, 8)}… (${this.peers.size} peer(s))`)

    // A socket with no 'error' handler throws an uncaught exception that
    // takes down the whole process. A peer leaving closes the socket in a
    // thousand ugly ways, and none of them justify killing a node that's
    // serving requests.
    socket.on('error', (err) => {
      console.log(`[swarm] socket ${key.slice(0, 8)}… down: ${(err && err.message) || err}`)
    })
    const handshake = setTimeout(() => {
      if (!peer.manifest) {
        console.log(`[swarm] ${key.slice(0, 8)}… didn't send a manifest, dropping`)
        socket.destroy()
      }
    }, HANDSHAKE_TIMEOUT_MS)
    handshake.unref?.()

    socket.on('close', () => {
      clearTimeout(handshake)

      // If there's already a NEWER connection with this same peer, this
      // 'close' belongs to the old one and shouldn't touch anything.
      // `peers` is indexed by key, so the new connection already overwrote
      // the entry: deleting here would leave a ghost peer — channel alive
      // but invisible to the gateway, its marketplace rows deleted, and its
      // in-flight requests cancelled by cancelByPeer. Happens on any fast
      // reconnect and in Hyperswarm's client/server tie-break race, and from
      // the outside it reads as "the network dropped."
      if (this.peers.get(key) !== peer) return

      this.peers.delete(key)
      // D3: the candidate dies with the socket, without waiting for any expiresAt.
      if (this.store && peer.manifest) this.store.removeByPeer(key)
      // Without this, `sessions` in the directory stays stuck at 1 forever
      // (see the long note in directory.mjs, recordDisconnect).
      if (this.directory && peer.manifest) this.directory.recordDisconnect(key)
      // Same rule: a node this process never validated was never counted as
      // "online" in the first place, so there's nothing to flip here.
      if (this.networkStats && peer.manifest) this.networkStats.disconnectPeer(key)

      // In-flight chats against this peer CANNOT keep waiting for a chunk
      // that will never arrive: the HTTP client on the other end would hang
      // forever. They get told here, and on the gateway's side D4 decides
      // whether to retry (only if it hasn't already sent anything to the
      // client).
      for (const [requestId, chat] of this._chats) {
        if (chat.peerKey !== key) continue
        if (chat._graceTimer) clearTimeout(chat._graceTimer)
        this._chats.delete(requestId)
        chat.onError('el par se desconecto a mitad del request', 'peer_gone')
      }

      // And whatever this node was generating FOR that peer gets cut: still
      // spending CPU on tokens with nowhere to go is exactly what
      // chat:cancel prevents in the normal case.
      if (this.provider) this.provider.cancelByPeer(key)

      console.log(`[swarm] disconnected ${key.slice(0, 8)}… (${this.peers.size} peer(s))`)
      this.onPeerChange(this.peers)
    })

    // Announces first, without waiting for the other side: both sides do the
    // same thing and the handshake has no turns that could get stuck.
    this._send(peer, { type: 'manifest:announce', manifest: this.manifest() })
    this._sendStatus(peer)

    // The drive key goes AFTER the manifest and in its own message: the v0
    // schema is frozen with `additionalProperties: false`, so there's no
    // field in the manifest to put it in without breaking validation. It
    // travels over the Noise channel, which already authenticated the peer,
    // with the same level of trust as `node:status` — attributable, not
    // signed. See files.mjs.
    if (this.files) this._send(peer, { type: 'files:announce', driveKey: this.files.keyHex })

    // Same reasoning as files:announce right above: the frozen schema has no
    // field for software version or OS, so this rides its own message,
    // unsigned, attributable over the already-authenticated Noise channel,
    // sent once per connection (version/platform don't change mid-session).
    if (this.nodeInfo) {
      this._send(peer, {
        type: 'node:info',
        version: this.nodeInfo.version || null,
        platform: this.nodeInfo.platform || null
      })
    }
  }

  _send(peer, msg) {
    if (!peer.channel) return
    peer.channel.send(msg)
  }

  _sendStatus(peer) {
    // With no gateway running (the `peers` command) there's no real load to
    // report, but the declared CAPACITY does exist: it's the manifest's.
    // Sending 0/0 would make the other side show "zero capacity," which
    // isn't what's happening.
    const status = this.store
      ? this.store.localLoad()
      : {
          activeRequests: 0,
          maxConcurrentRequests: this.models.reduce(
            (n, m) => n + (Number.isFinite(m.maxConcurrentRequests) ? m.maxConcurrentRequests : 0),
            0
          )
        }
    this._send(peer, { type: 'node:status', ...status })
  }

  // The channel calls this for every message, ALREADY decoded (protomux does
  // the JSON.parse with the `c.json` encoding). Everything inside is
  // wrapped: an exception that escapes bubbles up to protomux's onmessage
  // and takes down the channel with that peer — not just this request, the
  // whole channel, for every request that comes after. The peer stays
  // "connected" in the table and its chat:request messages never arrive
  // again: a failure mode that's very hard to read from the outside.
  //
  // Garbage from another app landing on the same topic no longer reaches
  // here: without opening the `qvac/node/v0` channel there's nowhere to
  // deliver it to, which used to happen with FramedStream over the raw
  // socket.
  // Swarm events go into the SAME trail as routing, distinguished by `kind`.
  // They could have gone to a separate log, but then reconstructing "the
  // node joined, took 17s to see a peer, and the first chat paid 12s of
  // model load" would mean cross-referencing two series by hand — exactly
  // what the trail is supposed to avoid. `store` is optional (the `peers`
  // command runs without it), so this can't assume it exists.
  _logEvento(kind, reason, ms) {
    if (!this.store || typeof this.store.pushLog !== 'function') return
    try {
      this.store.pushLog({ kind, operator: this.operator, reason, ms, ok: true })
    } catch {
      // The trail can never take down the swarm: if the bee fails to write,
      // one log line is lost, not the connection to the peer.
    }
  }

  _onMessage(peer, msg) {
    try {
      this._dispatch(peer, msg)
    } catch (err) {
      console.error(
        `[swarm] handler for ${peer.key.slice(0, 8)}… threw an exception: ${(err && err.message) || err}`
      )
    }
  }

  _dispatch(peer, msg) {
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'manifest:announce') {
      // The manifest is verified by TYING it to the socket's key. Without
      // expectedPublicKey, anyone could sign a manifest claiming to be from
      // another node and the signature would verify perfectly without
      // proving anything.
      const res = verifyManifest(msg.manifest, { expectedPublicKey: peer.key })
      if (!res.ok) {
        console.log(`[swarm] manifest rejected from ${peer.key.slice(0, 8)}…: ${res.reason}`)
        return
      }

      // Computed BEFORE the assignment below: `peer.manifest` is still null
      // the first time this socket's handshake completes, and already set
      // on every later re-announce (`updateAnnouncement` re-sends the
      // manifest to already-connected peers when tags/models change,
      // without a new socket). That's the exact signal network-stats needs
      // to count a CONNECTION once, not once per announcement.
      const esConexionNueva = !peer.manifest

      peer.manifest = msg.manifest
      this.everVerified.add(peer.key)

      if (this.firstManifestMs === null && this.joinedAt !== null) {
        this.firstManifestMs = Date.now() - this.joinedAt
        console.log(`[swarm] first VERIFIED manifest at ${this.firstManifestMs}ms (D7)`)
        this._logEvento(
          'manifest_verified',
          `first verified manifest at ${this.firstManifestMs}ms`,
          this.firstManifestMs
        )
      }

      const modelos = msg.manifest.models.map((m) => m.modelId).join(', ')
      const op = (msg.manifest.metadata && msg.manifest.metadata.operator) || '?'
      console.log(`[swarm] manifest OK from ${op} (${peer.key.slice(0, 8)}…): ${modelos}`)

      if (this.store) this.store.upsertFromManifest(peer.key, msg.manifest)

      // Goes to the directory with origin 'socket': this manifest DID prove
      // identity against the connection's key. Replicating it later to
      // another node doesn't transfer that property — see directory.mjs.
      if (this.directory) this.directory.recordManifest(peer.key, msg.manifest)

      if (this.networkStats) {
        this.networkStats.observePeer({
          publicKey: peer.key,
          manifest: msg.manifest,
          timestamp: Date.now(),
          newConnection: esConexionNueva
        })
      }

      this.onPeerChange(this.peers)
      return
    }

    if (msg.type === 'node:info') {
      // Same rule as node:status and files:announce: nothing from a
      // stranger who hasn't proven who it is gets recorded.
      if (!peer.manifest) return
      if (this.networkStats) {
        this.networkStats.observePeer({
          publicKey: peer.key,
          version: typeof msg.version === 'string' ? msg.version : null,
          platform: typeof msg.platform === 'string' ? msg.platform : null,
          timestamp: Date.now()
          // newConnection stays false (default): manifest:announce already
          // counted this connection earlier in the same handshake.
        })
      }
      return
    }

    if (msg.type === 'files:announce') {
      // Same rule as node:status: with no verified manifest, nothing is
      // accepted from a stranger, not even a drive key.
      if (!peer.manifest) return
      if (typeof msg.driveKey !== 'string' || !/^[0-9a-f]{64}$/.test(msg.driveKey)) return

      peer.filesKey = msg.driveKey
      if (this.directory) this.directory.recordFilesKey(peer.key, msg.driveKey)
      console.log(
        `[swarm] ${peer.key.slice(0, 8)}… publishes files at ${msg.driveKey.slice(0, 8)}…`
      )
      this.onPeerChange(this.peers)
      return
    }

    if (msg.type === 'node:status') {
      // A status from a peer that hasn't proven who it is doesn't get
      // accepted: that would mean letting a stranger write into the
      // candidates table.
      if (!peer.manifest) return
      peer.status = {
        activeRequests: msg.activeRequests,
        maxConcurrentRequests: msg.maxConcurrentRequests
      }
      if (this.store) this.store.updateStatus(peer.key, peer.status)
      this.onPeerChange(this.peers)
      return
    }

    // --- software factory (qvac/task/v0) ---
    // A peer that has not proved who it is cannot assign work to this node or
    // receive results from it — same rule as chat:request.
    if (msg.type.startsWith('task:')) {
      if (!peer.manifest) return
      const wrapped = { key: peer.key, manifest: peer.manifest }
      const reply = (out) => this._send(peer, out)
      for (const fn of this._taskListeners) {
        try {
          fn(wrapped, msg, reply)
        } catch (err) {
          console.error(
            `[swarm] task listener threw on ${msg.type} from ${peer.key.slice(0, 8)}…: ` +
              `${(err && err.message) || err}`
          )
        }
      }
      return
    }

    // --- provider side ---
    if (this.provider && this.provider.handles(msg.type)) {
      // A peer that hasn't completed the handshake can't request inference:
      // that would be handing out CPU to a stranger who never said who they
      // are.
      if (!peer.manifest) return
      this.provider.onMessage(peer, msg, (out) => this._send(peer, out))
      return
    }

    // --- consumer side ---
    if (msg.type.startsWith('chat:')) {
      const chat = this._chats.get(msg.requestId)
      // A response for a request that no longer exists (cancelled, or from
      // another peer pretending to still be around). Ignored: there's no one
      // to deliver it to.
      if (!chat || chat.peerKey !== peer.key) return

      if (msg.type === 'chat:accepted') chat.onAccepted()
      else if (msg.type === 'chat:chunk') chat.onChunk(msg.delta)
      else if (msg.type === 'chat:done') {
        // PHASE 10 / D27 case 1 — if `cancelChat` left the chat alive waiting
        // for this late `chat:done`, its grace window gets cut short: it
        // already arrived.
        if (chat._graceTimer) clearTimeout(chat._graceTimer)
        this._chats.delete(msg.requestId)
        // PHASE 10 — `chat:done` can carry the signed D24 attestation from the
        // peer. Passed through as-is: the gateway verifies it and decides.
        chat.onDone({
          attestation: msg.attestation || null,
          attestationMissing: msg.attestationMissing || null
        })
      } else if (msg.type === 'chat:error') {
        if (chat._graceTimer) clearTimeout(chat._graceTimer)
        this._chats.delete(msg.requestId)
        chat.onError(msg.message || 'error sin motivo', msg.code || null)
      }
    }
  }

  // Opens a chat against a peer. Returns the requestId so it can be
  // cancelled. The handlers are callbacks and not a promise because this is
  // a stream: what matters is each chunk as it arrives, not the final
  // result.
  chatRequest(peerKey, { model, messages, payment = null, maxTokens = 0 }, handlers) {
    const peer = this.peers.get(peerKey)
    if (!peer || !peer.manifest) {
      handlers.onError('el par ya no esta conectado', 'peer_gone')
      return null
    }

    const requestId = `r${Date.now().toString(36)}${(this._chatSeq++).toString(36)}`
    this._chats.set(requestId, { peerKey, ...handlers })
    this._send(peer, {
      type: 'chat:request',
      requestId,
      model,
      messages,
      stream: true,
      // PHASE 10 — the client's payment is forwarded so the peer can charge
      // it, and the 402's cap so it can cut off generation at the same point
      // it attests. Absent when the request didn't come from a paid path
      // (free quota).
      ...(payment ? { payment } : {}),
      ...(maxTokens > 0 ? { maxTokens } : {})
    })
    return requestId
  }

  cancelChat(requestId) {
    const chat = this._chats.get(requestId)
    if (!chat) return
    const peer = this.peers.get(chat.peerKey)
    // If the peer already left there's no one to tell, and its own process
    // has already cut things off on its own.
    if (peer) this._send(peer, { type: 'chat:cancel', requestId })

    // PHASE 10 / D27 case 1 — the chat is NOT deleted on the spot. The peer
    // can still send a late `chat:done` with the PARTIAL attestation of what
    // it managed to serve (it charges for that prefix), and that artifact has
    // to reach the routed trail. It's marked cancelled and given a short
    // window: if `chat:done` doesn't arrive, it's cleaned up and `onDone` is
    // invoked anyway with the reason, so the absence gets STATED instead of
    // showing up green. With no peer to notify, there's no `chat:done` to
    // wait for: it closes right away.
    if (chat.cancelado) return
    chat.cancelado = true
    if (!peer) {
      this._chats.delete(requestId)
      chat.onDone({
        attestation: null,
        attestationMissing: 'el par ya no estaba conectado al cortar el cliente'
      })
      return
    }
    chat._graceTimer = setTimeout(() => {
      if (this._chats.get(requestId) !== chat) return
      this._chats.delete(requestId)
      chat.onDone({
        attestation: null,
        attestationMissing: 'el par no devolvio un chat:done tras el chat:cancel'
      })
    }, CHAT_CANCEL_GRACE_MS)
    chat._graceTimer.unref?.()
  }

  startStatusBroadcast(intervalMs = STATUS_INTERVAL_MS) {
    this.stopStatusBroadcast()
    this._statusTimer = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (peer.manifest) this._sendStatus(peer)
      }
    }, intervalMs)
    this._statusTimer.unref?.()
  }

  stopStatusBroadcast() {
    if (this._statusTimer) clearInterval(this._statusTimer)
    this._statusTimer = null
  }

  // Those that completed the handshake. This is the count that matters for
  // the DoD: "connected" isn't the same as "verified."
  verifiedPeers() {
    return [...this.peers.values()].filter((p) => p.manifest)
  }

  // Connected peers that announced a drive. This is the list of "who can I
  // ask for a file RIGHT NOW": ones that are in the directory but not
  // connected don't count, for the same reason they aren't routing
  // candidates.
  peersWithFiles() {
    return this.verifiedPeers()
      .filter((p) => p.filesKey)
      .map((p) => ({
        peerKey: p.key,
        driveKey: p.filesKey,
        operator: (p.manifest.metadata && p.manifest.metadata.operator) || 'Remote node'
      }))
  }

  timings() {
    return {
      joinToFirstPeerMs: this.firstPeerMs,
      joinToFirstManifestMs: this.firstManifestMs,
      peers: this.peers.size,
      verified: this.verifiedPeers().length,
      verifiedEver: this.everVerified.size
    }
  }

  async destroy() {
    this.stopStatusBroadcast()

    // Belt-and-suspenders: don't rely solely on each socket's 'close' event
    // firing in time during shutdown. disconnectPeer is idempotent, so
    // calling it here and again from 'close' (if it still fires) is safe.
    if (this.networkStats) {
      for (const peer of this.peers.values()) {
        if (peer.manifest) this.networkStats.disconnectPeer(peer.key)
      }
    }

    // Channels close before the swarm. The other way around,
    // `swarm.destroy()` breaks the socket underneath the multiplexer and
    // protomux emits the close event over an already-dead stream.
    for (const peer of this.peers.values()) {
      if (peer.channel) peer.channel.close()
    }

    if (this.swarm) await this.swarm.destroy()
    this.peers.clear()
  }
}
