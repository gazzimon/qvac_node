// The marketplace directory: a Hyperbee over the node's Corestore.
//
// Solves two things that don't exist today:
//
//  1. PERSISTENCE. `store.mjs` is an in-memory Map and resets on every
//     restart. That's fine for a demo; not for a marketplace: with no
//     history there's no reputation, and with no reputation routing can't
//     pick based on anything but arrival order.
//
//  2. DISCOVERY WITHOUT SIMULTANEITY. Today two nodes only know each other if
//     they're both online AT THE SAME TIME: the manifest gets exchanged in
//     the handshake and dies with the socket. This Hyperbee replicates
//     between peers, so connecting to ONE peer is enough to learn about
//     every peer that peer has seen.
//
// WHY IT'S SAFE TO RELAY A THIRD PARTY'S MANIFEST
//
// The manifest already comes signed by whoever issued it, so whoever receives
// it secondhand verifies it just the same, without trusting the middleman.
// The only thing the middleman can do is NOT pass it along, or offer a stale
// one. It can't make one up.
//
// WHAT A RELAYED MANIFEST **DOES NOT** PROVE -- and this needs to be clear:
//
//   `verifyManifest` ties the signature to the socket's key
//   (`expectedPublicKey`). A manifest coming out of the bee has no socket:
//   verifying it against the key it declares itself is a tautology. It proves
//   "the owner of K said this at some point", NOT "K is alive right now".
//
//   That's why directory entries enter the registry as KNOWN, not as routing
//   candidates. D3 still stands with no exceptions: a candidate is born and
//   dies with its socket. The directory is a phone book, not a liveness
//   signal.
//
// KEY LAYOUT (lexicographic order IS the index: Hyperbee has no other, and a
// remote `get` only pulls the ~log(n) blocks along the path):
//
//   peer/<peerKey>              -> { manifest, firstSeen, lastSeen, sessions, filesKey }
//   model/<modelId>/<peerKey>   -> { displayName, operator, pricing, maxConcurrentRequests }
//   stat/<peerKey>              -> { requests, errors, tokens, lastMs, lastAt }
//   log/<ts padded>/<seq>       -> routing entry
//
// `model/...` is a hand-built secondary index: without it, "who serves
// llama1b" would require scanning every `peer/`.

import Hyperbee from 'hyperbee'

// The log grows forever if nobody prunes it. The core still keeps the old
// blocks (it's append-only), but the VIEW stays bounded and startup doesn't
// have to scan through months of history.
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Fixed width so the key's lexicographic order matches chronological order.
// `String(Date.now())` is already 13 digits; 16 leaves plenty of margin and
// avoids reordering history the day the width changes.
function tsKey(ts) {
  return String(ts).padStart(16, '0')
}

// The character after '/' in ASCII is '0'. `gte: 'peer/'` + `lt: 'peer0'`
// closes the prefix without having to build a weird sentinel key.
function prefixRange(prefix, extra = {}) {
  return { gte: prefix + '/', lt: prefix + '0', ...extra }
}

export class Directory {
  constructor(corestore, { name = 'directory' } = {}) {
    this.core = corestore.get({ name })
    this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    this.opened = false
    this._seq = 0

    // One-way queue. Writes come in from `store.mjs`, which is synchronous
    // and can't wait on disk: if every `upsertFromManifest` had to await a
    // put, the swarm handler would have to become async and a slow disk
    // would stall the handshake. They get queued and forgotten.
    this._tail = Promise.resolve()
    this._errors = 0
  }

  async ready() {
    if (this.opened) return this
    await this.bee.ready()
    this.opened = true
    return this
  }

  get key() {
    return this.core.key
  }

  get keyHex() {
    return this.core.key.toString('hex')
  }

  get discoveryKeyHex() {
    return this.core.discoveryKey.toString('hex')
  }

  get version() {
    return this.bee.version
  }

  // What goes in the `directory` field of the signed manifest. That field
  // used to be mocked (DIRECTORY_MOCK in manifest.mjs, ROADMAP's D2): with
  // this it becomes real, and the frozen schema already had the exact spot
  // for it.
  descriptor() {
    return {
      writerPublicKey: this.keyHex,
      discoveryKey: this.discoveryKeyHex,
      sequence: this.version
    }
  }

  // Queues a write. Deliberately doesn't return the result: the caller is
  // synchronous hot-path code and has nothing to do with it.
  _write(fn) {
    this._tail = this._tail.then(fn).catch((err) => {
      // A directory that can't write does NOT bring the node down: it keeps
      // serving inference with the in-memory registry. Logged once every 20
      // failures so it doesn't flood the terminal if the disk is full.
      if (this._errors++ % 20 === 0) {
        console.error('[directory] could not write: ' + ((err && err.message) || err))
      }
    })
    return this._tail
  }

  // Waits for the queue to drain. For tests and for a clean shutdown.
  flush() {
    return this._tail
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  // A VERIFIED manifest from a peer. `origin` tells where it came from:
  // 'socket' = direct handshake with that peer; 'gossip' = came replicated
  // from a third party's directory. The distinction is kept because it
  // changes what the entry proves (see the long note in the header).
  recordManifest(peerKey, manifest, { origin = 'socket', now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      const prev = found ? found.value : null

      // A new session is a RECONNECTION, not a re-announcement: the same peer
      // re-announces its manifest every time it connects, and counting every
      // announcement as a session would make the number measure traffic
      // instead of presence.
      const nuevaSesion = origin === 'socket' && (!prev || prev.lastOrigin !== 'socket')

      const entry = {
        peerKey,
        manifest,
        lastOrigin: origin,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now,
        sessions: (prev ? prev.sessions : 0) + (nuevaSesion ? 1 : 0),
        filesKey: prev ? prev.filesKey : null
      }

      const batch = this.bee.batch()
      await batch.put('peer/' + peerKey, entry)

      // The per-model index gets REBUILT, not appended on top. A peer that
      // re-announces with fewer models -- because it dropped one, or ran out
      // of VRAM -- would leave its old row indexed forever, and the panel
      // would keep saying someone serves something nobody serves anymore.
      //
      // The old keys come from the previous manifest, not from a scan of the
      // `model/` prefix: the peerKey is the LAST segment of that key, so
      // looking up "this peer's entries" would require scanning the entire
      // index.
      const modelosViejos = (prev && prev.manifest && prev.manifest.models) || []
      for (const m of modelosViejos) await batch.del('model/' + m.modelId + '/' + peerKey)

      const operator =
        (manifest && manifest.metadata && manifest.metadata.operator) || 'Nodo remoto'
      for (const m of (manifest && manifest.models) || []) {
        await batch.put('model/' + m.modelId + '/' + peerKey, {
          peerKey,
          modelId: m.modelId,
          displayName: m.displayName || m.modelId,
          operator,
          pricing: m.pricing || [],
          maxConcurrentRequests: (m.qos && m.qos.maxConcurrentRequests) || 1,
          lastSeen: now
        })
      }
      await batch.flush()
    })
  }

  // Called when a peer's socket drops (swarm.mjs, 'close' event).
  //
  // Without this, `sessions` never goes above 1: `recordManifest` only counts
  // a new session when `lastOrigin` wasn't already 'socket', but nothing ever
  // set it back to something else on disconnect -- a real reconnection would
  // arrive with origin='socket' again over a `lastOrigin` that was already
  // 'socket', and the counter would read as "presence" when it actually
  // measured "announced itself once, for the whole life of the process".
  recordDisconnect(peerKey, { now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      if (!found) return
      await this.bee.put('peer/' + peerKey, { ...found.value, lastOrigin: 'disconnected', lastSeen: now })
    })
  }

  // A peer's Hyperdrive key. It doesn't go in the manifest because the frozen
  // schema has `additionalProperties: false` on `node` and there's no field
  // to put it in without breaking it. It arrives via `files:announce`, which
  // travels over the already-authenticated Noise channel: attributable to the
  // peer (same trust class as `node:status`), but NOT signed.
  recordFilesKey(peerKey, filesKey, { now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      if (!found) return // haven't verified its manifest yet: nothing to tie it to
      await this.bee.put('peer/' + peerKey, { ...found.value, filesKey, lastSeen: now })
    })
  }

  recordSeen(peerKey, { now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      if (!found) return
      await this.bee.put('peer/' + peerKey, { ...found.value, lastSeen: now })
    })
  }

  // Per-peer counters. It's the raw material of reputation: today they just
  // accumulate. Whether routing uses them to rank candidates is a separate
  // decision (ROADMAP's D6), not made here.
  recordStat(peerKey, { ok = true, ms = null, tokens = 0, now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('stat/' + peerKey)
      const prev = found
        ? found.value
        : { requests: 0, errors: 0, tokens: 0, lastMs: null, lastAt: null }

      await this.bee.put('stat/' + peerKey, {
        requests: prev.requests + 1,
        errors: prev.errors + (ok ? 0 : 1),
        tokens: prev.tokens + (Number.isFinite(tokens) ? tokens : 0),
        lastMs: Number.isFinite(ms) ? ms : prev.lastMs,
        lastAt: now
      })
    })
  }

  pushLog(entry, { now = Date.now() } = {}) {
    const seq = this._seq++
    return this._write(() => this.bee.put('log/' + tsKey(now) + '/' + seq, { ts: now, ...entry }))
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async knownPeers({ limit = 200 } = {}) {
    const out = []
    for await (const { value } of this.bee.createReadStream(prefixRange('peer', { limit }))) {
      out.push(value)
    }
    return out
  }

  async peer(peerKey) {
    const found = await this.bee.get('peer/' + peerKey)
    return found ? found.value : null
  }

  async stats(peerKey) {
    const found = await this.bee.get('stat/' + peerKey)
    return found ? found.value : null
  }

  // Every peer that EVER announced this model, whether or not they're
  // connected right now. Routing does NOT use this (see the header); it's
  // here so the panel can say "4 nodes serve llama1b, 1 online".
  async providersOf(modelId, { limit = 100 } = {}) {
    const out = []
    for await (const { value } of this.bee.createReadStream(
      prefixRange('model/' + modelId, { limit })
    )) {
      out.push(value)
    }
    return out
  }

  async recentLog(limit = 30) {
    const out = []
    for await (const { value } of this.bee.createReadStream(
      prefixRange('log', { reverse: true, limit })
    )) {
      out.push(value)
    }
    return out
  }

  // -------------------------------------------------------------------------

  async pruneLog({ ttlMs = LOG_TTL_MS, now = Date.now() } = {}) {
    const corte = 'log/' + tsKey(now - ttlMs)
    const viejas = []
    for await (const { key } of this.bee.createReadStream({ gte: 'log/', lt: corte })) {
      viejas.push(key)
    }
    if (viejas.length === 0) return 0

    const batch = this.bee.batch()
    for (const k of viejas) await batch.del(k)
    await batch.flush()
    return viejas.length
  }

  async close() {
    await this.flush()
    await this.bee.close()
  }
}
