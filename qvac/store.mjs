// Registro en memoria del marketplace simulado (Fase 2, demo corta).
//
// Mezcla UN nodo real (infiere de verdad via engine.mjs) con nodos mock
// (responden texto enlatado, tokenizado, para parecer streaming real). No hay
// P2P ni firma todavia -eso es Fase 2/3 completas, ver ROADMAP_FASE2-6.md-,
// esto es solo lo minimo para que los 3 paneles (cliente/proveedor/admin)
// tengan algo real que mostrar en el video. Se resetea al reiniciar el
// proceso, a proposito: no hay persistencia que mantener para una demo.

const nodes = new Map()
const routingLog = []
const MAX_LOG = 30

let fluctuationTimer = null

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
function formatPricing(pricing) {
  if (!Array.isArray(pricing) || pricing.length === 0) return 'sin precio declarado'
  return pricing
    .map((p) => {
      const unidad = String(p.unit || '').replace(/_/g, ' ')
      return `${p.amount} ${p.currency} / ${unidad}`
    })
    .join(' · ')
}

function peerNodeId(peerKey, modelId) {
  return `${peerKey.slice(0, 12)}:${modelId}`
}

export function upsertFromManifest(peerKey, manifest) {
  const operator = (manifest.metadata && manifest.metadata.operator) || 'Nodo remoto'
  const tags = (manifest.metadata && manifest.metadata.tags) || []

  // Se borran las filas viejas de ESTE par antes de insertar: si reanuncia con
  // menos modelos, los que ya no sirve tienen que desaparecer del marketplace.
  removeByPeer(peerKey)

  for (const m of manifest.models) {
    const id = peerNodeId(peerKey, m.modelId)
    nodes.set(id, {
      id,
      kind: 'peer',
      peerKey,
      modelId: m.modelId,
      displayName: m.displayName || m.modelId,
      tags,
      pricing: formatPricing(m.pricing),
      operator,
      maxConcurrentRequests: (m.qos && m.qos.maxConcurrentRequests) || 1,
      activeRequests: 0,
      status: 'online'
    })
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
export function removeByPeer(peerKey) {
  for (const [id, node] of nodes) {
    if (node.peerKey === peerKey) nodes.delete(id)
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
  return [...nodes.values()].filter((n) => n.modelId === modelId && n.status === 'online')
}

export function pushLog(entry) {
  routingLog.unshift({ ts: Date.now(), ...entry })
  if (routingLog.length > MAX_LOG) routingLog.length = MAX_LOG
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
