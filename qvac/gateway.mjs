// Gateway del marketplace simulado (demo corta, ver ROADMAP_FASE2-6.md).
//
// Sirve los 3 paneles (cliente/proveedor/admin) y una API minima que imita la
// forma que va a tener el gateway real de Fase 3 (POST /v1/chat/completions
// con SSE, GET /v1/models) para que el pitch pueda decir "esto ya habla el
// protocolo real" -pero el ruteo aca es contra un registro EN MEMORIA
// (store.mjs), no contra peers descubiertos por Hyperswarm. Un solo nodo
// (kind: 'real') hace inferencia de verdad con engine.mjs; el resto son
// mocks con respuesta enlatada.

import http from 'bare-http1'
import * as store from './store.mjs'

const MOCK_REPLIES = {
  'facturas-ar': (prompt) =>
    `Leí tu comprobante. Según el formato AFIP detecto: tipo "Factura B", ` +
    `CAE simulado 71234567890123, importe total estimado a partir de tu pedido ("${truncate(prompt)}") ` +
    `pendiente de validar contra el padrón. (Respuesta simulada — este nodo es una demo.)`,
  'arquitectura-planos': (prompt) =>
    `Analizando el plano que describís ("${truncate(prompt)}"): identifico una posible planta de 3 ambientes, ` +
    `superficie cubierta aproximada 68 m², y sugiero revisar el retiro de fondo según el código de ` +
    `edificación local. (Respuesta simulada — este nodo es una demo.)`,
  'traductor-en-es': (prompt) =>
    `Traducción simulada de "${truncate(prompt)}": esto representa el texto trasladado al español, ` +
    `manteniendo el tono original. (Respuesta simulada — este nodo es una demo.)`
}

function truncate(s, n = 60) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

// El modelo real se carga UNA sola vez, perezoso -recien en el primer chat
// que lo necesita-, igual que el "cero modelo" que ya define Fase 3: el
// gateway arranca sin haber descargado ni cargado nada.
let engineMod = null
let realModelId = null
let realModelLoading = null

async function ensureRealModel() {
  if (realModelId) return realModelId
  if (!realModelLoading) {
    realModelLoading = (async () => {
      engineMod = engineMod || (await import('./engine.mjs'))
      const { modelSrc } = await engineMod.resolveModel('llama1b')
      realModelId = await engineMod.loadModel({ modelSrc })
      return realModelId
    })()
  }
  return realModelLoading
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function* mockTokens(node, prompt) {
  const reply = (MOCK_REPLIES[node.modelId] || (() => 'Respuesta simulada.'))(prompt)
  for (const word of reply.split(' ')) {
    yield word + ' '
    await sleep(35)
  }
}

async function handleChat(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { error: 'body invalido, se esperaba JSON' })
  }

  const { modelId, prompt } = body
  if (!modelId || !prompt) return sendJson(res, 400, { error: 'faltan "modelId" o "prompt"' })

  const node = store.findByModelId(modelId)
  if (!node || node.status === 'offline') {
    // D5: mensaje claro si no hay ningun par sirviendo ese modelo ahora mismo.
    return sendJson(res, 404, {
      error: `no hay ningun nodo sirviendo "${modelId}" en este momento`
    })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })

  store.beginRequest(node.id)
  const startedAt = Date.now()

  try {
    if (node.kind === 'real') {
      const mid = await ensureRealModel()
      for await (const delta of engineMod.complete({ modelId: mid, prompt })) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`)
      }
    } else {
      for await (const delta of mockTokens(node, prompt)) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`)
      }
    }
    res.write('data: [DONE]\n\n')
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: String((err && err.message) || err) })}\n\n`)
  } finally {
    store.endRequest(node.id)
    res.end()
    store.pushLog({
      modelId,
      nodeId: node.id,
      operator: node.operator,
      reason: node.kind === 'real' ? 'único nodo real disponible' : 'menor carga relativa (simulado)',
      ms: Date.now() - startedAt
    })
  }
}

async function onRequest(req, res) {
  const pathname = req.url.split('?')[0]

  try {
    if (req.method === 'GET' && pathname === '/') {
      const { CLIENTE_HTML } = await import('./pages.mjs')
      return sendHtml(res, CLIENTE_HTML)
    }
    if (req.method === 'GET' && pathname === '/proveedor') {
      const { PROVEEDOR_HTML } = await import('./pages.mjs')
      return sendHtml(res, PROVEEDOR_HTML)
    }
    if (req.method === 'GET' && pathname === '/admin') {
      const { ADMIN_HTML } = await import('./pages.mjs')
      return sendHtml(res, ADMIN_HTML)
    }
    if (req.method === 'GET' && pathname === '/v1/models') {
      return sendJson(res, 200, { nodes: store.listNodes() })
    }
    if (req.method === 'GET' && pathname === '/v1/routing-log') {
      return sendJson(res, 200, { log: store.getLog() })
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      return await handleChat(req, res)
    }

    const kickMatch = pathname.match(/^\/v1\/nodes\/([^/]+)\/kick$/)
    if (req.method === 'POST' && kickMatch) {
      const node = store.kick(kickMatch[1])
      return node ? sendJson(res, 200, node) : sendJson(res, 404, { error: 'nodo desconocido' })
    }

    const nodeMatch = pathname.match(/^\/v1\/nodes\/([^/]+)$/)
    if (req.method === 'POST' && nodeMatch) {
      const patch = await readJsonBody(req)
      let updated = null
      if (typeof patch.pricing === 'string') updated = store.setPricing(nodeMatch[1], patch.pricing)
      if (typeof patch.status === 'string') updated = store.setStatus(nodeMatch[1], patch.status)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'nodo desconocido' })
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[gateway] error:', err)
    if (!res.headersSent) sendJson(res, 500, { error: String((err && err.message) || err) })
  }
}

export function createGateway({ port = 8787 } = {}) {
  store.seed()
  store.startFluctuation()

  const server = http.createServer(onRequest)
  server.listen(port, () => {
    console.log('')
    console.log(`  [gateway] escuchando en http://localhost:${port}`)
    console.log(`  [gateway] cliente:   http://localhost:${port}/`)
    console.log(`  [gateway] proveedor: http://localhost:${port}/proveedor`)
    console.log(`  [gateway] admin:     http://localhost:${port}/admin`)
    console.log('')
  })
  return server
}

export async function shutdownGateway() {
  store.stopFluctuation()
  if (engineMod && realModelId) await engineMod.shutdown(realModelId)
}
