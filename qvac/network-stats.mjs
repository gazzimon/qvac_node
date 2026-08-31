// Local network measurement: how many DISTINCT PyrusLLM nodes has this
// process observed, not how many connections it has handled.
//
// A "unique node" here means a cryptographic identity (the same hex public
// key that Hyperswarm hands back as `info.publicKey` and that signs the
// node's manifest) that completed the PyrusLLM handshake with a manifest
// that verified. Anything that connected to the topic but never produced a
// verified manifest never reaches this module at all -- `swarm.mjs` only
// calls in AFTER `verifyManifest` succeeded, the same gate that protects
// `store.upsertFromManifest` and `directory.recordManifest`.
//
// WHY A SEPARATE FILE INSTEAD OF REUSING `directory.mjs`
//
// `directory.mjs` already tracks `peer/<peerKey>` with firstSeen/lastSeen/
// sessions over a Hyperbee. Three things make it the wrong fit for this:
//
//   1. It's OPTIONAL and only exists when a Corestore was wired in (the bare
//      `peers` command runs without one). Network stats need to work in
//      that base case too.
//   2. It's DISTRIBUTED: entries replicate to other peers via gossip, and a
//      gossiped entry's `sessions` counter mixes in `origin` bookkeeping
//      that has nothing to do with a plain connection count.
//   3. The privacy requirement here is "stays on this machine" -- mixing it
//      into a structure designed to replicate would be the wrong default to
//      build on top of, even if today's caller never does.
//
// So this uses the OTHER pattern already in the project: a flat JSON file
// with atomic writes, same shape as budget.mjs/apikeys.mjs/wallet.mjs.
//
// WHY THE NODE ID IS THE RAW PUBLIC KEY, NOT A HASH OF IT
//
// The public key already travels in the clear to every peer on the topic --
// it's the whole point of it being *public*. Hashing it here would not add
// privacy (anyone who wanted to correlate it already has the preimage) and
// would break the ability to cross-reference this file against `store.mjs`,
// `directory.mjs` and `apikeys.mjs`, which all key on the same hex string
// already. No IP, hostname, MAC address or geolocation is ever stored here
// -- only the identity a node already announces to anyone who connects to
// it.
//
// WHAT THIS NUMBER IS NOT: "unique users". One operator can run many nodes,
// and one node can be restarted with a fresh identity if its `identity.json`
// is deleted. This counts distinct network identities THIS process has seen
// complete a handshake with, nothing more -- see getNetworkStats' callers
// for the exact wording used in the CLI output.

import fs from 'bare-fs'
import path from 'bare-path'

const VERSION = 1
const DEFAULT_MAX_NODES = 20000

const DIA_MS = 24 * 60 * 60 * 1000
const SEMANA_MS = 7 * DIA_MS
const MES_MS = 30 * DIA_MS

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/

let estado = null // { version, nodes: { [nodeId]: NodeRecord } }
let archivo = null // path to the JSON, or null if running in-memory only
let maxNodesConfigurado = DEFAULT_MAX_NODES

function estadoVacio() {
  return { version: VERSION, nodes: {} }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// Same atomic pattern as budget.mjs/apikeys.mjs: write to a temp file, then
// rename on top. A writeFileSync cut in half leaves an invalid JSON, and
// that would mean losing every node this process has ever seen.
function guardar() {
  if (!archivo) return
  const tmp = archivo + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2))
    fs.renameSync(tmp, archivo)
  } catch (err) {
    console.error(`[network-stats] could not save the registry: ${(err && err.message) || err}`)
    console.error('[network-stats] running IN MEMORY: it resets with the process')
    archivo = null
  }
}

// Pure read from disk, independent of the module's live state. For callers
// that want to inspect exactly what got persisted (tests, mostly) without
// going through open()'s online-reset sanitation below.
export function load(dir) {
  const ruta = path.join(dir, 'network-stats.json')
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'))
  } catch {
    return null
  }
}

// Exposed for callers that want to force a flush. Every mutating function
// below already calls this itself.
export function save() {
  guardar()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// `dir` null => everything in memory (tests, and any caller with no storage
// dir). Returns how many nodes were loaded and how many had a stale
// `online: true` corrected -- a process that starts up has no live sockets
// yet, so ANY node loaded as online is necessarily wrong (the previous
// process either shut down cleanly, in which case swarm.mjs's destroy()
// already called disconnectPeer for it, or it crashed, in which case
// nothing marked it offline). Either way the invariant on load is the same.
export function open(dir, { maxNodes = DEFAULT_MAX_NODES } = {}) {
  archivo = dir ? path.join(dir, 'network-stats.json') : null
  maxNodesConfigurado =
    Number.isFinite(maxNodes) && maxNodes > 0 ? Math.floor(maxNodes) : DEFAULT_MAX_NODES
  estado = estadoVacio()

  let loaded = 0
  let resettedOnline = 0

  if (archivo) {
    try {
      const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'))
      if (crudo && crudo.version === VERSION && crudo.nodes && typeof crudo.nodes === 'object') {
        estado.nodes = crudo.nodes
      } else if (crudo) {
        console.error(`[network-stats] ${archivo} is from another version, starting fresh`)
      }
    } catch {
      // Doesn't exist yet, or is corrupt: first boot either way. A node
      // registry that can't be read does NOT bring the node down -- it just
      // starts counting from zero, same posture as budget.mjs.
    }
  }

  for (const nodo of Object.values(estado.nodes)) {
    loaded++
    if (nodo.online) {
      nodo.online = false
      resettedOnline++
    }
  }

  if (resettedOnline > 0) guardar()

  return { loaded, resettedOnline }
}

export function close() {
  if (estado) guardar()
  estado = null
  archivo = null
}

// For tests: clean memory, no disk.
export function reset() {
  archivo = null
  estado = estadoVacio()
  maxNodesConfigurado = DEFAULT_MAX_NODES
}

function asegurarAbierto() {
  if (!estado) estado = estadoVacio()
  return estado
}

// Only called right before inserting a node that doesn't exist yet. Evicts
// the single oldest-by-lastSeen entry, which bounds how much disk a Sybil
// attacker can burn by minting fresh keypairs (free to generate) and
// handshaking once each: the registry never grows past `maxNodes`, it just
// forgets whoever has been quiet longest.
function evictarSiHaceFalta() {
  const ids = Object.keys(estado.nodes)
  if (ids.length < maxNodesConfigurado) return

  let peor = null
  for (const id of ids) {
    if (!peor || estado.nodes[id].lastSeen < estado.nodes[peor].lastSeen) peor = id
  }
  if (peor) delete estado.nodes[peor]
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// `swarm.mjs` is the only intended caller. It already ran `verifyManifest`
// before this: this function does NOT re-verify a signature, the same trust
// boundary `store.upsertFromManifest` and `directory.recordManifest` use.
//
// `newConnection` distinguishes "this socket just finished its handshake"
// from "this socket re-announced its manifest" (tags/models changed via
// `updateAnnouncement` without a new connection) or "this is the node:info
// side-channel filling in version/platform for a connection manifest:
// announce already counted". Only the first bumps `connections`.
//
// Returns { ok: true, nodeId } or { ok: false, reason }, never throws --
// same shape as verifyManifest/budget.reserve, so a caller can log why
// instead of just seeing a boolean.
export function observePeer({
  publicKey,
  manifest = null,
  timestamp = Date.now(),
  version = null,
  platform = null,
  newConnection = false
} = {}) {
  if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) {
    return { ok: false, reason: 'invalid publicKey' }
  }

  const s = asegurarAbierto()
  const nodeId = publicKey
  let nodo = s.nodes[nodeId]

  if (!nodo) {
    evictarSiHaceFalta()
    nodo = {
      nodeId,
      firstSeen: timestamp,
      lastSeen: timestamp,
      online: true,
      connections: 1,
      operator: null,
      modelIds: [],
      version: null,
      platform: null,
      lastDisconnectAt: null
    }
    s.nodes[nodeId] = nodo
  } else {
    nodo.online = true
    nodo.lastSeen = Math.max(nodo.lastSeen, timestamp)
    if (newConnection) nodo.connections += 1
  }

  // A manifest re-announced with fewer/different models REPLACES the old
  // list, same rule directory.mjs uses for its model index: a peer that
  // dropped a model shouldn't keep showing up as serving it forever.
  if (manifest) {
    nodo.operator = (manifest.metadata && manifest.metadata.operator) || nodo.operator
    nodo.modelIds = Array.isArray(manifest.models) ? manifest.models.map((m) => m.modelId) : []
  }

  // Pinned independently of `manifest`: this lets node:info (which has no
  // manifest at all) fill these in without wiping modelIds/operator with
  // null on the same call.
  if (version !== null) nodo.version = version
  if (platform !== null) nodo.platform = platform

  guardar()
  return { ok: true, nodeId }
}

// Called when a peer's socket drops. Silent no-op if the node was never
// observed (handshake never completed, or it was evicted under storage
// pressure) -- there's nothing to mark offline.
export function disconnectPeer(nodeId, { timestamp = Date.now() } = {}) {
  const s = asegurarAbierto()
  const nodo = s.nodes[nodeId]
  if (!nodo) return false

  nodo.online = false
  nodo.lastDisconnectAt = timestamp
  nodo.lastSeen = Math.max(nodo.lastSeen, timestamp)
  guardar()
  return true
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function getNode(nodeId) {
  const nodo = asegurarAbierto().nodes[nodeId]
  return nodo ? { ...nodo, modelIds: [...nodo.modelIds] } : null
}

export function listNodes() {
  return Object.values(asegurarAbierto().nodes)
    .map((n) => ({ ...n, modelIds: [...n.modelIds] }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
}

// Windows are computed HERE, on read, straight off `lastSeen` -- not kept as
// separate running counters. A counter that increments independently of
// `lastSeen` can drift out of sync with it; filtering the same field the
// windows are named after can't.
export function getNetworkStats({ now = Date.now() } = {}) {
  const nodos = Object.values(asegurarAbierto().nodes)

  let onlineNow = 0
  let uniqueSeen24h = 0
  let uniqueSeen7d = 0
  let uniqueSeen30d = 0
  const models = {}

  for (const nodo of nodos) {
    if (nodo.online) onlineNow++

    const edad = now - nodo.lastSeen
    if (edad <= DIA_MS) uniqueSeen24h++
    if (edad <= SEMANA_MS) uniqueSeen7d++
    if (edad <= MES_MS) uniqueSeen30d++

    for (const modelId of nodo.modelIds) {
      models[modelId] = (models[modelId] || 0) + 1
    }
  }

  return {
    onlineNow,
    uniqueSeen24h,
    uniqueSeen7d,
    uniqueSeen30d,
    totalEverSeen: nodos.length,
    models
  }
}
