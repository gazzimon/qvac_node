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
  maxConcurrentRequests,
  tools = []
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
    status: 'online', // 'online' | 'offline' (admin lo tira)
    tools // catalogo, NO se ejecuta todavia -ver D2, mismo criterio de mock marcado
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
      maxConcurrentRequests: 3,
      tools: [
        { name: 'web_search', description: 'Buscar en la web' },
        { name: 'calculator', description: 'Resolver operaciones matemáticas' }
      ]
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
      maxConcurrentRequests: 6,
      tools: [
        { name: 'validar_cae', description: 'Validar CAE contra AFIP' },
        { name: 'extraer_campos', description: 'Extraer campos de una factura' }
      ]
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
      maxConcurrentRequests: 4,
      tools: [{ name: 'medir_superficie', description: 'Calcular superficie cubierta desde un plano' }]
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
      maxConcurrentRequests: 8,
      tools: [{ name: 'detectar_idioma', description: 'Detectar idioma de origen' }]
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
    tools: node.tools
  }
}

// Catalogo de tools agregado de todos los nodos, para la tab de Skills.
// SOLO catalogo: ningun tool se ejecuta de verdad todavia (D2, mock marcado).
export function listTools() {
  const out = []
  for (const node of nodes.values()) {
    for (const tool of node.tools) {
      out.push({ ...tool, nodeId: node.id, operator: node.operator, displayName: node.displayName })
    }
  }
  return out
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
