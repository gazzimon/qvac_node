// Gateway del marketplace simulado (demo corta, ver ROADMAP_FASE2-6.md).
//
// Sirve los 3 paneles (cliente/proveedor/admin) y una API propia sobre SSE.
//
// OJO CON EL CLAIM: esto NO es compatible con OpenAI, aunque las rutas se
// llamen igual. `POST /v1/chat/completions` espera `{ modelId, prompt }` y
// emite `data: {"delta":"..."}`; OpenAI manda `{ model, messages[], stream }`
// y emite `data: {"choices":[{"delta":{"content":"..."}}]}`. Un request con
// la forma de OpenAI responde HTTP 400 -probado-. `GET /v1/models` devuelve
// `{nodes:[...]}`, no `{object:"list",data:[...]}`.
//
// Se deja escrito acá porque el pitch NO puede decir "ya habla el protocolo
// real", y porque Fase 4.5 del ROADMAP (Hermes Agent apuntando su `base_url`
// acá) no funciona hasta que esto se implemente de verdad.
//
// El ruteo tampoco es P2P: va contra un registro EN MEMORIA (store.mjs), no
// contra peers descubiertos por Hyperswarm. Un solo nodo (kind: 'real') hace
// inferencia de verdad con engine.mjs; el resto son mocks enlatados.

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
let gpuLayers // undefined = deja decidir al SDK

function ensureRealModel() {
  if (realModelId) return Promise.resolve(realModelId)
  if (!realModelLoading) {
    realModelLoading = (async () => {
      engineMod = engineMod || (await import('./engine.mjs'))
      const { modelSrc } = await engineMod.resolveModel('llama1b')
      realModelId = await engineMod.loadModel({ modelSrc, gpuLayers })
      return realModelId
    })()
    // Si la carga falla, hay que SOLTAR la promesa rechazada. Si queda
    // cacheada, todo request posterior recibe el mismo rechazo al instante y
    // el gateway no se recupera nunca sin reiniciarlo -un timeout del registry
    // por wifi mala dejaba el nodo real muerto para toda la sesion-.
    realModelLoading.catch(() => {
      realModelLoading = null
    })
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
    // El motivo dice lo que REALMENTE pasó. Antes decía "menor carga relativa
    // (simulado)", que era falso: cada nodo tiene un modelId único, así que
    // `findByModelId` nunca elige entre dos candidatos. Elegir por carga es
    // D6 del ROADMAP y todavía no está implementado; el log no puede afirmar
    // una decisión que no ocurrió.
    store.pushLog({
      modelId,
      nodeId: node.id,
      operator: node.operator,
      reason: `único candidato para "${modelId}"`,
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
      const node = store.kick(decodeURIComponent(kickMatch[1]))
      return node ? sendJson(res, 200, node) : sendJson(res, 404, { error: 'nodo desconocido' })
    }

    const nodeMatch = pathname.match(/^\/v1\/nodes\/([^/]+)$/)
    if (req.method === 'POST' && nodeMatch) {
      const id = decodeURIComponent(nodeMatch[1])
      if (!store.getNode(id)) return sendJson(res, 404, { error: 'nodo desconocido' })

      let patch
      try {
        patch = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: 'body invalido, se esperaba JSON' })
      }

      // Antes se pisaba `updated` con el resultado de cada set: un status
      // invalido devolvia null y el endpoint respondia 404 "nodo desconocido"
      // -aunque el nodo existiera Y el pricing ya se hubiera aplicado-.
      //
      // Se valida TODO antes de tocar nada: un request con un campo invalido
      // no puede dejar el otro aplicado a medias. La existencia del nodo se
      // chequea una sola vez arriba.
      const hasPricing = patch.pricing !== undefined
      const hasStatus = patch.status !== undefined

      if (!hasPricing && !hasStatus) {
        return sendJson(res, 400, { error: 'nada para actualizar: mandá "pricing" o "status"' })
      }
      if (hasPricing && typeof patch.pricing !== 'string') {
        return sendJson(res, 400, { error: '"pricing" tiene que ser un string' })
      }
      if (hasStatus && patch.status !== 'online' && patch.status !== 'offline') {
        return sendJson(res, 400, { error: '"status" tiene que ser "online" u "offline"' })
      }

      let updated = null
      if (hasPricing) updated = store.setPricing(id, patch.pricing)
      if (hasStatus) updated = store.setStatus(id, patch.status)
      return sendJson(res, 200, updated)
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[gateway] error:', err)
    if (!res.headersSent) sendJson(res, 500, { error: String((err && err.message) || err) })
  }
}

export function createGateway({ port = 8787, gpuLayers: gpu } = {}) {
  gpuLayers = Number.isFinite(gpu) ? gpu : undefined

  store.seed()
  store.startFluctuation()

  const server = http.createServer(onRequest)

  // Sin este handler, arrancar con el puerto ocupado tira un
  // `Uncaught Error: address already in use` con stack de bare-tcp y nada mas.
  // Es el error mas probable de la demo -quedo un gateway viejo corriendo- y
  // el mensaje tiene que decir que hacer.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n[gateway] el puerto ${port} ya esta en uso.`)
      console.error('[gateway] cerra el otro gateway, o arranca con --port <otro>.\n')
    } else {
      console.error('\n[gateway] no se pudo abrir el servidor:', (err && err.message) || err)
    }
    Bare.exit(1)
  })

  server.listen(port, () => {
    console.log('')
    console.log(`  [gateway] escuchando en http://localhost:${port}`)
    console.log(`  [gateway] cliente:   http://localhost:${port}/`)
    console.log(`  [gateway] proveedor: http://localhost:${port}/proveedor`)
    console.log(`  [gateway] admin:     http://localhost:${port}/admin`)
    if (gpuLayers !== undefined) console.log(`  [gateway] gpu_layers: ${gpuLayers}`)
    console.log('')
  })
  return server
}

export async function shutdownGateway() {
  store.stopFluctuation()
  if (engineMod && realModelId) await engineMod.shutdown(realModelId)
}
