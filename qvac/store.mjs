// Marketplace registry: the HOT view, in memory.
//
// Mixes ONE real node (actually infers via engine.mjs) with mock nodes
// (answer with canned, tokenized text, to look like real streaming) and with
// verified P2P peers.
//
// PERSISTENCE. This Map is still the only source for routing, and still
// starts empty: what a candidate needs is a live socket, and that doesn't
// persist. What DOES persist is the history -- who exists, what they
// announced, how they behaved -- and that lives in directory.mjs's
// Hyperbee. Hooked up with `attachDirectory()`; without it, this module
// behaves exactly like before.
//
// The rule that governs the two layers: the bee can't create candidates. A
// row that came from the directory enters as 'known' with
// `status: 'offline'`, and `findAllByModelId` filters by online -- that way
// D3 (a candidate dies with its socket) has no exceptions, not even by
// accident.

const nodes = new Map()
const routingLog = []
const MAX_LOG = 30

let fluctuationTimer = null

// The Hyperbee, if there is one. Writing is fire-and-forget: `directory._write`
// queues and swallows errors, so a slow disk doesn't stall the swarm handler.
let directory = null

export function attachDirectory(dir) {
  directory = dir
}

export function getDirectory() {
  return directory
}

// Pulls from the directory the peers this node has EVER known and leaves
// them in the grid as offline. This is what makes the panel show the whole
// marketplace on startup instead of an empty table waiting for someone to
// connect.
export async function hydrateFromDirectory() {
  if (!directory) return 0

  let n = 0
  for (const entry of await directory.knownPeers()) {
    if (!entry || !entry.manifest) continue
    upsertFromManifest(entry.peerKey, entry.manifest, { online: false })
    n++
  }
  return n
}

function makeNode({
  id,
  kind,
  modelId,
  displayName,
  tags,
  pricing,
  operator,
  maxConcurrentRequests
}) {
  return {
    id,
    kind, // 'real' | 'mock'
    modelId,
    displayName,
    tags,
    pricing,
    operator,
    maxConcurrentRequests,
    activeRequests: 0,
    status: 'online' // 'online' | 'offline' (kicked by admin)
  }
}

export function seed() {
  nodes.clear()
  routingLog.length = 0

  add(
    makeNode({
      id: 'real-1',
      kind: 'real',
      modelId: 'llama1b',
      displayName: 'Llama 3.2 1B Instruct',
      tags: ['general', 'chat'],
      pricing: '0.002 QVAC / 1K tok',
      operator: 'Local node (this machine)',
      maxConcurrentRequests: 3
    })
  )
  add(
    makeNode({
      id: 'mock-facturas',
      kind: 'mock',
      modelId: 'facturas-ar',
      displayName: 'AR Invoices',
      tags: ['invoices', 'accounting', 'ar'],
      pricing: '0.001 QVAC / doc',
      operator: 'FiscalNode SRL',
      maxConcurrentRequests: 6
    })
  )
  add(
    makeNode({
      id: 'mock-arquitectura',
      kind: 'mock',
      modelId: 'arquitectura-planos',
      displayName: 'Blueprint reading',
      tags: ['architecture', 'blueprints'],
      pricing: '0.004 QVAC / blueprint',
      operator: 'ArqNode Rosario',
      maxConcurrentRequests: 4
    })
  )
  add(
    makeNode({
      id: 'mock-traductor',
      kind: 'mock',
      modelId: 'traductor-en-es',
      displayName: 'EN-ES Translator',
      tags: ['translation', 'nmt'],
      pricing: '0.0005 QVAC / 1K tok',
      operator: 'LinguaNode',
      maxConcurrentRequests: 8
    })
  )
}

function add(node) {
  nodes.set(node.id, node)
}

export function listNodes() {
  return [...nodes.values()].map(toPublic)
}

export function getNode(id) {
  return nodes.get(id) || null
}

export function findByModelId(modelId) {
  return [...nodes.values()].find((n) => n.modelId === modelId) || null
}

function loadPct(node) {
  if (node.status === 'offline') return null
  return Math.round((node.activeRequests / node.maxConcurrentRequests) * 100)
}

function toPublic(node) {
  return {
    id: node.id,
    kind: node.kind,
    modelId: node.modelId,
    displayName: node.displayName,
    tags: node.tags,
    pricing: node.pricing,
    operator: node.operator,
    status: node.status,
    activeRequests: node.activeRequests,
    maxConcurrentRequests: node.maxConcurrentRequests,
    loadPct: loadPct(node),
    // Whether an upstream is local changes what the panel can say about it:
    // it can't be labeled "external API" or warn that the prompt leaves the
    // machine, because it doesn't.
    local: node.local === true,
    // Without this the panel has nothing to ask the drive from THE RIGHT
    // PEER with: with no peerKey, /v1/files always falls back to the local
    // drive, no matter which card was clicked.
    peerKey: node.peerKey || null,
    // PHASE 9 / D10 — where this candidate charges, if it declares
    // anything. Goes public because it's exactly what the 402 has to tell
    // the client, and because it already travels in a manifest announced to
    // the whole network.
    economic: node.economic || null
  }
}

// The load % goes up when a request starts and down when it ends. For the
// real node this reflects real activity; for the mocks, a timer also makes
// them fluctuate on their own (see startFluctuation) so the panel looks
// alive even when nobody's sending them requests during the video.
export function beginRequest(id) {
  const node = nodes.get(id)
  if (!node) return
  node.activeRequests = Math.min(node.activeRequests + 1, node.maxConcurrentRequests)
}

export function endRequest(id) {
  const node = nodes.get(id)
  if (!node) return
  node.activeRequests = Math.max(node.activeRequests - 1, 0)
}

// The peer answered `at_capacity`: we know it's full RIGHT NOW, and we know
// it better than the last `node:status` we got -- which can be up to 2
// seconds stale (swarm.mjs:48).
//
// Without this, the next request evaluates that peer again as if it had
// room and eats another rejection, and the one after that too, until the
// next status arrives. This is S5 from NOTES-SATURACION.md: up to 2s of
// requests sent to someone who already said they can't.
//
// It just gets marked full and that's it: the next `node:status` brings the
// truth and overwrites this (updateStatus writes activeRequests without
// looking at what was there). No need to remember it was a mark or when it
// expires.
export function markSaturated(id) {
  const node = nodes.get(id)
  if (!node) return
  node.activeRequests = node.maxConcurrentRequests
}

export function setPricing(id, pricing) {
  const node = nodes.get(id)
  if (!node) return null
  node.pricing = String(pricing).slice(0, 60)
  return toPublic(node)
}

export function setStatus(id, status) {
  const node = nodes.get(id)
  if (!node) return null
  if (status !== 'online' && status !== 'offline') return null
  node.status = status
  if (status === 'offline') node.activeRequests = 0
  return toPublic(node)
}

export function kick(id) {
  return setStatus(id, 'offline')
}

// ---------------------------------------------------------------------------
// Swarm peers (Phase 2-b): the registry gets populated from VERIFIED
// manifests, not from seed(). A peer announces N models and each one enters
// as a marketplace row, because that's the unit the client chooses.
// ---------------------------------------------------------------------------

// The panel shows the price as text. The manifest carries it structured
// (unit/amount/currency); this flattens it for display, without losing the
// fact that the signed data is the manifest's.
// "1000000 QVAC" forces counting zeros to know whether it's a hundred
// thousand or a million. Nobody counts zeros looking at a grid, least of
// all a judge with 3 minutes.
function compactAmount(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return String(n)
  const corto = (v, suf) => (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + suf
  if (Math.abs(x) >= 1e9) return corto(x / 1e9, 'B')
  if (Math.abs(x) >= 1e6) return corto(x / 1e6, 'M')
  if (Math.abs(x) >= 1e3) return corto(x / 1e3, 'K')
  return String(x)
}

// The manifest's unit is an identifier (per_1m_completion_tokens), not a
// phrase. Replacing underscores with spaces gave "per 1m completion
// tokens": neither English nor Spanish, and it repeated the amount's "1m"
// on top of it.
const UNIDAD_ES = {
  per_1m_completion_tokens: 'per 1M output tokens',
  per_1m_prompt_tokens: 'per 1M input tokens',
  per_1k_completion_tokens: 'per 1K output tokens',
  per_1k_prompt_tokens: 'per 1K input tokens',
  per_request: 'per request',
  per_token: 'per token',
  per_second: 'per second'
}

function formatPricing(pricing) {
  if (!Array.isArray(pricing) || pricing.length === 0) return 'no price declared'
  return pricing
    .map((p) => {
      const clave = String(p.unit || '')
      const unidad = UNIDAD_ES[clave] || clave.replace(/_/g, ' ')
      return `${compactAmount(p.amount)} ${p.currency} / ${unidad}`
    })
    .join(' · ')
}

// What the manifest carries was chosen by ANOTHER machine. The signature
// proves WHO said it, not that what was said makes sense, and nothing
// validates the schema at runtime: `qos.maxConcurrentRequests` can arrive as
// a string, an object, or an absurd number. The /admin panel concatenates it
// into the DOM, so a perfectly signed manifest with HTML in that field was
// an XSS against whatever operator opens it. Cut off at the edge -here,
// where it comes in- and not at every place that reads it.
function capacidad(v) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 1) return 1
  // A peer can't announce infinite capacity: the number only serves to
  // show load and for routing, and a giant one makes the peer look
  // eternally free.
  return Math.min(n, 1024)
}

// The payout address from an ALREADY-VERIFIED manifest, or null.
//
// Returns null for anything that isn't a usable address: the mock block
// (which carries `_mock` and the zero address), a malformed address, or the
// block being absent. Null means "this peer declares no payout address,"
// which is a legitimate state -- a node that only consumes -- distinct from
// having one.
function economicVerificado(manifest) {
  const e = manifest && manifest.economic
  if (!e || e._mock) return null
  const addr = String(e.walletAddress || '')
  const evm = /^0x[a-fA-F0-9]{40}$/.test(addr)
  const tron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)
  if (!evm && !tron) return null
  if (/^0x0{40}$/.test(addr)) return null
  return {
    walletAddress: addr,
    chains: Array.isArray(e.chains) ? [...e.chains] : [],
    settlement: typeof e.settlement === 'string' ? e.settlement : null
  }
}

function peerNodeId(peerKey, modelId) {
  return `${peerKey.slice(0, 12)}:${modelId}`
}

// `online: false` is the door directory rows come in through: a peer
// hydrated from the Hyperbee has NO socket, so it can't be a candidate. It
// enters as 'known' and offline, and stays there until it actually connects.
export function upsertFromManifest(peerKey, manifest, { online = true } = {}) {
  const operator = (manifest.metadata && manifest.metadata.operator) || 'Remote node'
  const tags = (manifest.metadata && manifest.metadata.tags) || []
  // PHASE 9 / D10 — where this peer gets paid.
  //
  // It comes from the manifest whose signature JUST got verified (swarm.mjs),
  // and that's the entire guarantee that makes a direct `payTo` possible: the
  // Ed25519 signature ties the peer's network key — the socket's — to the
  // payout address it declares. Without that, anyone could relay someone
  // else's manifest with their own wallet inside and get paid for someone
  // else's work.
  //
  // The mock block carries `_mock` and the zero address: that is NOT a payout
  // address, it's a peer declaring none, and it's stored as null. A peer with
  // no wallet can't be charged, and confusing it with one that does have one
  // would send the money into a hole.
  const economic = economicVerificado(manifest)

  // THIS peer's old rows get deleted before inserting: if it re-announces
  // with fewer models, the ones it no longer serves have to disappear from
  // the marketplace. `hard` because this is a replacement, not a
  // disconnection: degrading them to 'known' would leave ghosts of the
  // models the peer stopped serving.
  removeByPeer(peerKey, { hard: true })

  for (const m of manifest.models) {
    const id = peerNodeId(peerKey, m.modelId)
    nodes.set(id, {
      id,
      kind: online ? 'peer' : 'known',
      peerKey,
      modelId: m.modelId,
      displayName: m.displayName || m.modelId,
      tags,
      pricing: formatPricing(m.pricing),
      operator,
      maxConcurrentRequests: capacidad(m.qos && m.qos.maxConcurrentRequests),
      activeRequests: 0,
      status: online ? 'online' : 'offline',
      economic
    })
  }
}

// The local node as a provider. Registered when this process can serve real
// inference (`serve --swarm`), with or without --demo: it's not a mock, it's
// this machine. Without this row, `localLoad()` used to return 0/0 and the
// node announced ZERO capacity via `node:status` while it was actively
// serving.
export function registerLocal({
  modelId,
  displayName,
  operator,
  pricing = 'no price declared',
  tags = [],
  maxConcurrentRequests = 3
}) {
  // With --demo, seed() already left a 'real' row for this same model.
  // Without this there would be TWO: the grid showed the same local node
  // twice, and — worse — `localLoad()` summed both capacities and the node
  // announced 6 slots when it had 3. Announcing double the actual capacity to
  // the network is exactly the kind of lie the signed manifest exists to
  // prevent.
  //
  // ANY previous local row gets deleted, not just the one for the same
  // modelId: there's only ONE local node per process, and switching model
  // from the Provider panel (POST /v1/swarm/manifest) calls this again with a
  // different modelId. Filtering by modelId left the old row orphaned — the
  // store showed two local nodes with two models, when the process can only
  // serve the new one.
  for (const [existingId, node] of nodes) {
    if (node.kind === 'real' && existingId.startsWith('local:')) nodes.delete(existingId)
  }

  const id = `local:${modelId}`
  nodes.set(id, {
    id,
    kind: 'real',
    modelId,
    displayName: displayName || modelId,
    tags,
    pricing,
    operator: operator || 'Local node (this machine)',
    maxConcurrentRequests,
    activeRequests: 0,
    status: 'online'
  })
  return id
}

// Which registry row counts the load of a request this node serves for a
// remote peer.
export function localNodeIdFor(modelId) {
  for (const node of nodes.values()) {
    if (node.kind === 'real' && node.modelId === modelId) return node.id
  }
  return null
}

// ---------------------------------------------------------------------------
// The external assistant (Phase 8.5) as ONE MORE ROW in the registry.
//
// That's the whole argument of the phase: an upstream doesn't need its own
// separate path. It enters here with kind 'upstream' and, without writing
// another line, /v1/models lists it, /v1/nodes draws it in the panel,
// findAllByModelId considers it, pickCandidate scores it, and the provenance
// headers declare it.
//
// `status` starts wherever the caller says: an upstream that's configured but
// has NO credential in the environment still gets registered and is left
// offline. It shows up in the panel — with what it's missing — instead of not
// existing at all, which is the difference between "you misconfigured it" and
// "you didn't configure anything."
export function registerUpstream({
  id,
  modelId,
  displayName,
  operator,
  pricing = 'no price declared',
  tags = [],
  maxConcurrentRequests = 4,
  status = 'online',
  local = false
}) {
  const rowId = `upstream:${id}`
  nodes.set(rowId, {
    id: rowId,
    kind: 'upstream',
    modelId,
    displayName: displayName || modelId,
    tags,
    pricing,
    operator: operator || 'External assistant',
    maxConcurrentRequests,
    activeRequests: 0,
    status: status === 'offline' ? 'offline' : 'online',
    // An upstream running on THIS machine (llama-server, vLLM, a self-hosted
    // NIM). Still kind 'upstream' because it's asked over HTTP and not
    // through the embedded engine, but it's NOT a third party: the prompt
    // doesn't leave here. Everything that decides privacy and spend looks at
    // this field, not at kind.
    local: local === true
  })
  return rowId
}

// ALL of them get deleted before re-registering: the config gets re-read
// whole, and leaving the row for a model the operator removed from the file
// would announce something this node can no longer serve.
export function clearUpstreams() {
  for (const [id, node] of nodes) {
    if (node.kind === 'upstream') nodes.delete(id)
  }
}

export function updateStatus(peerKey, status) {
  for (const node of nodes.values()) {
    if (node.peerKey !== peerKey) continue
    // Capacity can also change: the peer might have loaded another model
    // and have fewer free slots than when it signed the manifest.
    if (Number.isFinite(status.maxConcurrentRequests)) {
      node.maxConcurrentRequests = status.maxConcurrentRequests
    }
    if (Number.isFinite(status.activeRequests)) {
      node.activeRequests = Math.min(status.activeRequests, node.maxConcurrentRequests)
    }
  }
}

// D3: the connection drops, the candidate drops. With no look at `expiresAt`.
//
// With the directory hooked up the row does NOT get DELETED, it degrades to
// 'known' + offline. D3 stays intact -- `findAllByModelId` filters by
// online, so it stops being a candidate at the same instant -- but the peer
// doesn't disappear from the panel: it stays as "I know it, it's just not
// here right now," which is the information the Hyperbee exists to
// preserve. With no directory it gets deleted like before.
//
// `hard: true` forces a real deletion. Used by `upsertFromManifest`, where
// the peer did NOT leave: its model list is being replaced.
// The name a peer announces itself under, so it can be said WHO consumed us
// and not just a 64-character public key. If the peer never announced
// itself -or already left the registry- a prefix of the key is returned,
// which is still more useful than "unknown."
export function operatorForPeer(peerKey) {
  if (!peerKey) return 'unknown peer'
  for (const node of nodes.values()) {
    if (node.peerKey === peerKey && node.operator) return node.operator
  }
  return peerKey.slice(0, 8) + '…'
}

export function removeByPeer(peerKey, { hard = false } = {}) {
  for (const [id, node] of nodes) {
    if (node.peerKey !== peerKey) continue

    if (hard || !directory) {
      nodes.delete(id)
      continue
    }

    node.kind = 'known'
    node.status = 'offline'
    node.activeRequests = 0
  }
}

// What this node publishes in `node:status`. It's the REAL load of what
// runs on this machine: --demo mode's mock nodes don't count, that would
// mean announcing capacity to the network that doesn't exist.
export function localLoad() {
  let activeRequests = 0
  let maxConcurrentRequests = 0
  for (const node of nodes.values()) {
    if (node.kind !== 'real') continue
    activeRequests += node.activeRequests
    maxConcurrentRequests += node.maxConcurrentRequests
  }
  return { activeRequests, maxConcurrentRequests }
}

// All candidates for a model, not just the first one. The gateway uses this
// to be able to LOG how many there were: with real peers there can be two
// nodes serving the same modelId, and the log can't keep saying "only
// candidate" when there were three.
export function findAllByModelId(modelId) {
  // The `online` filter is also the directory's barrier: 'known' rows that
  // came out of the Hyperbee are always offline, so they can't become
  // candidates no matter how much they advertise the model. A replicated
  // manifest proves someone said something, not that that someone is alive
  // (see the long note in directory.mjs).
  const candidatos = [...nodes.values()].filter(
    (n) => n.modelId === modelId && n.status === 'online'
  )

  // DELIBERATE order, not by load (choosing by load is D6 and still isn't
  // implemented): P2P peers first, then the local node, then mocks.
  //
  // Peers go first for a demo reason, not a performance one: with
  // `--demo --swarm` there's a local llama1b AND a remote one, and if the
  // local one wins, the scenario's prompt gets answered by the same
  // machine — the P2P path goes unexercised right when it's being shown off.
  // The log says how many candidates there were, so the preference stays
  // visible instead of hidden.
  // Same order as RANK_KIND in routing.mjs. They had drifted apart: this one
  // didn't list 'upstream', so it fell into the `?? 3` bucket — behind the
  // mocks. An external provider that costs real dollars and answers for real
  // can't be ranked worse than --demo mode's theater.
  const rank = { peer: 0, real: 1, upstream: 2, mock: 3 }
  return candidatos.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9))
}

// The trail stopped being routing-only: model load and the swarm's two D7
// numbers also enter now. `kind` is what tells them apart when reading them
// back, and it defaults to 'route' so old entries -and any caller that
// doesn't pass it- keep meaning the same thing.
export function pushLog(entry) {
  const full = { ts: Date.now(), kind: 'route', ...entry }
  routingLog.unshift(full)
  if (routingLog.length > MAX_LOG) routingLog.length = MAX_LOG

  // The in-memory array is still what the panel reads (30 entries, fast and
  // with no await). The bee stores the full series, which is what later
  // allows saying "this peer failed 3 times this week" instead of "it
  // failed."
  //
  // `full` gets passed, not `entry`: if the bee stored the version without
  // `kind`, the long history couldn't be filtered by type and the panel
  // would have two different shapes of the same entry depending on where it
  // read it from.
  if (directory) directory.pushLog(full)
}

// Per-peer counters. The directory persists them (they're the raw material
// for reputation) and they also accumulate in memory, because routing needs
// them SYNCHRONOUS: `directory.stats()` is a get against the Hyperbee, and
// putting an await on every request's path just to break ties between
// candidates that are probably tied on load anyway costs more than what it
// decides.
//
// The in-memory copy starts empty on every boot. That's fine: with no data,
// the historical tiebreaker simply doesn't take part and load alone does
// the ordering.
const peerStats = new Map()

export function recordPeerResult(peerKey, { ok = true, ms = null, tokens = 0 } = {}) {
  if (!peerKey) return
  if (directory) directory.recordStat(peerKey, { ok, ms, tokens })

  const prev = peerStats.get(peerKey) || { requests: 0, errors: 0, tokens: 0, lastMs: null }
  peerStats.set(peerKey, {
    requests: prev.requests + 1,
    errors: prev.errors + (ok ? 0 : 1),
    tokens: prev.tokens + (Number.isFinite(tokens) ? tokens : 0),
    lastMs: Number.isFinite(ms) ? ms : prev.lastMs
  })
}

// What `routing.pickCandidate` gets injected with to break ties. Returns
// null if we don't know anything about that node yet -- which is the honest
// thing: a new peer has no history, it doesn't have a "perfect" history.
export function statsFor(node) {
  if (!node || !node.peerKey) return null
  return peerStats.get(node.peerKey) || null
}

// The long log, from the Hyperbee. The panel can ask for more than 30
// entries without the in-memory array having to grow.
export async function getLogHistory(limit = 200) {
  if (!directory) return routingLog.slice(0, limit)
  return await directory.recentLog(limit)
}

export function getLog() {
  return routingLog
}

// Mock nodes' fluctuation: on every tick, every online mock node moves a
// random step within [0, maxConcurrentRequests]. Pure theater so the video
// shows percentages changing without the client actually requesting
// anything -the real node NEVER gets touched here, its load is always the
// real one.
export function startFluctuation(intervalMs = 2200) {
  stopFluctuation()
  fluctuationTimer = setInterval(() => {
    for (const node of nodes.values()) {
      if (node.kind !== 'mock' || node.status === 'offline') continue
      const step = Math.round((Math.random() - 0.5) * 2 * (node.maxConcurrentRequests / 2))
      node.activeRequests = Math.min(
        Math.max(node.activeRequests + step, 0),
        node.maxConcurrentRequests
      )
    }
  }, intervalMs)
  fluctuationTimer.unref?.()
}

export function stopFluctuation() {
  if (fluctuationTimer) clearInterval(fluctuationTimer)
  fluctuationTimer = null
}
