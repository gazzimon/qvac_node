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
// RUTEO: contra el registro en memoria (store.mjs), que se puebla de tres
// fuentes distintas y las trata distinto:
//   kind 'peer' -> par descubierto por Hyperswarm con manifiesto firmado
//                  verificado. La inferencia viaja por chat:request/chat:chunk
//                  sobre el FramedStream del swarm (D1). Requiere --swarm.
//   kind 'real' -> este equipo, via engine.mjs.
//   kind 'mock' -> respuesta enlatada. Solo existe con --demo.
// Para un mismo modelId se prefiere el par P2P (ver findAllByModelId), y el
// log de routing dice cuantos candidatos hubo.

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

// ---------------------------------------------------------------------------
// Inferencia contra un par remoto (Fase 3)
// ---------------------------------------------------------------------------

// El par no acuso recibo: esta muerto, o es de una version que no entiende
// chat:request. Corto a proposito -- todavia no le costo nada a nadie.
const ACCEPT_TIMEOUT_MS = 8000

// Ya acuso recibo y esta trabajando, pero puede estar cargando 807 MB de pesos
// por primera vez. Generoso por eso; no infinito, porque un cuelgue del SDK del
// otro lado no puede dejar al cliente esperando para siempre.
const FIRST_CHUNK_TIMEOUT_MS = 120000

// Ya venian tokens y se cortaron sin un chat:done. La conexion sigue viva
// (si se cayera, el swarm avisa al instante), asi que esto es el par trabado.
const IDLE_TIMEOUT_MS = 60000

let swarmRef = null

export function setSwarm(swarm) {
  swarmRef = swarm
}

// Un intento contra UN par. Resuelve siempre (nunca rechaza) con el resultado,
// incluyendo si alcanzo a emitir algun chunk -- que es el dato con el que D4
// decide si se puede reintentar en otro candidato.
function streamFromPeer({ node, model, messages, onChunk }) {
  return new Promise((resolve) => {
    let started = false
    let finished = false
    let timer = null
    let requestId = null

    const finish = (r) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      // Si se corta por timeout o error, se le avisa al par para que deje de
      // generar: seguir gastando su CPU en tokens que ya no tienen destino es
      // justo lo que chat:cancel existe para evitar.
      if (!r.ok && requestId) swarmRef.cancelChat(requestId)
      resolve({ ...r, started })
    }

    const arm = (ms, message, code) => {
      clearTimeout(timer)
      timer = setTimeout(() => finish({ ok: false, message, code }), ms)
      timer.unref?.()
    }

    requestId = swarmRef.chatRequest(
      node.peerKey,
      { model, messages },
      {
        onAccepted: () => {
          arm(
            FIRST_CHUNK_TIMEOUT_MS,
            'el par acepto el request pero no mando ningun token',
            'peer_timeout'
          )
        },
        onChunk: (delta) => {
          started = true
          arm(IDLE_TIMEOUT_MS, 'el par dejo de mandar tokens a mitad del stream', 'peer_stalled')
          onChunk(delta)
        },
        onDone: () => finish({ ok: true }),
        onError: (message, code) => finish({ ok: false, message, code })
      }
    )

    if (!requestId)
      return finish({ ok: false, message: 'el par ya no esta conectado', code: 'peer_gone' })
    arm(ACCEPT_TIMEOUT_MS, 'el par no acuso recibo del request', 'peer_no_ack')
  })
}

async function handleRemoteChat({ req, res, node, candidatos, model, messages, stream }) {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  const pares = candidatos.filter((n) => n.kind === 'peer')

  // Los headers se escriben RECIEN con el primer token, no al elegir el par.
  // Es lo que hace posible D4: mientras no se le mando nada al cliente, un
  // fallo todavia puede viajar como status HTTP y se puede probar otro par.
  let headersSent = false
  let contenido = ''
  const startedAt = Date.now()

  const emit = (delta) => {
    contenido += delta
    if (!stream) return
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const open = chunkEvent({ id, created, model, delta: { role: 'assistant' } })
      res.write(`data: ${JSON.stringify(open)}\n\n`)
      headersSent = true
    }
    const ev = chunkEvent({ id, created, model, delta: { content: delta } })
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  // El cliente cerro la pestaña: hay que avisarle al par. Sin esto el par
  // sigue generando para nadie y su slot queda ocupado de gratis -- en un
  // marketplace eso es CPU que alguien esta pagando.
  let cancelado = false
  let requestIdEnVuelo = null
  const onClientGone = () => {
    cancelado = true
    if (requestIdEnVuelo) swarmRef.cancelChat(requestIdEnVuelo)
  }
  req.on('close', onClientGone)
  res.on('close', onClientGone)

  const intentos = []
  let elegido = null
  let ultimo = null

  for (const cand of pares) {
    if (cancelado) break
    elegido = cand
    store.beginRequest(cand.id)
    try {
      const r = await streamFromPeer({
        node: cand,
        model,
        messages,
        onChunk: (d) => {
          requestIdEnVuelo = null // ya arranco: no hay nada que cancelar preventivamente
          emit(d)
        }
      })
      ultimo = r
      intentos.push({ nodeId: cand.id, operator: cand.operator, ok: r.ok, code: r.code || null })

      if (r.ok) break
      // D4: si ya se le mando aunque sea un token al cliente, NO se reintenta.
      // El contexto de una respuesta a medias no se puede retomar en otro nodo.
      if (r.started) break
      console.log(
        `[gateway] ${cand.operator} fallo antes del primer token (${r.code}), pruebo otro`
      )
    } finally {
      store.endRequest(cand.id)
    }
  }

  try {
    if (ultimo && ultimo.ok) {
      if (!stream) {
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: contenido }, finish_reason: 'stop' }
          ]
        })
      }
      if (!headersSent) {
        // El par contesto OK pero sin un solo token. Es raro y hay que decirlo,
        // no devolver un 200 vacio que el cliente lee como respuesta valida.
        return sendError(res, 502, 'el par termino el request sin devolver ningun token', {
          type: 'server_error',
          code: 'empty_response'
        })
      }
      const close = chunkEvent({ id, created, model, delta: {}, finishReason: 'stop' })
      res.write(`data: ${JSON.stringify(close)}\n\n`)
      res.write('data: [DONE]\n\n')
      return
    }

    // Fracaso. Si no se escribio nada todavia, viaja como status HTTP.
    const motivo = ultimo ? ultimo.message : 'no hay ningun par sirviendo ese modelo'
    const code = ultimo ? ultimo.code : 'no_peer'

    if (!headersSent) {
      return sendError(res, 502, `el par remoto no pudo responder: ${motivo}`, {
        type: 'server_error',
        code
      })
    }
    const payload = JSON.stringify({ error: { message: motivo, type: 'server_error', code } })
    res.write(`data: ${payload}\n\n`)
    res.write('data: [DONE]\n\n')
  } finally {
    if (headersSent || !stream) res.end()
    else if (!res.writableEnded) res.end()

    store.pushLog({
      modelId: model,
      nodeId: elegido ? elegido.id : null,
      operator: elegido ? elegido.operator : null,
      candidatos: candidatos.length,
      reason:
        `par P2P${pares.length > 1 ? ` (${intentos.length} de ${pares.length} intentados)` : ''}` +
        ` — ${candidatos.length} candidato(s) para "${model}"; elegir por carga es D6, sin implementar`,
      intentos: intentos.length > 1 ? intentos : undefined,
      ms: Date.now() - startedAt
    })
  }
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

  // Un par del swarm: los tokens vienen de OTRA maquina por el FramedStream
  // que el swarm ya tiene abierto. Sin swarm conectado no hay a quien
  // preguntarle, y decirlo asi es mejor que un 500 generico.
  if (node.kind === 'peer') {
    if (!swarmRef) {
      return sendError(res, 503, 'el gateway no esta unido al swarm; arranca con serve --swarm', {
        type: 'server_error',
        code: 'swarm_not_joined'
      })
    }
    return await handleRemoteChat({ req, res, node, candidatos, model, messages, stream })
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
