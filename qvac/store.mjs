// Registro del marketplace: la vista CALIENTE, en memoria.
//
// Mezcla UN nodo real (infiere de verdad via engine.mjs) con nodos mock
// (responden texto enlatado, tokenizado, para parecer streaming real) y con
// los pares P2P verificados.
//
// PERSISTENCIA. Este Map sigue siendo la unica fuente para el ruteo, y sigue
// arrancando vacio: lo que un candidato necesita es un socket vivo, y eso no
// se persiste. Lo que SI se persiste es la historia -- quien existe, que
// anuncio, como se porto -- y eso vive en el Hyperbee de directory.mjs. Se
// engancha con `attachDirectory()`; sin el, este modulo se comporta
// exactamente como antes.
//
// La regla que ordena las dos capas: el bee no puede crear candidatos. Una
// fila que salio del directorio entra como 'known' y con `status: 'offline'`,
// y `findAllByModelId` filtra por online -- asi D3 (el candidato muere con el
// socket) no tiene excepciones ni siquiera por accidente.

const nodes = new Map()
const routingLog = []
const MAX_LOG = 30

let fluctuationTimer = null

// El Hyperbee, si hay. Escribir es fire-and-forget: `directory._write` encola
// y traga los errores, para que un disco lento no frene el handler del swarm.
let directory = null

export function attachDirectory(dir) {
  directory = dir
}

export function getDirectory() {
  return directory
}

// Trae del directorio los pares que este nodo conocio ALGUNA VEZ y los deja en
// la grilla como offline. Es lo que hace que el panel muestre el marketplace
// entero al arrancar en vez de una tabla vacia esperando a que alguien se
// conecte.
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
    status: 'online' // 'online' | 'offline' (admin lo tira)
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
      operator: 'Nodo local (este equipo)',
      maxConcurrentRequests: 3
    })
  )
  add(
    makeNode({
      id: 'mock-facturas',
      kind: 'mock',
      modelId: 'facturas-ar',
      displayName: 'Facturas AR',
      tags: ['facturas', 'contable', 'ar'],
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
      displayName: 'Lectura de planos',
      tags: ['arquitectura', 'planos'],
      pricing: '0.004 QVAC / plano',
      operator: 'ArqNode Rosario',
      maxConcurrentRequests: 4
    })
  )
  add(
    makeNode({
      id: 'mock-traductor',
      kind: 'mock',
      modelId: 'traductor-en-es',
      displayName: 'Traductor EN-ES',
      tags: ['traduccion', 'nmt'],
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
    loadPct: loadPct(node)
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
  per_1m_completion_tokens: 'por 1M tokens de salida',
  per_1m_prompt_tokens: 'por 1M tokens de entrada',
  per_1k_completion_tokens: 'por 1K tokens de salida',
  per_1k_prompt_tokens: 'por 1K tokens de entrada',
  per_request: 'por consulta',
  per_token: 'por token',
  per_second: 'por segundo'
}

function formatPricing(pricing) {
  if (!Array.isArray(pricing) || pricing.length === 0) return 'sin precio declarado'
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

function peerNodeId(peerKey, modelId) {
  return `${peerKey.slice(0, 12)}:${modelId}`
}

// `online: false` es la puerta por la que entran las filas del directorio: un
// par hidratado del Hyperbee NO tiene socket, asi que no puede ser candidato.
// Entra como 'known' y offline, y ahi se queda hasta que se conecte de verdad.
export function upsertFromManifest(peerKey, manifest, { online = true } = {}) {
  const operator = (manifest.metadata && manifest.metadata.operator) || 'Nodo remoto'
  const tags = (manifest.metadata && manifest.metadata.tags) || []

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
      status: online ? 'online' : 'offline'
    })
  }
}

// El nodo local como proveedor. Se registra cuando este proceso puede servir
// inferencia de verdad (`serve --swarm`), con --demo o sin él: no es un mock,
// es esta máquina. Sin esta fila, `localLoad()` devolvía 0/0 y el nodo
// anunciaba capacidad CERO por `node:status` mientras estaba sirviendo.
export function registerLocal({
  modelId,
  displayName,
  operator,
  pricing = 'sin precio declarado',
  tags = [],
  maxConcurrentRequests = 3
}) {
  // Con --demo, seed() ya dejo una fila 'real' para este mismo modelo. Sin
  // esto quedaban DOS: la grilla mostraba el mismo nodo local dos veces, y
  // -peor- `localLoad()` sumaba las dos capacidades y el nodo anunciaba 6
  // slots cuando tenia 3. Anunciarle a la red el doble de capacidad de la que
  // existe es la clase de mentira que el manifiesto firmado esta para evitar.
  for (const [existingId, node] of nodes) {
    if (node.kind === 'real' && node.modelId === modelId) nodes.delete(existingId)
  }

  const id = `local:${modelId}`
  nodes.set(id, {
    id,
    kind: 'real',
    modelId,
    displayName: displayName || modelId,
    tags,
    pricing,
    operator: operator || 'Nodo local (este equipo)',
    maxConcurrentRequests,
    activeRequests: 0,
    status: 'online'
  })
  return id
}

// Con qué fila del registro se contabiliza la carga de un request que este
// nodo sirve para un par remoto.
export function localNodeIdFor(modelId) {
  for (const node of nodes.values()) {
    if (node.kind === 'real' && node.modelId === modelId) return node.id
  }
  return null
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

// Todos los candidatos para un modelo, no solo el primero. El gateway lo usa
// para poder LOGUEAR cuantos habia: con pares reales puede haber dos nodos
// sirviendo el mismo modelId, y el log no puede seguir diciendo "unico
// candidato" cuando habia tres.
export function findAllByModelId(modelId) {
  // El filtro por `online` es tambien la barrera del directorio: las filas
  // 'known' que salieron del Hyperbee estan siempre offline, asi que no pueden
  // convertirse en candidatas por mas que anuncien el modelo. Un manifiesto
  // replicado prueba que alguien dijo algo, no que ese alguien este vivo
  // (ver la nota larga de directory.mjs).
  const candidatos = [...nodes.values()].filter(
    (n) => n.modelId === modelId && n.status === 'online'
  )

  // Orden DELIBERADO, no por carga (elegir por carga es D6 y sigue sin
  // implementar): primero los pares P2P, después el nodo local, después los
  // mocks.
  //
  // Los pares van primero por una razón de demo, no de performance: con
  // `--demo --swarm` hay un llama1b local Y uno remoto, y si gana el local el
  // prompt del escenario lo contesta la misma máquina — el camino P2P queda
  // sin ejercitar justo cuando se lo está mostrando. El log dice cuántos
  // candidatos hubo, así que la preferencia queda visible y no escondida.
  const rank = { peer: 0, real: 1, mock: 2 }
  return candidatos.sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3))
}

export function pushLog(entry) {
  routingLog.unshift({ ts: Date.now(), ...entry })
  if (routingLog.length > MAX_LOG) routingLog.length = MAX_LOG

  // El array en memoria sigue siendo el que lee el panel (30 entradas, rapido
  // y sin await). El bee guarda la serie completa, que es lo que despues
  // permite decir "este par fallo 3 veces esta semana" en vez de "fallo".
  if (directory) directory.pushLog(entry)
}

// Contadores por par para el directorio. Se llama al terminar un request
// ruteado a un par remoto; sin directorio no hace nada.
export function recordPeerResult(peerKey, { ok = true, ms = null, tokens = 0 } = {}) {
  if (directory && peerKey) directory.recordStat(peerKey, { ok, ms, tokens })
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
