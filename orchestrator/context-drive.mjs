// The context tree: the code a worker edits against, published by the
// coordinator as a read-only Hyperdrive and read by the worker sparsely, by
// path.
//
// -----------------------------------------------------------------------------
// NO SEPARATE DHT ANNOUNCE
//
// The coordinator and the worker already hold an authenticated, holepunched
// connection, and that connection is ALREADY replicating a corestore
// (qvac/swarm.mjs calls `corestore.replicate(socket)` on every peer, and
// `ondiscoverykey` serves any core in the store on request). A drive created in
// that same corestore is reachable over that same connection with no
// `swarm.join`, no topic, and none of the tens-of-seconds discovery latency the
// DHT costs.
//
// So this module takes a corestore and, only when it has to bootstrap a
// connection of its own (the standalone coordinator, before it is folded into a
// node), an optional swarm. When a swarm is passed it bridges `findingPeers()`
// the way qvac/files.mjs does; when it is not, it assumes replication is
// already flowing and just waits for the drive's metadata to sync.
//
// SPARSE BY PATH is what makes this the right shape for a 40 MB tree: the
// worker opens four files and four files transfer. For a tree of a few MB a
// full `mirrorInto` over the same connection is simpler and no slower — the
// caller picks.
// -----------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import Hyperdrive from 'hyperdrive'

function drivePath(p) {
  const norm = String(p).replace(/\\/g, '/').replace(/\/+/g, '/')
  return norm.startsWith('/') ? norm : '/' + norm
}

// Walk a directory into a flat list of { rel, abs }. Skips the usual noise that
// a worker never needs to read and that would bloat the drive.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.qvac', '.hyperdrive'])
function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = path.join(dir, entry)
    const st = fs.statSync(abs)
    if (st.isDirectory()) out.push(...walk(abs, base))
    else if (st.isFile()) out.push({ rel: path.relative(base, abs), abs })
  }
  return out
}

// Publish `workspaceDir` as a fresh read-only-to-others Hyperdrive in `store`.
// Returns { drive, key } where `key` is the 64-hex string to put in
// `task:assign.contextDrive`.
export async function publishContext(store, workspaceDir) {
  const drive = new Hyperdrive(store.namespace('context-' + Date.now().toString(36)))
  await drive.ready()

  for (const f of walk(workspaceDir)) {
    await drive.put(drivePath(f.rel), fs.readFileSync(f.abs))
  }

  return { drive, key: drive.key.toString('hex') }
}

// Re-publish into an existing context drive (a later batch working against a
// tree the previous batch changed). Only writes paths whose bytes differ, so
// the drive's version bumps by exactly what moved.
export async function updateContext(drive, workspaceDir) {
  let changed = 0
  for (const f of walk(workspaceDir)) {
    const key = drivePath(f.rel)
    const next = fs.readFileSync(f.abs)
    const cur = await drive.get(key)
    if (cur && cur.equals(next)) continue
    await drive.put(key, next)
    changed++
  }
  return changed
}

// Concurrent opens of the SAME key on the SAME store — one worker running two
// tasks that share a context drive, or a coordinator re-checking a result
// drive it already has open — deadlock inside Hyperdrive/corestore's own open
// path if each call starts a fresh session. Measured, not theoretical: two
// sessions racing to open one discovery key on one corestore hang in
// `drive.ready()` and never resolve or reject.
//
// `qvac/files.mjs` hits the identical problem and solves it with a `_remotes`
// cache keyed by hex — "abrir el mismo drive dos veces crea dos sesiones sobre
// los mismos cores". This is the same fix, reference-counted so several
// callers can share one open reader and the underlying session closes only
// once the last of them is done with it.
const _cachesByStore = new WeakMap()
function cacheFor(store) {
  let m = _cachesByStore.get(store)
  if (!m) {
    m = new Map()
    _cachesByStore.set(store, m)
  }
  return m
}

// Open the coordinator's context drive read-only. `swarm` is optional: pass it
// only when this side has no pre-existing replicated connection to the
// publisher (the standalone coordinator case). Returns a reader with
// `readFile`, `list`, `mirrorInto`, `close`. Safe to call more than once for
// the same key on the same store — callers each get their own handle onto one
// shared underlying drive, and it stays open until all of them have closed.
export async function openContext(store, keyHex, { swarm = null, timeoutMs = 30000 } = {}) {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('openContext: key must be 64 hex chars')

  const cache = cacheFor(store)
  let entry = cache.get(keyHex)
  if (!entry) {
    entry = { refs: 0, promise: _openOnce(store, keyHex, { swarm, timeoutMs }) }
    cache.set(keyHex, entry)
  }
  entry.refs++

  let shared
  try {
    shared = await entry.promise
  } catch (err) {
    entry.refs--
    if (entry.refs <= 0) cache.delete(keyHex)
    throw err
  }

  let released = false
  return {
    key: keyHex,
    version: shared.version,
    readFile: shared.readFile,
    list: shared.list,
    mirrorInto: shared.mirrorInto,
    async close() {
      if (released) return
      released = true
      entry.refs--
      if (entry.refs <= 0) {
        cache.delete(keyHex)
        await shared.closeReal()
      }
    }
  }
}

// The actual session + Hyperdrive open, run exactly once per (store, key) at a
// time — everything above this is just reference-counting around it.
async function _openOnce(store, keyHex, { swarm, timeoutMs }) {
  // A SESSION, not the shared store directly: `drive.close()` on a Hyperdrive
  // opened straight on `store` can cascade into closing `store` itself once
  // the last session drops, which would take the corestore the rest of this
  // node depends on down with it. A session's close is scoped to just that
  // session.
  const session = store.session()
  const drive = new Hyperdrive(session, Buffer.from(keyHex, 'hex'))
  await drive.ready()

  // Bridge peer discovery only if a swarm was handed in. Without it we rely on
  // replication that is already running over an existing socket.
  const done = drive.findingPeers()
  if (swarm) {
    swarm.join(drive.discoveryKey, { server: false, client: true })
    swarm.flush().then(done, done)
  } else {
    done()
  }

  // A core just opened by key has `length === 0` locally, and Hyperbee over a
  // zero-length core answers `null` to every get, in the act, with no error. So
  // the metadata has to sync before the first read or a file that exists on the
  // far side reads back as "not found" — a false negative that looks exactly
  // like a bad key.
  await withTimeout(
    drive.update({ wait: true }),
    timeoutMs,
    `context drive ${keyHex.slice(0, 12)}… did not sync in ${Math.round(timeoutMs / 1000)}s`
  )

  return {
    version: () => drive.version,

    // Sparse: this pulls exactly the one file's blocks, verified against the
    // drive's merkle root as they land.
    async readFile(p) {
      const buf = await drive.get(drivePath(p))
      if (buf == null) throw new Error(`context drive has no "${drivePath(p)}"`)
      return buf
    },

    async list(folder = '/') {
      const out = []
      for await (const e of drive.list(drivePath(folder), { recursive: true })) {
        out.push({ path: e.key, bytes: e.value?.blob?.byteLength || 0 })
      }
      return out
    },

    // Pull the whole tree to disk. The simple choice when the tree is small.
    async mirrorInto(destDir) {
      const written = []
      for await (const e of drive.list('/', { recursive: true })) {
        const buf = await drive.get(e.key)
        if (buf == null) continue
        const dest = path.join(destDir, ...e.key.replace(/^\//, '').split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, buf)
        written.push(e.key)
      }
      return written
    },

    async closeReal() {
      await drive.close()
      await session.close()
    }
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    if (t.unref) t.unref()
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (err) => {
        clearTimeout(t)
        reject(err)
      }
    )
  })
}
