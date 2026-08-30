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
    // Que un upstream sea local cambia lo que el panel puede decir de el: no
    // se lo puede etiquetar "external API" ni avisar que el prompt sale de la
    // maquina, porque no sale.
    local: node.local === true,
    // Sin esto el panel no tiene con que pedirle el drive AL PAR CORRECTO: sin
    // peerKey, /v1/files siempre cae al drive local, sin importar que tarjeta
    // se haya clickeado.
    peerKey: node.peerKey || null,
    // FASE 9 / D10 — a donde cobra este candidato, si declara algo. Va al
    // publico porque es exactamente lo que el 402 le tiene que decir al
    // cliente, y porque ya viaja en un manifiesto que se anuncia a toda la red.
    economic: node.economic || null
  }
}

// El % de carga sube al arrancar un request y baja al terminar. Para el nodo
// real esto refleja actividad real; para los mock, ademas, un timer los hace
// fluctuar solos (ver startFluctuation) asi el panel se ve vivo aunque nadie
// les mande requests durante el video.
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

// El par contesto `at_capacity`: sabemos que esta lleno AHORA, y lo sabemos
// mejor que el ultimo `node:status` que recibimos -- que puede tener hasta
// 2 segundos de atraso (swarm.mjs:48).
//
// Sin esto, el request siguiente vuelve a evaluar a ese par como si tuviera
// lugar y se come otro rechazo, y el que sigue tambien, hasta que llegue el
// proximo status. Es S5 de NOTES-SATURACION.md: hasta 2s de requests mandados
// a alguien que ya dijo que no puede.
//
// Se lo marca lleno y listo: el proximo `node:status` trae la verdad y pisa
// esto (updateStatus escribe activeRequests sin mirar lo que habia). No hace
// falta recordar que fue una marca ni cuando expira.
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
// Pares del swarm (Fase 2-b): el registro se puebla desde manifiestos
// VERIFICADOS, no desde seed(). Un par anuncia N modelos y cada uno entra como
// una fila del marketplace, porque es la unidad que el cliente elige.
// ---------------------------------------------------------------------------

// El panel muestra el precio como texto. El manifiesto lo trae estructurado
// (unit/amount/currency); esto lo aplana para mostrar, sin perder que el dato
// firmado es el del manifiesto.
// "1000000 QVAC" obliga a contar ceros para saber si son cien mil o un millon.
// Nadie cuenta ceros mirando una grilla, y menos un jurado con 3 minutos.
function compactAmount(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return String(n)
  const corto = (v, suf) => (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + suf
  if (Math.abs(x) >= 1e9) return corto(x / 1e9, 'B')
  if (Math.abs(x) >= 1e6) return corto(x / 1e6, 'M')
  if (Math.abs(x) >= 1e3) return corto(x / 1e3, 'K')
  return String(x)
}

// El unit del manifiesto es un identificador (per_1m_completion_tokens), no
// una frase. Reemplazar guiones bajos por espacios daba "per 1m completion
// tokens": ni ingles ni castellano, y encima repetia el "1m" del monto.
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

// Lo que trae el manifiesto lo eligio OTRA maquina. La firma prueba QUIEN lo
// dijo, no que lo que dijo tenga sentido, y nada valida el schema en runtime:
// `qos.maxConcurrentRequests` puede venir string, objeto o un numero absurdo.
// El panel /admin lo concatena en el DOM, asi que un manifiesto perfectamente
// firmado con HTML en ese campo era un XSS contra el operador que lo abre.
// Se corta en el borde -aca, donde entra- y no en cada lugar que lo lee.
function capacidad(v) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 1) return 1
  // Un par no puede anunciar capacidad infinita: el numero solo sirve para
  // mostrar carga y para el ruteo, y uno gigante hace que el par se vea
  // eternamente libre.
  return Math.min(n, 1024)
}

// La direccion de cobro de un manifiesto YA VERIFICADO, o null.
//
// Devuelve null para todo lo que no sea una direccion usable: el bloque mock
// (que trae `_mock` y la direccion cero), una direccion mal formada, o la
// ausencia del bloque. Null significa "este par no declara donde cobrar", que
// es un estado legitimo -- un nodo que solo consume -- y distinto de tener una.
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

// `online: false` es la puerta por la que entran las filas del directorio: un
// par hidratado del Hyperbee NO tiene socket, asi que no puede ser candidato.
// Entra como 'known' y offline, y ahi se queda hasta que se conecte de verdad.
export function upsertFromManifest(peerKey, manifest, { online = true } = {}) {
  const operator = (manifest.metadata && manifest.metadata.operator) || 'Nodo remoto'
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

  // Se borran las filas viejas de ESTE par antes de insertar: si reanuncia con
  // menos modelos, los que ya no sirve tienen que desaparecer del marketplace.
  // `hard` porque esto es un reemplazo, no una desconexion: degradarlas a
  // 'known' dejaria fantasmas de los modelos que el par dejo de servir.
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
    operator: operator || 'Asistente externo',
    maxConcurrentRequests,
    activeRequests: 0,
    status: status === 'offline' ? 'offline' : 'online',
    // Un upstream que corre en ESTA maquina (llama-server, vLLM, un NIM
    // self-hosted). Sigue siendo kind 'upstream' porque se le pide por HTTP y
    // no por el motor embebido, pero NO es un tercero: el prompt no sale de
    // aca. Todo lo que decide privacidad y gasto mira este campo, no el kind.
    local: local === true
  })
  return rowId
}

// Se borran TODOS antes de volver a registrar: la config se relee entera, y
// dejar la fila de un modelo que el operador saco del archivo anunciaria algo
// que este nodo ya no puede servir.
export function clearUpstreams() {
  for (const [id, node] of nodes) {
    if (node.kind === 'upstream') nodes.delete(id)
  }
}

export function updateStatus(peerKey, status) {
  for (const node of nodes.values()) {
    if (node.peerKey !== peerKey) continue
    // La capacidad tambien puede cambiar: el par puede haber cargado otro
    // modelo y tener menos slots libres que cuando firmo el manifiesto.
    if (Number.isFinite(status.maxConcurrentRequests)) {
      node.maxConcurrentRequests = status.maxConcurrentRequests
    }
    if (Number.isFinite(status.activeRequests)) {
      node.activeRequests = Math.min(status.activeRequests, node.maxConcurrentRequests)
    }
  }
}

// D3: se cae la conexion, se cae el candidato. Sin mirar `expiresAt`.
//
// Con el directorio enganchado la fila no se BORRA, se degrada a 'known' +
// offline. D3 sigue intacto -- `findAllByModelId` filtra por online, asi que
// deja de ser candidato en el mismo instante -- pero el par no desaparece del
// panel: queda como "lo conozco, ahora no esta", que es la informacion que el
// Hyperbee existe para conservar. Sin directorio se borra como antes.
//
// `hard: true` fuerza el borrado real. Lo usa `upsertFromManifest`, donde el
// par NO se fue: se esta reemplazando su lista de modelos.
// El nombre con el que se anuncia un par, para poder decir QUIEN nos consumio
// y no solo una clave publica de 64 caracteres. Si el par nunca se anuncio
// -o ya se fue del registro- se devuelve un prefijo de la clave, que sigue
// siendo mas util que "desconocido".
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

// Lo que este nodo publica en `node:status`. Es la carga REAL de lo que corre
// en esta maquina: los nodos mock del modo --demo no cuentan, seria anunciarle
// a la red una capacidad que no existe.
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

// El rastro dejo de ser solo de ruteo: ahora tambien entran la carga del
// modelo y los dos numeros D7 del swarm. `kind` es lo que los separa al
// leerlos, y va por defecto en 'route' para que las entradas viejas -y
// cualquier llamador que no lo pase- sigan significando lo mismo.
export function pushLog(entry) {
  const full = { ts: Date.now(), kind: 'route', ...entry }
  routingLog.unshift(full)
  if (routingLog.length > MAX_LOG) routingLog.length = MAX_LOG

  // El array en memoria sigue siendo el que lee el panel (30 entradas, rapido
  // y sin await). El bee guarda la serie completa, que es lo que despues
  // permite decir "este par fallo 3 veces esta semana" en vez de "fallo".
  //
  // Se le pasa `full` y no `entry`: si el bee guardara la version sin `kind`,
  // el historial largo no se podria filtrar por tipo y el panel tendria dos
  // formas distintas de la misma entrada segun de donde la leyo.
  if (directory) directory.pushLog(full)
}

// Contadores por par. El directorio los persiste (es la materia prima de la
// reputacion) y ademas se acumulan en memoria, porque el ruteo los necesita
// SINCRONOS: `directory.stats()` es un get contra el Hyperbee, y meter un await
// en el camino de cada request para desempatar candidatos que probablemente
// esten empatados en carga sale mas caro que lo que decide.
//
// La copia en memoria arranca vacia en cada boot. Eso esta bien: sin datos, el
// desempate historico simplemente no participa y ordena la carga sola.
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

// Lo que `routing.pickCandidate` recibe inyectado para desempatar. Devuelve
// null si de ese nodo no sabemos nada todavia -- que es lo honesto: un par
// nuevo no tiene historial, no tiene historial "perfecto".
export function statsFor(node) {
  if (!node || !node.peerKey) return null
  return peerStats.get(node.peerKey) || null
}

// El log largo, desde el Hyperbee. El panel puede pedir mas de 30 entradas sin
// que el array en memoria tenga que crecer.
export async function getLogHistory(limit = 200) {
  if (!directory) return routingLog.slice(0, limit)
  return await directory.recentLog(limit)
}

export function getLog() {
  return routingLog
}

// Fluctuacion de los nodos mock: cada tick, cada nodo mock online se mueve un
// paso al azar dentro de [0, maxConcurrentRequests]. Es puro teatro para que
// el video muestre porcentajes cambiando sin que el cliente este pidiendo
// nada -el nodo real NUNCA se toca aca, su carga es siempre la real.
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
