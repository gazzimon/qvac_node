// Gateway del marketplace. Sirve los 3 paneles y una API compatible con OpenAI.
//
// QUE ES COMPATIBLE (probado en test/index.js):
//   POST /v1/chat/completions  acepta { model, messages[], stream } y responde
//     - con stream:true  -> SSE de `chat.completion.chunk` (choices[].delta.content)
//     - con stream:false -> un `chat.completion` (choices[].message.content)
//   GET  /v1/models            devuelve { object:"list", data:[{id,object:"model",...}] }
//   Los errores viajan como { error: { message, type, code } }, la forma de OpenAI.
//
// QUE NO ESTA (dicho aca para que nadie lo descubra en la demo):
//   - `usage` (conteo de tokens) NO se emite. El SDK no lo expone por ahora y
//     un conteo inventado es peor que un campo ausente: un cliente que factura
//     por token leeria un numero falso. Ausente es honesto y no rompe a nadie
//     que use chat simple.
//   - Sin `tools`/`function_call`, sin `n`>1, sin `logprobs`.
//
// EXTENSIONES PROPIAS (no chocan con OpenAI, ningun cliente suyo las manda):
//   - El request tambien acepta la forma corta { modelId, prompt }.
//   - GET /v1/nodes devuelve la vista rica del marketplace (precio, operador,
//     carga) que consumen los paneles. /v1/models queda para el protocolo.
//
// El ruteo todavia NO es P2P: va contra un registro en memoria (store.mjs), no
// contra peers descubiertos por Hyperswarm -- eso es Fase 2-b/2-c del ROADMAP.

import http from 'bare-http1'
import * as store from './store.mjs'

const MOCK_REPLIES = {
  'facturas-ar': (prompt) =>
    `Lei tu comprobante. Segun el formato AFIP detecto: tipo "Factura B", ` +
    `CAE simulado 71234567890123, importe total estimado a partir de tu pedido ("${truncate(prompt)}") ` +
    `pendiente de validar contra el padron. (Respuesta simulada — este nodo es una demo.)`,
  'arquitectura-planos': (prompt) =>
    `Analizando el plano que describis ("${truncate(prompt)}"): identifico una posible planta de 3 ambientes, ` +
    `superficie cubierta aproximada 68 m², y sugiero revisar el retiro de fondo segun el codigo de ` +
    `edificacion local. (Respuesta simulada — este nodo es una demo.)`,
  'traductor-en-es': (prompt) =>
    `Traduccion simulada de "${truncate(prompt)}": esto representa el texto trasladado al espanol, ` +
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

// ---------------------------------------------------------------------------
// Forma OpenAI
// ---------------------------------------------------------------------------

let idCounter = 0

// `crypto.randomUUID` no existe en bare, y el id solo tiene que ser unico
// dentro de este proceso: es la clave con la que el cliente correlaciona los
// chunks de UNA respuesta, no un identificador global.
function completionId() {
  return 'chatcmpl-' + Date.now().toString(36) + (idCounter++).toString(36)
}

function chunkEvent({ id, created, model, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
}

// La forma exacta de un error de OpenAI. Los clientes (incluido Hermes) leen
// `error.message`; devolver un string plano los deja sin mensaje que mostrar.
function sendError(res, statusCode, message, { type = 'invalid_request_error', code = null } = {}) {
  const payload = JSON.stringify({ error: { message, type, code } })
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(payload)
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

// Traduce el body recibido a { model, messages, stream }. Acepta la forma de
// OpenAI y la forma corta propia; devuelve { error } si no es ninguna de las
// dos, para que el llamador responda 400 con un mensaje que diga que falta.
export function normalizeRequest(body) {
  // El default de OpenAI es stream:false, y hay que respetarlo: un cliente que
  // omite el campo espera UN json completo, no un SSE que su parser no va a
  // entender. Los paneles y el curl de la demo mandan stream:true explicito.
  const stream = body.stream === true

  // Forma corta propia: { modelId, prompt }
  if (body.model === undefined && body.modelId !== undefined) {
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      return { error: 'la forma corta necesita "prompt" (string no vacio)' }
    }
    return {
      model: body.modelId,
      messages: [{ role: 'user', content: body.prompt }],
      stream
    }
  }

  if (typeof body.model !== 'string' || body.model === '') {
    return { error: 'falta "model" (string con el id del modelo)' }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: '"messages" tiene que ser un array con al menos un mensaje' }
  }

  const messages = []
  for (const m of body.messages) {
    if (!m || typeof m.role !== 'string') {
      return { error: 'cada mensaje necesita "role" y "content" de tipo string' }
    }
    // OpenAI admite content como array de partes ({type:'text',text}). Se
    // aplanan las de texto y se ignoran las de imagen: este gateway no tiene
    // modelos multimodales, y cortar con error dejaria afuera a clientes que
    // mandan el array por default aunque solo lleven texto.
    let content = m.content
    if (Array.isArray(content)) {
      content = content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
    }
    if (typeof content !== 'string') {
      return { error: `el mensaje con role "${m.role}" no trae contenido de texto` }
    }
    messages.push({ role: m.role, content })
  }

  return { model: body.model, messages, stream }
}

// El texto que alimenta a los nodos mock: el ultimo turno del usuario. El nodo
// real NO usa esto, recibe `messages` entero como `history` y conserva el
// contexto de la conversacion.
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages[messages.length - 1].content
}

async function handleChat(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendError(res, 400, 'body invalido, se esperaba JSON')
  }

  const norm = normalizeRequest(body)
  if (norm.error) return sendError(res, 400, norm.error)

  const { model, messages, stream } = norm

  // Con pares del swarm puede haber DOS nodos sirviendo el mismo modelId, algo
  // que no pasaba con el registro simulado. Se traen todos para poder loguear
  // cuantos habia; elegir por carga entre ellos es D6 y sigue sin implementar,
  // asi que se toma el primero -- pero el log lo dice, no finge una decision.
  const candidatos = store.findAllByModelId(model)
  const node = candidatos[0] || null
  if (!node) {
    // D5: nunca un cuelgue silencioso. El mensaje dice que modelos SI hay
    // ahora mismo, que es lo unico accionable para quien lo recibe -- y es el
    // caso mas probable si alguien apunta un cliente con otro modelo default.
    const disponibles = store
      .listNodes()
      .filter((n) => n.status === 'online')
      .map((n) => n.modelId)
    const detalle = disponibles.length
      ? `disponibles: ${disponibles.join(', ')}`
      : 'no hay ningun nodo conectado en este momento'
    return sendError(res, 404, `no hay nodos sirviendo "${model}"; ${detalle}`, {
      code: 'model_not_found'
    })
  }

  // Un par del swarm ya se ANUNCIA (Fase 2-b) pero todavia no se le puede
  // pedir inferencia: chat:request/chat:chunk sobre el FramedStream es Fase 3.
  // Sin este corte, un peer caeria en el generador de mocks y el gateway
  // devolveria texto enlatado haciendolo pasar por inferencia remota real --
  // la peor falla posible, porque se ve exactamente igual que si funcionara.
  if (node.kind === 'peer') {
    return sendError(
      res,
      501,
      `"${model}" lo sirve un par remoto (${node.operator}) y el transporte de ` +
        'inferencia P2P todavia no esta implementado (Fase 3 del ROADMAP). ' +
        'El par esta descubierto y su manifiesto verificado, pero no se le pueden ' +
        'pedir tokens por ahora.',
      { type: 'server_error', code: 'p2p_inference_not_implemented' }
    )
  }

  const prompt = lastUserText(messages)
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)

  // El iterable de deltas es el mismo para stream y no-stream: la unica
  // diferencia es como se empaqueta la salida.
  const deltas = async function* () {
    if (node.kind === 'real') {
      const mid = await ensureRealModel()
      yield* engineMod.complete({ modelId: mid, history: messages })
    } else {
      yield* mockTokens(node, prompt)
    }
  }

  store.beginRequest(node.id)
  const startedAt = Date.now()

  // El camino no-stream y el de error-antes-de-headers responden con
  // `res.end()` adentro de sendJson/sendError. Sin este flag, el `finally`
  // llamaba a `res.end()` una segunda vez sobre una respuesta ya cerrada.
  let responded = false

  try {
    if (!stream) {
      // Se junta todo y se responde un `chat.completion` unico. Un error aca
      // todavia puede viajar con su status HTTP correcto, porque no se
      // escribio ni un byte de la respuesta.
      let content = ''
      for await (const delta of deltas()) content += delta
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
      })
      responded = true
    } else {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      // OpenAI abre con un chunk que solo anuncia el rol. Hay clientes que lo
      // dan por sentado para inicializar el mensaje antes del primer contenido.
      const open = chunkEvent({ id, created, model, delta: { role: 'assistant' } })
      res.write(`data: ${JSON.stringify(open)}\n\n`)

      for await (const delta of deltas()) {
        const ev = chunkEvent({ id, created, model, delta: { content: delta } })
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
      }

      const close = chunkEvent({ id, created, model, delta: {}, finishReason: 'stop' })
      res.write(`data: ${JSON.stringify(close)}\n\n`)
      res.write('data: [DONE]\n\n')
    }
  } catch (err) {
    const message = String((err && err.message) || err)
    if (!res.headersSent) {
      sendError(res, 500, message, { type: 'server_error' })
      responded = true
    } else {
      // Ya se empezo a streamear: no hay status HTTP que cambiar. El error va
      // dentro del canal SSE y se corta -- D4: no se reintenta en otro nodo,
      // el cliente ya tiene una respuesta parcial que no se puede retomar.
      const payload = JSON.stringify({ error: { message, type: 'server_error', code: null } })
      res.write(`data: ${payload}\n\n`)
      res.write('data: [DONE]\n\n')
    }
  } finally {
    store.endRequest(node.id)
    if (!responded) res.end()
    // El motivo dice lo que REALMENTE pasó. Antes decía "menor carga relativa
    // (simulado)", que era falso: cada nodo tiene un modelId único, así que
    // `findByModelId` nunca elige entre dos candidatos. Elegir por carga es
    // D6 del ROADMAP y todavía no está implementado; el log no puede afirmar
    // una decisión que no ocurrió.
    store.pushLog({
      modelId: model,
      nodeId: node.id,
      operator: node.operator,
      candidatos: candidatos.length,
      reason:
        candidatos.length === 1
          ? `único candidato para "${model}"`
          : `primero de ${candidatos.length} candidatos para "${model}" — elegir por carga es D6, sin implementar`,
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
    // Formato OpenAI estricto: es lo que lee un cliente de terceros.
    if (req.method === 'GET' && pathname === '/v1/models') {
      const created = Math.floor(Date.now() / 1000)
      const data = store
        .listNodes()
        .filter((n) => n.status === 'online')
        .map((n) => ({ id: n.modelId, object: 'model', created, owned_by: n.operator }))
      return sendJson(res, 200, { object: 'list', data })
    }
    // Vista rica del marketplace: precio, operador, carga. La consumen los
    // paneles; no es parte del protocolo de OpenAI y por eso vive aparte.
    if (req.method === 'GET' && pathname === '/v1/nodes') {
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
      return node ? sendJson(res, 200, node) : sendError(res, 404, 'nodo desconocido')
    }

    const nodeMatch = pathname.match(/^\/v1\/nodes\/([^/]+)$/)
    if (req.method === 'POST' && nodeMatch) {
      const id = decodeURIComponent(nodeMatch[1])
      if (!store.getNode(id)) return sendError(res, 404, 'nodo desconocido')

      let patch
      try {
        patch = await readJsonBody(req)
      } catch {
        return sendError(res, 400, 'body invalido, se esperaba JSON')
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
        return sendError(res, 400, 'nada para actualizar: mandá "pricing" o "status"')
      }
      if (hasPricing && typeof patch.pricing !== 'string') {
        return sendError(res, 400, '"pricing" tiene que ser un string')
      }
      if (hasStatus && patch.status !== 'online' && patch.status !== 'offline') {
        return sendError(res, 400, '"status" tiene que ser "online" u "offline"')
      }

      let updated = null
      if (hasPricing) updated = store.setPricing(id, patch.pricing)
      if (hasStatus) updated = store.setStatus(id, patch.status)
      return sendJson(res, 200, updated)
    }

    sendError(res, 404, 'not found', { code: 'not_found' })
  } catch (err) {
    console.error('[gateway] error:', err)
    if (!res.headersSent) {
      sendError(res, 500, String((err && err.message) || err), { type: 'server_error' })
    }
  }
}

export function createGateway({ port = 8787, gpuLayers: gpu, demo = false } = {}) {
  gpuLayers = Number.isFinite(gpu) ? gpu : undefined

  // Sin --demo el gateway arranca VACIO: cero nodos, cero mocks. Es el estado
  // real de Fase 3 antes de que un peer se anuncie por el swarm, y hace que el
  // camino de error de D5 sea el default y no una rama que nadie ejercita.
  if (demo) {
    store.seed()
    store.startFluctuation()
  }

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
    if (demo) {
      console.log('  [gateway] modo --demo: nodos SIMULADOS en el registro (ver README)')
    } else {
      console.log('  [gateway] registro vacio: ningun nodo anunciado todavia.')
      console.log('  [gateway] para la demo con nodos simulados: serve --demo')
    }
    console.log('')
  })
  return server
}

export async function shutdownGateway() {
  store.stopFluctuation()
  if (engineMod && realModelId) await engineMod.shutdown(realModelId)
}
