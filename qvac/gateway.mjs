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
import * as apikeys from './apikeys.mjs'
import * as budget from './budget.mjs'
import * as costs from './costs.mjs'
import * as quota from './quota.mjs'
import { pickCandidate, estaSaturado } from './routing.mjs'

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

// Tokens por segundo de la GENERACION, no del request: se descuenta el TTFT.
// Mezclarlos daria un numero que baja cuando el modelo tarda en arrancar
// aunque despues escupa tokens igual de rapido, y esa es justo la confusion
// que el par de numeros (ttft + tok/s) existe para evitar.
//
// Devuelve null en vez de 0 cuando no hay nada que medir: un request que fallo
// antes del primer token no genero "a cero tokens por segundo", no genero.
function tokensPerSec({ tokens, ttftMs, ms }) {
  if (!tokens || ttftMs === null) return null
  const genMs = ms - ttftMs
  if (genMs <= 0) return null
  return Number(((tokens / genMs) * 1000).toFixed(2))
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
      const t0 = Date.now()
      engineMod = engineMod || (await import('./engine.mjs'))
      const { modelSrc } = await engineMod.resolveModel('llama1b')
      realModelId = await engineMod.loadModel({ modelSrc, gpuLayers })

      // La carga perezosa es la explicacion de casi todo TTFT anomalo: el
      // primer chat despues de arrancar paga la descarga y la carga del
      // modelo, y sin esta entrada el rastro muestra un request lentisimo sin
      // ninguna causa visible al lado.
      store.pushLog({
        kind: 'model_load',
        modelId: 'llama1b',
        target: 'local',
        ok: true,
        gpuLayers: gpuLayers ?? null,
        reason: `modelo real cargado en ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        ms: Date.now() - t0
      })
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

function sendJson(res, statusCode, body, extraHeaders = null) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...(extraHeaders || {}) })
  res.end(payload)
}

// Quien contesto, en la respuesta misma.
//
// Va en headers y no en el cuerpo a proposito: meter un campo propio adentro
// de un `chat.completion.chunk` ensuciaria el formato de OpenAI, que es
// justamente lo que este gateway promete respetar. Un header extra no lo ve
// ningun cliente de terceros y el chat propio lo lee con headers.get().
//
// encodeURIComponent porque un header no puede llevar bytes fuera de latin-1 y
// el nombre del operador lo elige una persona ("Nodo de Ramón").
function provenanceHeaders(node) {
  return {
    'X-Pyrus-Operator': encodeURIComponent((node && node.operator) || ''),
    'X-Pyrus-Kind': (node && node.kind) || 'unknown',
    'X-Pyrus-Model': encodeURIComponent((node && node.modelId) || '')
  }
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

// El nombre llega de la query, o sea del browser, o sea de cualquiera que le
// pegue al endpoint. Sin esto, un name de "../../.ssh/authorized_keys" escribe
// donde no debe: el path se arma con join() y `..` lo saca de la carpeta.
// Se queda SOLO con el nombre base y con caracteres que existan en los tres
// sistemas de archivos que nos importan.
function sanitizeFilename(nombre) {
  const base = String(nombre).replace(/\\/g, '/').split('/').pop() || ''
  const limpio = base
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return limpio === '.' || limpio === '..' ? '' : limpio
}

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

function uploadsDir() {
  return storageSubdir('uploads')
}

function descargasDir() {
  return storageSubdir('descargas')
}

// Las dos carpetas cuelgan del storage del nodo y no del cwd: `serve` puede
// arrancar desde cualquier lado y los archivos no tienen por que aparecer
// donde el operador ejecuto el comando.
function storageSubdir(nombre) {
  const base = filesApi && filesApi.dir ? filesApi.dir : '.'
  return base.replace(/[\\/]+$/, '') + '/' + nombre
}

// Se escribe por stream, no con Buffer.concat: un archivo grande bufferizado
// entero es memoria del proceso que ademas esta sirviendo inferencia.
async function recibirArchivo(req, nombre) {
  const fs = await import('bare-fs')
  const dir = uploadsDir()
  await fs.default.promises.mkdir(dir, { recursive: true })
  const destino = dir + '/' + nombre

  let total = 0
  const out = fs.default.createWriteStream(destino)

  // Enganchado ANTES de escribir nada. Un 'error' de stream sin listener es
  // una excepcion no capturada que tumba TODO el proceso -el que tambien
  // esta sirviendo inferencia-, no solo este upload. Se guarda en vez de
  // reaccionar en el acto: el for-await de abajo es quien decide cuando
  // cortar, para no pisar el catch de "demasiado grande" a mitad de un write.
  let streamErr = null
  out.on('error', (err) => {
    streamErr = streamErr || err
  })

  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_UPLOAD_BYTES) {
        throw new Error(
          `archivo demasiado grande (limite ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`
        )
      }
      if (streamErr) throw streamErr
      if (!out.write(chunk)) {
        // Sin el 'error' aca, un stream que muere ESPERANDO drenar nunca
        // dispara ni resolve ni reject: el request queda colgado para
        // siempre en vez de fallar.
        await new Promise((resolve) => {
          out.once('drain', resolve)
          out.once('error', resolve)
        })
        if (streamErr) throw streamErr
      }
    }
  } catch (err) {
    out.destroy()
    // Un upload cortado a la mitad deja un archivo truncado que despues se
    // publica como si estuviera completo. Se borra antes de propagar.
    await fs.default.promises.unlink(destino).catch(() => {})
    throw err
  }

  await new Promise((resolve, reject) => {
    if (streamErr) return reject(streamErr)
    out.end(() => resolve())
    out.once('error', reject)
  })
  if (total === 0) {
    await fs.default.promises.unlink(destino).catch(() => {})
    throw new Error('el archivo llego vacio')
  }
  return destino
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

  // Extension propia: "que este prompt no salga de esta maquina". Ningun
  // cliente de OpenAI la manda, y omitirla deja el comportamiento de siempre.
  const local = body.local === true

  // Extension propia: fijar la MAQUINA, no solo el modelo. `model` dice QUE se
  // quiere; `node` dice A QUIEN se le pide. Son dos preguntas distintas y hasta
  // ahora solo se podia contestar la primera: con dos pares sirviendo el mismo
  // modelId no habia forma de elegir uno.
  //
  // El valor es el `id` de la fila del registro, que es lo que /v1/nodes ya
  // devuelve, asi que el panel no necesita nada nuevo del backend.
  const pin = typeof body.node === 'string' && body.node.trim() !== '' ? body.node.trim() : null

  // `max_tokens` de OpenAI. Se lee para la estimacion de costo de la Fase 6.5:
  // la reserva es la COTA SUPERIOR del gasto, y sin un tope de salida no hay
  // cota superior que calcular. Cero significa "no lo mando", no "cero
  // tokens" -- el gateway no lo impone todavia, solo lo mira.
  const pedido = Number(body.max_tokens)
  const maxTokens = Number.isFinite(pedido) && pedido > 0 ? Math.floor(pedido) : 0

  // Forma corta propia: { modelId, prompt }
  if (body.model === undefined && body.modelId !== undefined) {
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      return { error: 'la forma corta necesita "prompt" (string no vacio)' }
    }
    return {
      model: body.modelId,
      messages: [{ role: 'user', content: body.prompt }],
      stream,
      local,
      pin,
      maxTokens
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

  // `local` viaja tambien por acá. Faltaba: la forma corta ({modelId, prompt})
  // lo devolvia y la forma estandar de OpenAI no, asi que el toggle "local
  // only" del chat -- que manda la forma estandar, ver pages.mjs -- llegaba
  // como undefined y el filtro de handleChat nunca se aplicaba. El prompt
  // podia salir a un par con el candado puesto en la pantalla.
  return { model: body.model, messages, stream, local, pin, maxTokens }
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

// El Hyperdrive del nodo. Lo inyecta bin.mjs despues de abrirlo, igual que el
// swarm: el gateway no lo abre por su cuenta porque el Corestore toma un lock
// de RocksDB sobre su carpeta y un segundo `openStore` sobre el mismo path
// falla. Un solo dueño del almacen, y el gateway es invitado.
let filesApi = null

export function setFiles(f) {
  filesApi = f
}

export function setSwarm(swarm) {
  swarmRef = swarm
}

// ---------------------------------------------------------------------------
// FASE 8.5 — el asistente externo
//
// El gateway recibe las instancias ya construidas, igual que el swarm y el
// drive: quien lee `upstreams.json` es bin.mjs, que es el dueno del directorio
// de storage. Aca solo se sabe que existen y con que fila del registro se
// corresponden.
//
// La clave del Map es el `id` de la fila del store (`upstream:<id>`), que es
// lo que trae el candidato elegido: asi el despacho no tiene que volver a
// buscar por modelo ni adivinar cual de dos upstreams del mismo proveedor era.
// ---------------------------------------------------------------------------
let upstreams = new Map()

// D19: mandarle el prompt a un tercero esta APAGADO salvo que el operador lo
// prenda. El default vive aca y no en la config para que un archivo ausente,
// vacio o roto signifique lo mismo que un "no".
let upstreamOptIn = false

export function setUpstreams(lista) {
  upstreams = new Map()
  for (const u of lista || []) upstreams.set(`upstream:${u.id}`, u)
}

export function setUpstreamOptIn(valor) {
  upstreamOptIn = valor === true
  return upstreamOptIn
}

export function upstreamStatus() {
  return {
    optIn: upstreamOptIn,
    upstreams: [...upstreams.values()].map((u) => ({
      id: u.id,
      nodeId: `upstream:${u.id}`,
      label: u.label,
      model: u.model,
      displayName: u.displayName,
      maxTokens: u.maxTokens,
      // El NOMBRE de la variable de entorno, nunca su valor.
      apiKeyEnv: u.apiKeyEnv,
      credencial: u.disponible()
    }))
  }
}

// El tope de salida efectivo de un upstream: el menor entre lo que pidio el
// cliente y lo que el nodo permite. Se calcula ACA -- y no solo adentro de
// `completar`-- porque es el numero con el que se estima la reserva, y una
// reserva calculada sobre un tope distinto del que se manda no acota nada.
function topeDeSalida(node, pedido) {
  const up = upstreams.get(node && node.id)
  if (!up) return pedido
  return pedido > 0 ? Math.min(pedido, up.maxTokens) : up.maxTokens
}

// Tokens del prompt, estimados por caracteres, SOLO para la reserva.
//
// El numero exacto lo sabe el tokenizador del proveedor y llega recien con el
// `usage` del ultimo chunk -- despues de gastar-. Se divide por 3 y no por los
// ~4 caracteres por token que es la regla habitual: la reserva es una cota
// SUPERIOR, y equivocarse para arriba corta antes de tiempo mientras que
// equivocarse para abajo deja pasar gasto por encima del tope.
function estimarPromptTokens(messages) {
  let chars = 0
  for (const m of messages || []) chars += String((m && m.content) || '').length
  return Math.ceil(chars / 3)
}

// ---------------------------------------------------------------------------
// Lanzar el agente local desde la pagina.
//
// El gateway no sabe COMO se arma un swarm -- eso vive en bin.mjs, que es el
// unico dueño del Corestore-. Solo sabe que hay algo que lo arma y que tarda.
// Sin esto, "poner tu maquina a producir" significaba volver a la terminal y
// reiniciar el proceso con otro flag, que es justo lo que un boton no puede
// pedirle a nadie.
// ---------------------------------------------------------------------------
let launcher = null
let launchState = { status: 'offline', message: null }

// La credencial del propio panel. `keyForNode` reusa la entrada existente para
// el mismo id, asi que pedirla en cada carga devuelve LA MISMA key en vez de
// llenar el registro de huerfanas.
//
// El panel necesita una porque el gate dejo de aceptar requests sin
// Authorization: si el navegador no mandara credencial, la pagina de chat
// seria el unico cliente que no puede hablarle a su propio gateway.
const PANEL_KEY_ID = 'panel'

export function setLauncher(fn) {
  launcher = fn
}

export function agentStatus() {
  if (swarmRef) {
    return {
      status: 'live',
      operator: swarmRef.operator,
      publicKey: swarmRef.identity.publicKey.toString('hex'),
      verifiedPeers: swarmRef.verifiedPeers().length,
      canLaunch: launcher !== null,
      message: null
    }
  }
  return {
    status: launchState.status,
    operator: null,
    publicKey: null,
    verifiedPeers: 0,
    canLaunch: launcher !== null,
    message: launchState.message
  }
}

// Estado del ultimo cambio de modelo pedido desde el panel Proveedor.
// `null` = nunca se pidio uno en esta sesion (el modelo con el que arranco
// `serve --swarm` esta simplemente listo, no "cargando").
let modelLoadState = null

function currentModelEntry() {
  return swarmRef && swarmRef.models && swarmRef.models[0] ? swarmRef.models[0] : null
}

// Un intento contra UN par. Resuelve siempre (nunca rechaza) con el resultado,
// incluyendo si alcanzo a emitir algun chunk -- que es el dato con el que D4
// decide si se puede reintentar en otro candidato.
function streamFromPeer({ node, model, messages, onChunk, onStart }) {
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

    // El llamador necesita el requestId para poder cancelar si el cliente HTTP
    // se va. Antes esto no existia y `requestIdEnVuelo` quedaba en null: el
    // chat:cancel no tenia nunca un id que mandar, asi que el par seguia
    // generando para un cliente que ya no estaba.
    if (onStart) onStart(requestId)

    arm(ACCEPT_TIMEOUT_MS, 'el par no acuso recibo del request', 'peer_no_ack')
  })
}

async function handleRemoteChat({
  req,
  res,
  node,
  candidatos,
  model,
  messages,
  stream,
  // La reserva la abre handleChat, porque es el que sabe a que cuenta imputar.
  // Aca solo se liquida. Default para los tests, que llaman a esta funcion
  // directo sin pasar por el ledger.
  reserva = { id: null },
  // La maquina que el cliente fijo, si fijo alguna: corta el reintento.
  pin = null,
  // Por que se eligio a este candidato y no a otro. Va al log de ruteo.
  decision = null,
  motivo = null
}) {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  const pares = candidatos.filter((n) => n.kind === 'peer')

  // Los headers se escriben RECIEN con el primer token, no al elegir el par.
  // Es lo que hace posible D4: mientras no se le mando nada al cliente, un
  // fallo todavia puede viajar como status HTTP y se puede probar otro par.
  let headersSent = false
  let contenido = ''
  const startedAt = Date.now()

  // D7 del lado del SERVIDOR. Estos tres numeros ya se median en el navegador
  // (pages.mjs) y se perdian al cerrar la pestaña: eran evidencia de la demo
  // que no sobrevivia a la demo. Medidos aca entran al rastro persistido, asi
  // que despues se puede decir "este par dio 40 tok/s el martes" sin que
  // nadie haya tenido que mirar la pantalla en ese momento.
  let ttftMs = null
  let tokens = 0

  const emit = (delta) => {
    // El primer delta con contenido es el primer token, no el chunk de
    // apertura: ese solo trae {role} y llegaria antes, midiendo de menos.
    if (ttftMs === null) ttftMs = Date.now() - startedAt
    tokens++
    contenido += delta
    if (!stream || cancelado) return
    // Escribir en una respuesta que el cliente ya cerro puede tirar. Esta
    // funcion la llama el handler del FramedStream del swarm, asi que una
    // excepcion que se escape de aca sube hasta el 'data' del pipe y se lleva
    // puesto el canal con ese par -- para TODOS los requests, no solo este.
    try {
      emitUnsafe(delta)
    } catch (err) {
      cancelado = true
      if (requestIdEnVuelo) swarmRef.cancelChat(requestIdEnVuelo)
      console.log(`[gateway] no se pudo escribir al cliente: ${(err && err.message) || err}`)
    }
  }

  const emitUnsafe = (delta) => {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...provenanceHeaders(node)
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
        onStart: (rid) => {
          requestIdEnVuelo = rid
          // El cliente se fue MIENTRAS se armaba el request: se cancela ya
          // mismo, sin esperar a que el par empiece a generar.
          if (cancelado) swarmRef.cancelChat(rid)
        },
        onChunk: emit
      })
      requestIdEnVuelo = null
      ultimo = r
      intentos.push({ nodeId: cand.id, operator: cand.operator, ok: r.ok, code: r.code || null })

      if (r.ok) break
      // D4: si ya se le mando aunque sea un token al cliente, NO se reintenta.
      // El contexto de una respuesta a medias no se puede retomar en otro nodo.
      if (r.started) break

      // El par dijo que esta lleno. Es informacion mas fresca que el ultimo
      // `node:status`, que puede tener hasta 2s de atraso (swarm.mjs:48): sin
      // esto, los requests que entren en esa ventana lo vuelven a elegir y se
      // comen el mismo rechazo. S5 de NOTES-SATURACION.md.
      if (r.code === 'at_capacity') store.markSaturated(cand.id)

      // Con la maquina fijada por el cliente no hay a quien reintentarle: pedir
      // un nodo concreto y recibir la respuesta de otro es exactamente lo que
      // el pin existe para impedir.
      if (pin) break

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
        // Los mismos headers de procedencia que el camino con stream. Sin
        // esto, quien pide sin `stream:true` -- un curl, Open WebUI, cualquier
        // cliente OpenAI con el default -- nunca se entera de que maquina
        // contesto. La garantia no puede valer en una de las dos formas de
        // respuesta y en la otra no.
        return sendJson(
          res,
          200,
          {
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [
              { index: 0, message: { role: 'assistant', content: contenido }, finish_reason: 'stop' }
            ]
          },
          provenanceHeaders(elegido || node)
        )
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

    const ms = Date.now() - startedAt
    const ok = !!(ultimo && ultimo.ok)

    // Misma liquidacion que en el camino local. Hoy da cero: los tokens de un
    // par se pagaran en USD₮ contra su wallet (Fase 9), no contra este tope,
    // que es para el gasto en dolares del asistente externo.
    const costoReal = costs.real({ model, completionTokens: tokens })
    budget.settle(reserva.id, costoReal)

    store.pushLog({
      modelId: model,
      target: 'peer',
      costMicros: costoReal,
      nodeId: elegido ? elegido.id : null,
      operator: elegido ? elegido.operator : null,
      candidatos: candidatos.length,
      reason:
        `par P2P${pares.length > 1 ? ` (${intentos.length} de ${pares.length} intentados)` : ''}` +
        ` — ${motivo || `${candidatos.length} candidato(s) para "${model}"`}`,
      // POR QUE se eligio a este y no a otro: la carga del elegido y la de los
      // que quedaron atras. Es el DoD de la Fase 8 -- antes el log solo podia
      // decir "el primero", que no es un motivo.
      decision: decision || undefined,
      intentos: intentos.length > 1 ? intentos : undefined,
      ok,
      code: ok ? null : (ultimo && ultimo.code) || 'no_peer',
      tokens,
      ttftMs,
      tokensPerSec: tokensPerSec({ tokens, ttftMs, ms }),
      ms
    })

    // Contadores por par en el directorio. La funcion existia desde que se
    // escribio `directory.recordStat` y no la llamaba NADIE: las stats de cada
    // par quedaban en cero para siempre, y el panel mostraba un historial
    // vacio que parecia un par recien conocido. Se cuenta el par que
    // efectivamente atendio -o el ultimo que lo intento, si fallaron todos-.
    if (elegido && elegido.peerKey) {
      store.recordPeerResult(elegido.peerKey, { ok, ms, tokens })
    }
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

// Validacion OPCIONAL de la API key, y esta asimetria es deliberada:
//
//   - sin header Authorization  -> pasa. El panel se sirve del mismo origen y
//     no maneja credencial; pedirsela seria pedirle una llave a la casa que ya
//     esta adentro. Ademas mantiene andando cualquier curl viejo del runbook.
//   - con header Authorization  -> tiene que ser una key emitida por
//     /v1/connection. Una key mal pegada falla con 401 en vez de responder
//     igual, que es lo unico que hace que la credencial signifique algo.
//
// ESTO NO ES AUTENTICACION: sin header no hay puerta. Es lo que corresponde a
// una demo donde el gateway escucha en localhost, y esta escrito aca para que
// nadie lo confunda con seguridad de verdad al leer el codigo despues.
// El gate. Antes devolvia null cuando NO habia header -- o sea que cualquiera
// que llegara al puerto podia gastar tu GPU sin presentar nada, y la key solo
// servia para identificar a quien se molestaba en mandarla.
//
// Ahora falta de credencial es rechazo. El panel tampoco esta exento: pide la
// suya a /v1/keys/panel y la manda como cualquier otro cliente, asi hay UN
// solo camino de autenticacion y no una puerta trasera para el navegador.
function rechazoPorKey(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header || typeof header !== 'string') {
    return 'falta la api key: manda el header "Authorization: Bearer <api-key>"'
  }
  if (!header.startsWith('Bearer '))
    return 'el header Authorization tiene que ser "Bearer <api-key>"'
  const key = header.slice(7).trim()
  if (!key) return 'falta la api key despues de "Bearer"'
  return apikeys.verifyKey(key) ? null : 'api key desconocida o revocada'
}

// Que credencial vino en el request, para poder atribuirle el consumo. Se
// llama DESPUES de rechazoPorKey, asi que a esta altura ya se sabe que existe.
function keyLabelDe(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header || !header.startsWith('Bearer ')) return null
  const entry = apikeys.verifyKey(header.slice(7).trim())
  return entry ? entry.label : null
}

// A QUE CUENTA se le imputa el consumo (Fase 6.5). Es el id de la API key, no
// su texto: el id es estable y se puede escribir en un archivo sin que el
// ledger termine guardando credenciales en claro.
//
// La cuenta ES la key. No hay un modelo de usuarios aparte porque no hace
// falta todavia: cada cliente externo -- un bot de Telegram, una terminal, el
// panel -- ya tiene la suya, y esa es exactamente la granularidad a la que se
// quiere cortar.
function cuentaDe(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header || !header.startsWith('Bearer ')) return null
  const entry = apikeys.verifyKey(header.slice(7).trim())
  return entry ? entry.id : null
}

// La COTA SUPERIOR de lo que va a costar este request, en micro-dolares.
//
// Hoy da cero para todo, y eso no es un placeholder: es el precio real. La
// inferencia local no cuesta dolares y la de un par tampoco -- el pago P2P es
// la Fase 9, en USD₮ y contra la wallet del proveedor, no contra este tope.
// Lo unico que cuesta dolares es el asistente externo, que es la Fase 8.5.
//
// La funcion existe igual, y el gateway la llama en el camino comun, para que
// la reserva y la liquidacion esten EJERCITADAS antes de que haya plata de por
// medio. Un mecanismo de corte que se estrena el dia que empieza a cobrar es
// un mecanismo de corte sin probar.
// Con que clave se le pregunta el precio a costs.mjs.
//
// Para un upstream es el ID DE LA FILA, no el modelId, y la diferencia no es
// cosmetica: dos nodos pueden servir el mismo modelo con precios distintos --
// un par de la red sirviendo llama1b gratis y una API de un tercero cobrando
// por el mismo nombre-. Indexado por modelId, el precio del externo se le
// cobraba tambien al par, que no cobra nada. El precio es de QUIEN contesta.
function claveDePrecio(node) {
  if (!node) return null
  return node.kind === 'upstream' ? node.id : node.modelId
}

function estimarRequest({ node, maxTokens = 0, promptTokens = 0 }) {
  const clave = claveDePrecio(node)
  if (!clave || !costs.conocido(clave)) return 0
  return costs.estimar({ model: clave, promptTokens, maxTokens })
}

async function handleChat(req, res) {
  const motivo = rechazoPorKey(req)
  if (motivo) return sendError(res, 401, motivo)

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendError(res, 400, 'body invalido, se esperaba JSON')
  }

  const norm = normalizeRequest(body)
  if (norm.error) return sendError(res, 400, norm.error)

  const { model, messages, stream, local, pin } = norm

  // Con pares del swarm puede haber DOS nodos sirviendo el mismo modelId, algo
  // que no pasaba con el registro simulado. Se traen todos para poder loguear
  // cuantos habia. Elegir entre ellos ya NO es tomar el primero: lo decide
  // pickCandidate por carga (D6, cerrado en la Fase 8) y el motivo queda en el
  // log, asi que la decision se audita en vez de adivinarse.
  let candidatos = store.findAllByModelId(model)

  // "local only": el prompt no sale de esta maquina. Se filtra ANTES de elegir
  // -- si el unico candidato era remoto, el 404 de abajo tiene que decir que no
  // hay nadie local, y no rutear a la red igual.
  //
  // El upstream cae por el mismo filtro que el par, y esa linea es literal en
  // el DoD de la Fase 8.5: `local: true` nunca sale de la maquina, con o sin
  // opt-in. Un tercero al otro lado de una API no es menos "afuera" que un par
  // de la red -- es mas, porque ademas guarda logs.
  // Se cuentan ANTES de cualquier filtro: si `local` los saca, el error de mas
  // abajo tiene que poder decir que habia uno y por que no se uso.
  const externos = candidatos.filter((n) => n.kind === 'upstream')

  if (local) candidatos = candidatos.filter((n) => n.kind !== 'peer' && n.kind !== 'upstream')

  // D19 — las otras dos condiciones del externo. Se aplican como FILTRO de
  // candidatos y no como un `if` en el despacho: un upstream inelegible tiene
  // que ser invisible para pickCandidate, o terminaria ganando por carga (esta
  // siempre en 0) y recien ahi lo rechazariamos.
  let vetoExterno = null
  if (externos.length > 0) {
    if (local) {
      vetoExterno = {
        code: 'local_only',
        message: 'el pedido pide que nada salga de esta maquina'
      }
    } else if (!upstreamOptIn) {
      vetoExterno = {
        code: 'upstream_opt_in_required',
        message:
          'hay un asistente externo configurado, pero mandarle el prompt a un tercero esta apagado. ' +
          'Se prende con POST /v1/upstream/opt-in o con "optIn": true en upstreams.json.'
      }
    } else {
      // "Sin capacidad local" es la tercera condicion, y se mide sobre los
      // candidatos que NO son el externo: mientras alguien de esta red pueda
      // atender ahora, el externo no compite. Recien cuando estan todos llenos
      // -- o cuando no hay ninguno, que es el caso de un modelo que solo sirve
      // el externo -- entra a la puja.
      const propios = candidatos.filter((n) => n.kind !== 'upstream')
      const hayLugar = propios.some((n) => !estaSaturado(n))
      if (hayLugar) {
        vetoExterno = {
          code: 'upstream_not_needed',
          message: 'hay capacidad local o en la red para este modelo'
        }
      }
    }
    if (vetoExterno) candidatos = candidatos.filter((n) => n.kind !== 'upstream')
  }

  // Todos los candidatos que habia eran externos y quedaron vetados. El 404
  // generico de mas abajo diria "no hay nodos sirviendo ese modelo", que es
  // falso: hay uno, y no se lo uso por una decision. Decir cual es la decision
  // es lo unico accionable para el que recibe el error.
  if (candidatos.length === 0 && externos.length > 0 && vetoExterno) {
    const detalle =
      vetoExterno.code === 'local_only'
        ? `"${model}" solo lo sirve un asistente externo, y ${vetoExterno.message}`
        : vetoExterno.message
    return sendError(res, 503, detalle, {
      type: 'service_unavailable',
      code: vetoExterno.code
    })
  }

  const eleccion = pickCandidate(candidatos, { statsFor: store.statsFor, pin })

  // El cliente fijo una maquina que ya no esta entre los candidatos. NO se
  // rutea a otra: el que elige una maquina quiere esa, y contestarle con otra
  // sin avisar vacia de sentido a la funcion. El 404 dice cual pidio.
  if (pin && !eleccion.node) {
    return sendError(res, 404, eleccion.reason, { code: 'node_not_found' })
  }

  // `let` desde la Fase 8.5: con el presupuesto agotado el externo se cambia
  // por un candidato propio en vez de negar el servicio (ver mas abajo).
  let node = eleccion.node
  // El orden puntuado, no el de llegada: si el mejor falla antes del primer
  // token, D4 reintenta en el segundo MEJOR, no en el siguiente de la lista.
  candidatos = eleccion.orden
  // `motivo` a secas ya lo usa el rechazo por API key mas arriba.
  const motivoRuteo = eleccion.reason
  const decision = eleccion.decision
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

  // FASE 6.5 — la reserva va ACA: despues de saber a quien se le va a pedir
  // (porque el precio depende del nodo) y ANTES de pedirselo. Ese orden es
  // toda la fase: un tope que se evalua despues del gasto es un descuento.
  const cuenta = cuentaDe(req)
  const promptTokens = estimarPromptTokens(messages)
  let maxSalida = topeDeSalida(node, norm.maxTokens || 0)
  let reserva = budget.reserve(cuenta, estimarRequest({ node, maxTokens: maxSalida, promptTokens }))

  // Lo que la Fase 6.5 dejo escrito y no podia alcanzar: ahora el camino
  // externo estima distinto de cero, asi que el corte se ejerce de verdad.
  //
  // Y corta DEGRADANDO, no negando. El DoD de la Fase 8.5 es explicito: con el
  // presupuesto agotado se contesta local, con aviso, y nunca el externo. Solo
  // si no hay ningun candidato propio -- el caso de un modelo que unicamente
  // sirve el externo -- se devuelve el 402.
  let degradado = null
  if (!reserva.ok && node.kind === 'upstream') {
    // `candidatos` es el orden PUNTUADO, asi que el primero no-externo es el
    // mejor de los propios, no el primero que aparecio.
    const alternativa = candidatos.find((n) => n.kind !== 'upstream')
    if (alternativa) {
      degradado = {
        de: node.id,
        motivo: `presupuesto agotado: quedan ${costs.formatUSD(reserva.remaining)} de un tope de ${costs.formatUSD(reserva.cap)}`
      }
      node = alternativa
      maxSalida = topeDeSalida(node, norm.maxTokens || 0)
      reserva = budget.reserve(cuenta, estimarRequest({ node, maxTokens: maxSalida, promptTokens }))
    }
  }

  if (!reserva.ok) {
    return sendError(
      res,
      402,
      `presupuesto agotado: quedan ${costs.formatUSD(reserva.remaining)} de un tope de ${costs.formatUSD(reserva.cap)}`,
      { type: 'insufficient_quota', code: 'budget_exhausted' }
    )
  }

  // Un par del swarm: los tokens vienen de OTRA maquina por el FramedStream
  // que el swarm ya tiene abierto. Sin swarm conectado no hay a quien
  // preguntarle, y decirlo asi es mejor que un 500 generico.
  if (node.kind === 'peer') {
    if (!swarmRef) {
      // La puerta del producto: sin agente lanzado no se llega a la red. El
      // modelo local sigue disponible, y el mensaje lo dice -- un 503 que solo
      // niega deja al que lo lee sin siguiente paso.
      //
      // Se libera la reserva: este request no gasto nada. Toda salida
      // temprana que ya paso por reserve() tiene que liberar, o el saldo queda
      // comprometido para siempre por un request que nunca existio.
      budget.release(reserva.id)
      return sendError(
        res,
        503,
        'your node is offline, so the network is out of reach — launch your local agent to use it. Your own local model still answers.',
        { type: 'service_unavailable', code: 'agent_offline' }
      )
    }
    return await handleRemoteChat({
      req,
      res,
      pin,
      decision,
      motivo: motivoRuteo,
      node,
      candidatos,
      model,
      messages,
      stream,
      reserva
    })
  }

  const prompt = lastUserText(messages)
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)

  store.beginRequest(node.id)
  const startedAt = Date.now()

  // Mismos tres numeros que en el camino P2P, para que el rastro compare peras
  // con peras: sin esto el panel podia decir "40 tok/s" de un par y nada del
  // nodo local, que es exactamente la comparacion que la demo quiere mostrar.
  let ttftMs = null
  let tokens = 0

  // El `usage` que el proveedor externo manda en el ultimo chunk: son los
  // tokens REALES -- contados por SU tokenizador-- y son los que se liquidan.
  // Los de entrada no hay otra forma de saberlos: aca solo se ven caracteres.
  // Si el proveedor no lo manda, se liquida con lo contado en este proceso,
  // que es la mejor verdad disponible y nunca menos que cero.
  let usoExterno = null

  // El iterable de deltas es el mismo para stream y no-stream: la unica
  // diferencia es como se empaqueta la salida. La medicion va ACA adentro y no
  // en los dos consumidores por la misma razon: un solo lugar donde contar, y
  // el camino no-stream deja de ser el que nunca reporta nada.
  const deltas = async function* () {
    let crudos
    if (node.kind === 'real') {
      crudos = (async function* () {
        const mid = await ensureRealModel()
        yield* engineMod.complete({ modelId: mid, history: messages })
      })()
    } else if (node.kind === 'upstream') {
      // La fila del registro y la instancia que sabe hablar con la API son dos
      // cosas: la fila puede sobrevivir a una relectura de config que saco al
      // upstream, y en ese caso hay que fallar diciendolo -- no caer al mock,
      // que devolveria texto inventado con los headers de un proveedor real.
      const up = upstreams.get(node.id)
      if (!up) {
        throw new Error('el asistente externo ya no esta configurado en este nodo')
      }
      if (!up.disponible()) {
        throw new Error(
          'falta la credencial del asistente externo: pone la variable de entorno ' + up.apiKeyEnv
        )
      }
      crudos = up.completar({
        messages,
        maxTokens: maxSalida,
        onUsage: (u) => {
          usoExterno = u
        }
      })
    } else {
      crudos = mockTokens(node, prompt)
    }

    for await (const delta of crudos) {
      if (ttftMs === null) ttftMs = Date.now() - startedAt
      tokens++
      yield delta
    }
  }

  // El camino no-stream y el de error-antes-de-headers responden con
  // `res.end()` adentro de sendJson/sendError. Sin este flag, el `finally`
  // llamaba a `res.end()` una segunda vez sobre una respuesta ya cerrada.
  let responded = false

  // El camino local no tenia forma de decir en el log que un request habia
  // fallado: el `finally` corria igual y escribia una entrada indistinguible
  // de una exitosa. Sin esto, "el nodo local anduvo bien toda la tarde" y
  // "el nodo local reviento en cada request" se ven idénticos en el panel.
  let fallo = null

  try {
    if (!stream) {
      // Se junta todo y se responde un `chat.completion` unico. Un error aca
      // todavia puede viajar con su status HTTP correcto, porque no se
      // escribio ni un byte de la respuesta.
      let content = ''
      for await (const delta of deltas()) content += delta
      sendJson(
        res,
        200,
        {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        },
        provenanceHeaders(node)
      )
      responded = true
    } else {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...provenanceHeaders(node)
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
    fallo = message
    if (!res.headersSent) {
      // 502 cuando el que fallo fue el proveedor externo: el error no es de
      // este gateway, y un 500 le diria al cliente que reviso el lado
      // equivocado. Es la misma distincion que hace cualquier proxy.
      const status = node.kind === 'upstream' ? 502 : 500
      sendError(res, status, message, { type: 'server_error' })
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

    // Se liquida con los tokens que REALMENTE se generaron, y la diferencia
    // contra la reserva vuelve al saldo. Va en el `finally` a proposito: un
    // request que revienta a mitad de stream igual gasto lo que gasto, y una
    // reserva que no se liquida queda comprometiendo saldo hasta que reinicie
    // el proceso.
    const completionReales =
      usoExterno && Number.isFinite(Number(usoExterno.completion_tokens))
        ? Number(usoExterno.completion_tokens)
        : tokens
    const costoReal = costs.real({
      model: claveDePrecio(node),
      promptTokens: usoExterno ? Number(usoExterno.prompt_tokens) || 0 : 0,
      completionTokens: completionReales
    })
    budget.settle(reserva.id, costoReal)
    // El motivo dice lo que REALMENTE pasó, y desde la Fase 8 eso incluye por
    // que se eligio este candidato: lo arma pickCandidate mirando la carga de
    // todos. Antes decía "menor carga relativa (simulado)", que era falso, y
    // despues "elegir por carga es D6, sin implementar", que era cierto pero
    // ya no lo es.
    const ms = Date.now() - startedAt
    store.pushLog({
      modelId: model,
      // 'local' es esta maquina generando de verdad; 'mock' es teatro de demo.
      // Distinguirlos importa: sin el campo, una corrida con --demo produce un
      // rastro con tok/s inventados que no se puede separar de uno real.
      target: node.kind === 'real' ? 'local' : node.kind === 'upstream' ? 'upstream' : 'mock',
      nodeId: node.id,
      operator: node.operator,
      candidatos: candidatos.length,
      reason: degradado
        ? `${degradado.motivo} — se degrado del externo (${degradado.de}) a este nodo`
        : motivoRuteo || `único candidato para "${model}"`,
      decision: decision || undefined,
      // El rastro tiene que poder distinguir "eligio local" de "queria el
      // externo y no le alcanzo el saldo". Sin esto las dos entradas se ven
      // iguales, y la degradacion -- que es una decision de plata-- queda sin
      // auditoria.
      degradado: degradado || undefined,
      ok: fallo === null,
      code: fallo === null ? null : 'server_error',
      // Lo que costo esta respuesta. Hoy es 0 en el camino local y es la
      // verdad, no un relleno: la inferencia propia no cuesta dolares. El
      // campo existe desde ahora para que el rastro de la Fase 8.5 no tenga
      // un agujero en las entradas anteriores.
      costMicros: costoReal,
      tokens,
      ttftMs,
      tokensPerSec: tokensPerSec({ tokens, ttftMs, ms }),
      ms
    })
  }
}

async function onRequest(req, res) {
  const pathname = req.url.split('?')[0]

  try {
    // `/` es el chat. Lo que habia antes -la grilla del marketplace- vive en
    // /network: elegir un nodo a mano dejo de ser el paso previo a preguntar
    // algo y paso a ser lo que se mira cuando uno quiere ver la red.
    if (req.method === 'GET' && pathname === '/') {
      const { CHAT_HTML } = await import('./pages.mjs')
      return sendHtml(res, CHAT_HTML)
    }
    if (req.method === 'GET' && pathname === '/network') {
      const { NETWORK_HTML } = await import('./pages.mjs')
      return sendHtml(res, NETWORK_HTML)
    }
    if (req.method === 'GET' && pathname === '/node') {
      const { NODE_HTML } = await import('./pages.mjs')
      return sendHtml(res, NODE_HTML)
    }
    if (req.method === 'GET' && pathname === '/admin') {
      const { ADMIN_HTML } = await import('./pages.mjs')
      return sendHtml(res, ADMIN_HTML)
    }
    // Las rutas viejas siguen resolviendo: hay comandos, capturas y un README
    // que las nombran, y un 404 despues de un rename es una regresion para
    // quien tenia el link guardado.
    if (req.method === 'GET' && (pathname === '/proveedor' || pathname === '/cliente')) {
      res.writeHead(302, { Location: pathname === '/proveedor' ? '/node' : '/' })
      return res.end()
    }

    // -----------------------------------------------------------------------
    // Credenciales de ESTE gateway.
    //
    // Son varias a proposito: si hubiera una sola, cada bot nuevo obligaria a
    // compartir la misma credencial y revocar por uno seria revocar por todos.
    // Con una key por cliente se puede cortar a uno sin tocar al resto, y el
    // rastro puede decir cual pidio que.
    //
    // La key autentica contra TU gateway, no contra el nodo remoto que termina
    // sirviendo: es el gateway quien despues decide a donde rutear. Por eso
    // esto vive en "My Node" y no en la tarjeta de un par.
    // -----------------------------------------------------------------------

    // La credencial del propio panel. Se crea sola la primera vez y se reusa
    // por nodeId, asi el navegador no genera una key nueva en cada recarga.
    if (req.method === 'GET' && pathname === '/v1/keys/panel') {
      const entry = apikeys.keyForNode(PANEL_KEY_ID, 'web panel')
      return sendJson(res, 200, { id: entry.id, label: entry.label, key: entry.key })
    }

    // Administrar credenciales exige presentar una. La unica excepcion es
    // /v1/keys/panel de arriba, que es el arranque: el navegador tiene que
    // poder conseguir SU key antes de poder autenticarse con ella.
    //
    // Limite honesto: el gateway escucha solo en 127.0.0.1, asi que esto no
    // defiende de otro proceso de la misma maquina -- que puede pedirle la key
    // al bootstrap igual que el panel. Defiende del resto de la red si el bind
    // alguna vez deja de ser loopback, y hace el consumo atribuible por
    // cliente, que es de lo que se trata tener varias keys.
    if (pathname === '/v1/keys' || pathname.startsWith('/v1/keys/')) {
      const motivoKeys = rechazoPorKey(req)
      if (motivoKeys) return sendError(res, 401, motivoKeys)
    }

    // Revocar TODO. Va antes del match de /v1/keys/:id para que "revoke-all"
    // no se lea como el id de una key.
    if (req.method === 'POST' && pathname === '/v1/keys/revoke-all') {
      const revoked = apikeys.reset()
      // El panel se quedaria sin credencial y dejaria de poder chatear: se le
      // emite una nueva en el acto.
      apikeys.keyForNode(PANEL_KEY_ID, 'web panel')
      return sendJson(res, 200, { revoked, keys: apikeys.listKeysFull() })
    }

    if (pathname === '/v1/keys') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { keys: apikeys.listKeysFull() })
      }
      if (req.method === 'POST') {
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch {
          /* sin body: queda el label por defecto */
        }
        const raw = typeof body.label === 'string' ? body.label.trim() : ''
        const entry = apikeys.createKey({ label: raw ? raw.slice(0, 40) : 'unnamed client' })
        return sendJson(res, 201, {
          id: entry.id,
          label: entry.label,
          key: entry.key,
          createdAt: entry.createdAt,
          lastUsedAt: null
        })
      }
    }

    const keyMatch = pathname.match(/^\/v1\/keys\/([^/]+)$/)
    if (req.method === 'DELETE' && keyMatch) {
      const id = decodeURIComponent(keyMatch[1])
      if (!apikeys.revokeKey(id)) return sendError(res, 404, 'no such api key')
      return sendJson(res, 200, { revoked: 1, keys: apikeys.listKeysFull() })
    }

    // ---- el agente local: estado y lanzamiento ----------------------------
    if (req.method === 'GET' && pathname === '/v1/agent') {
      return sendJson(res, 200, agentStatus())
    }
    if (req.method === 'POST' && pathname === '/v1/agent/launch') {
      if (swarmRef) return sendJson(res, 200, agentStatus())
      if (!launcher) {
        return sendError(
          res,
          503,
          'this gateway cannot launch an agent by itself — restart it with "pyrusllm serve --swarm"',
          { type: 'service_unavailable', code: 'no_launcher' }
        )
      }
      if (launchState.status === 'launching') return sendJson(res, 200, agentStatus())

      // Se responde ANTES de que termine: unirse al topic es rapido, pero el
      // primer par tarda ~17s en aparecer por la DHT y dejar el POST colgado
      // ese rato se lee como que el boton no anduvo.
      launchState = { status: 'launching', message: null }
      sendJson(res, 202, agentStatus())
      ;(async () => {
        try {
          await launcher()
          launchState = { status: 'live', message: null }
        } catch (err) {
          launchState = { status: 'error', message: (err && err.message) || String(err) }
        }
      })()
      return
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
      // `swarm: null` es la señal que usa el panel Proveedor para mostrar el
      // bloque de onboarding: este gateway corre (`serve`/`serve --demo`)
      // pero no se unio a la red P2P todavia.
      const swarm = swarmRef
        ? {
            operator: swarmRef.operator,
            publicKey: swarmRef.identity.publicKey.toString('hex'),
            verifiedPeers: swarmRef.verifiedPeers().length
          }
        : null
      return sendJson(res, 200, { nodes: store.listNodes(), swarm })
    }
    // FASE 8.5 — el estado del asistente externo y su interruptor.
    //
    // El opt-in se puede prender en caliente y no solo desde el archivo: el
    // caso real es "se saturo la red en medio de una demo". Lo que NO se puede
    // hacer por HTTP es configurar un upstream nuevo ni cambiarle la
    // credencial: eso vive en el disco del operador.
    if (req.method === 'GET' && pathname === '/v1/upstream') {
      return sendJson(res, 200, upstreamStatus())
    }
    if (req.method === 'POST' && pathname === '/v1/upstream/opt-in') {
      // Pide credencial igual que /v1/chat/completions: prender el opt-in es
      // autorizar gasto contra la cuenta del operador. Dejarlo abierto seria
      // dejar que cualquiera que llegue al puerto empiece a gastarle plata.
      const rechazo = rechazoPorKey(req)
      if (rechazo) return sendError(res, 401, rechazo)

      let cuerpo = {}
      try {
        cuerpo = await readJsonBody(req)
      } catch {
        return sendError(res, 400, 'body invalido, se esperaba JSON')
      }
      if (typeof cuerpo.enabled !== 'boolean') {
        return sendError(res, 400, 'falta "enabled" (booleano)')
      }
      setUpstreamOptIn(cuerpo.enabled)
      console.log(`[upstream] opt-in ${upstreamOptIn ? 'PRENDIDO' : 'apagado'} por HTTP`)
      return sendJson(res, 200, upstreamStatus())
    }
    if (req.method === 'GET' && pathname === '/v1/routing-log') {
      return sendJson(res, 200, { log: store.getLog() })
    }

    // FASE 6.5 — cuanto lleva gastado esta cuenta y cuanto le queda.
    //
    // Pide credencial igual que /v1/chat/completions: el saldo es de UNA
    // cuenta, y sin key no hay cuenta a la cual responderle. Devolver el saldo
    // de cualquiera a quien llegue al puerto seria decirle a un tercero cuanto
    // consume el dueno.
    if (req.method === 'GET' && pathname === '/v1/budget') {
      const motivo = rechazoPorKey(req)
      if (motivo) return sendError(res, 401, motivo)

      const uso = budget.usage(cuentaDe(req))
      return sendJson(res, 200, {
        period: uso.period,
        // Los micros son la verdad; los strings son para que el panel no tenga
        // que saber de la unidad. Van los dos y no uno solo: un cliente que
        // quiera comparar o sumar necesita el entero, no "USD 0,0135".
        spent_micros: uso.spent,
        reserved_micros: uso.reserved,
        cap_micros: uso.cap,
        remaining_micros: uso.remaining,
        spent: costs.formatUSD(uso.spent),
        reserved: costs.formatUSD(uso.reserved),
        cap: costs.formatUSD(uso.cap),
        remaining: costs.formatUSD(uso.remaining)
      })
    }

    // El reparto del mes: cuanto consumio cada cuenta. Es lo que se factura.
    if (req.method === 'GET' && pathname === '/v1/budget/report') {
      const motivo = rechazoPorKey(req)
      if (motivo) return sendError(res, 401, motivo)

      const periodo = new URLSearchParams(req.url.split('?')[1] || '').get('period')
      const rep = budget.report({ period: periodo || null })
      return sendJson(res, 200, {
        period: rep.period,
        found: rep.found,
        total_micros: rep.total,
        total: costs.formatUSD(rep.total),
        accounts: rep.accounts.map((a) => ({
          account: a.account,
          spent_micros: a.spent,
          spent: costs.formatUSD(a.spent)
        }))
      })
    }

    // FASE 6.6 — la otra cara del mismo espejo: cuanto REGALO este nodo.
    //
    // /v1/budget mira hacia adentro (lo que esta maquina consumio y le queda);
    // esto mira hacia afuera (lo que esta maquina le presto a otros). Son dos
    // contadores distintos y a proposito: el de arriba lo lleva el gateway
    // porque es quien gasta, y este lo lleva el proveedor porque es quien
    // presta la GPU. D18 y D23, el mismo principio aplicado a los dos lados.
    //
    // La clave del par se muestra recortada. Entera no aporta nada en una
    // pantalla y es el identificador de red de otra persona: no hay motivo
    // para dejarlo escrito completo en la vista del panel.
    if (req.method === 'GET' && pathname === '/v1/quota') {
      const motivo = rechazoPorKey(req)
      if (motivo) return sendError(res, 401, motivo)

      const cfg = quota.config()
      const filas = quota.listar()
      return sendJson(res, 200, {
        quota_tokens: cfg.tokens,
        window_hours: cfg.horas,
        // Lo regalado en la ventana, sumado. Es el numero que le importa al
        // duenio del nodo: cuanta GPU puso de su bolsillo hoy.
        given_tokens: filas.reduce((acc, f) => acc + f.used, 0),
        peers: filas.map((f) => ({
          peer: f.peerKey.slice(0, 8) + '…',
          used: f.used,
          remaining: f.remaining,
          quota: f.quota
        }))
      })
    }

    // La serie COMPLETA, desde el Hyperbee. `/v1/routing-log` devuelve el ring
    // de 30 que pinta el panel; para una auditoria eso no alcanza -- 30
    // entradas se llenan con una sola sesion de pruebas y la evidencia de la
    // demo queda afuera. Esta ruta es la que consume scripts/auditoria.js.
    //
    // Va con la identidad del nodo al lado a proposito: un JSONL suelto no
    // dice QUIEN lo genero, y una auditoria que no puede atribuir el rastro a
    // una clave publica no prueba gran cosa.
    if (req.method === 'GET' && pathname === '/v1/audit') {
      const q = req.url.split('?')[1] || ''
      const pedido = Number(new URLSearchParams(q).get('limit'))
      const limit = Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, 10000) : 500

      return sendJson(res, 200, {
        generadoEn: new Date().toISOString(),
        nodo: swarmRef
          ? {
              operator: swarmRef.operator,
              publicKey: swarmRef.identity.publicKey.toString('hex'),
              verifiedPeers: swarmRef.verifiedPeers().length
            }
          : null,
        // `false` cuando el gateway corre sin `--data`: el rastro entonces es
        // solo el ring en memoria y muere con el proceso. Decirlo importa,
        // porque cambia lo que la evidencia puede afirmar.
        persistido: store.getDirectory() !== null,
        log: await store.getLogHistory(limit)
      })
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      return await handleChat(req, res)
    }

    // -----------------------------------------------------------------------
    // Manifiesto propio: editar displayName/tags/capacidad/modelo desde el
    // panel Proveedor. Ver docs/superpowers/specs/2026-08-22-panel-
    // proveedor-onboarding-schema-design.md.
    //
    if (pathname === '/v1/swarm/manifest') {
      if (!swarmRef) {
        return sendError(res, 503, 'no hay swarm activo (correr con "serve --swarm")', {
          type: 'service_unavailable'
        })
      }

      if (req.method === 'GET') {
        const { availableModels, systemInfo } = await import('./hardware.mjs')
        return sendJson(res, 200, {
          manifest: swarmRef.manifest(),
          hardware: systemInfo(),
          models: availableModels(),
          modelLoad: modelLoadState
        })
      }

      if (req.method === 'POST') {
        // S3 de NOTES-SATURACION.md: esta era la UNICA ruta que muta estado sin
        // puerta. Chat, upload, fetch, kick y el patch de un nodo ya pedian la
        // key; esta dejaba que cualquier cosa corriendo en localhost cambiara
        // el modelo anunciado, los tags y la capacidad de este nodo -- y el
        // nodo lo re-firmaba con su identidad. Anunciar en nombre de uno es al
        // menos tan sensible como gastarle un token.
        const motivoManifiesto = rechazoPorKey(req)
        if (motivoManifiesto) return sendError(res, 401, motivoManifiesto)

        let body
        try {
          body = await readJsonBody(req)
        } catch {
          return sendError(res, 400, 'body invalido, se esperaba JSON')
        }

        const current = currentModelEntry()
        if (!current) return sendError(res, 500, 'este nodo no tiene ningun modelo anunciado')

        // El cambio de modelo es el unico que dispara una carga pesada -- se
        // responde de inmediato con "loading" y el panel hace poll del GET de
        // arriba, en vez de dejar el request colgado mientras cargan 5+ GB.
        if (typeof body.modelId === 'string' && body.modelId !== current.modelId) {
          const { MODEL_INFO } = await import('./models.mjs')
          const { fitsInMemory, systemInfo } = await import('./hardware.mjs')
          const info = MODEL_INFO[body.modelId]
          if (!info) {
            return sendError(res, 400, `modelo desconocido: "${body.modelId}"`)
          }
          if (!fitsInMemory(info.sizeGB, systemInfo().totalMemGB)) {
            return sendError(
              res,
              400,
              `"${info.displayName}" necesita ~${info.sizeGB.toFixed(1)} GB y esta maquina no los tiene`
            )
          }

          modelLoadState = { status: 'loading', modelId: body.modelId }
          sendJson(res, 200, { status: 'loading', modelId: body.modelId })

          // Sin await: el request YA respondio. Todo lo que sigue corre en
          // background y el panel lo ve por el GET de arriba.
          ;(async () => {
            try {
              await swarmRef.provider.preloadModel(body.modelId)
              const updated = [{ ...current, modelId: body.modelId, displayName: info.displayName }]
              swarmRef.provider.models = updated
              swarmRef.updateAnnouncement({ models: updated })

              // Sin esto, /v1/nodes -lo que leen los paneles- seguia
              // mostrando el modelId VIEJO aunque el manifiesto firmado y el
              // Provider ya hubieran cambiado: la fila del store es un
              // tercer lugar donde el modelo anunciado vive, y quedaba
              // desincronizada. `registerLocal` borra la fila anterior de
              // este mismo nodo antes de crear la nueva (ver store.mjs).
              const oldStoreId = store.localNodeIdFor(current.modelId)
              const oldStoreNode = oldStoreId ? store.getNode(oldStoreId) : null
              store.registerLocal({
                modelId: body.modelId,
                displayName: info.displayName,
                operator: swarmRef.operator,
                tags: swarmRef.tags,
                pricing: oldStoreNode ? oldStoreNode.pricing : undefined,
                maxConcurrentRequests: updated[0].maxConcurrentRequests
              })

              modelLoadState = { status: 'ready', modelId: body.modelId }
            } catch (err) {
              // El modelo viejo sigue siendo el anunciado: no se toco
              // ni provider.models ni swarmRef.models, asi que el nodo
              // sigue respondiendo exactamente lo que ya prometia.
              modelLoadState = {
                status: 'error',
                modelId: body.modelId,
                message: (err && err.message) || String(err)
              }
            }
          })()
          return
        }

        // Cambios sin carga: displayName/maxConcurrentRequests (por modelo) y
        // tags (a nivel nodo).
        const patched = { ...current }
        if (typeof body.displayName === 'string') {
          patched.displayName = body.displayName.slice(0, 80)
        }
        if (Number.isFinite(body.maxConcurrentRequests) && body.maxConcurrentRequests > 0) {
          patched.maxConcurrentRequests = Math.floor(body.maxConcurrentRequests)
        }
        const updated = [patched]
        swarmRef.provider.models = updated

        // La otra mitad de S2: cambiar el numero en el manifiesto tiene que
        // cambiar el limite que el Provider hace cumplir. `provider.models` ya
        // se actualizaba aca, pero `maxConcurrent` -- el unico numero que
        // rechaza requests, provider.mjs:169 -- quedaba en el valor del
        // arranque. El nodo terminaba anunciando una capacidad que no honraba,
        // que es exactamente lo que el manifiesto firmado existe para impedir.
        swarmRef.provider.maxConcurrent =
          updated.reduce(
            (n, m) => n + (Number.isFinite(m.maxConcurrentRequests) ? m.maxConcurrentRequests : 0),
            0
          ) || 1

        // Y la fila del registro, que es de donde sale el `node:status` que ven
        // los pares: sin esto la red seguiria viendo la capacidad vieja.
        const filaLocal = store.localNodeIdFor(patched.modelId)
        if (filaLocal) {
          const fila = store.getNode(filaLocal)
          if (fila) fila.maxConcurrentRequests = patched.maxConcurrentRequests
        }

        const tags = Array.isArray(body.tags)
          ? body.tags.map((t) => String(t).slice(0, 24)).slice(0, 10)
          : undefined

        const fresh = swarmRef.updateAnnouncement({ models: updated, tags })
        return sendJson(res, 200, { manifest: fresh })
      }
    }

    // -----------------------------------------------------------------------
    // Archivos (Hyperdrive). Ver qvac/files.mjs.
    //
    // Existe solo con `serve --swarm` y sin --no-store: sin Corestore no hay
    // drive. Se responde 503 con un motivo legible en vez de 500, porque "no
    // esta habilitado" y "se rompio" son cosas distintas para quien lo lee.
    // -----------------------------------------------------------------------
    if (pathname === '/v1/files' || pathname.startsWith('/v1/files/')) {
      if (!filesApi) {
        return sendError(
          res,
          503,
          'los archivos necesitan "serve --swarm" (hace falta el Corestore)',
          {
            type: 'service_unavailable'
          }
        )
      }
    }

    // Lo que publica ESTA maquina, o -con ?link=/?key=- lo que publica otra.
    // Listar un drive remoto NO baja los blobs: la metadata de un Hyperdrive
    // se replica aparte, asi que se puede mirar un drive de 40 GB y bajar un
    // solo archivo.
    if (req.method === 'GET' && pathname === '/v1/files') {
      const q = new URLSearchParams(req.url.split('?')[1] || '')
      const link = q.get('link')
      const key = q.get('key')
      const peerKey = q.get('peerKey')
      try {
        if (peerKey) {
          // El panel solo conoce el peerKey del nodo (viene de toPublic()), no
          // la clave del drive -- esa la anuncia el par por su cuenta via
          // files:announce (swarm.mjs) y solo el swarm sabe atarla al peer.
          if (!swarmRef) {
            return sendError(res, 503, 'los archivos de un par necesitan "serve --swarm"', {
              type: 'service_unavailable'
            })
          }
          const par = swarmRef.peersWithFiles().find((p) => p.peerKey === peerKey)
          if (!par) {
            return sendError(
              res,
              404,
              'ese par no anuncio ningun archivo (todavia no conecto, o no publico nada)'
            )
          }
          const files = await filesApi.listRemote(par.driveKey, '/', { timeoutMs: 20000 })
          return sendJson(res, 200, { keyHex: par.driveKey, remote: true, files })
        }
        if (link || key) {
          const { parseLink } = await import('./files.mjs')
          const keyHex = key || parseLink(link).keyHex
          if (!/^[0-9a-f]{64}$/.test(keyHex)) {
            return sendError(res, 400, 'la clave del drive tiene que ser hex de 32 bytes')
          }
          const files = await filesApi.listRemote(keyHex, '/', { timeoutMs: 20000 })
          return sendJson(res, 200, { keyHex, remote: true, files })
        }
        return sendJson(res, 200, {
          keyHex: filesApi.keyHex,
          remote: false,
          files: await filesApi.list('/')
        })
      } catch (err) {
        return sendError(
          res,
          502,
          'no se pudo leer el drive: ' + (err && err.message ? err.message : err)
        )
      }
    }

    // Publicar. El body son los BYTES crudos del archivo y el nombre viaja en
    // la query: sin multipart no hay parser que escribir, y el browser puede
    // mandar un File como body de fetch() tal cual. Se escribe a disco por
    // stream y no a memoria -- un PDF de 200 MB bufferizado tumba el proceso.
    if (req.method === 'POST' && pathname === '/v1/files/upload') {
      // Mismo gate opcional que /v1/chat/completions (ver rechazoPorKey):
      // sin este chequeo, cualquiera en la wifi del venue escribe hasta 512 MB
      // en este disco y los publica en la DHT a nombre de este nodo.
      const motivoUpload = rechazoPorKey(req)
      if (motivoUpload) return sendError(res, 401, motivoUpload)

      const q = new URLSearchParams(req.url.split('?')[1] || '')
      const nombre = sanitizeFilename(q.get('name') || '')
      if (!nombre) return sendError(res, 400, 'falta "name" en la query')

      try {
        const guardado = await recibirArchivo(req, nombre)
        const info = await filesApi.share(guardado, nombre)
        return sendJson(res, 200, info) // { path, bytes, link }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err)
        const code = msg.includes('demasiado grande') ? 413 : 500
        return sendError(res, code, 'no se pudo publicar: ' + msg)
      }
    }

    // Bajar un archivo de otro drive al disco de esta maquina.
    if (req.method === 'POST' && pathname === '/v1/files/fetch') {
      const motivoFetch = rechazoPorKey(req)
      if (motivoFetch) return sendError(res, 401, motivoFetch)

      let body
      try {
        body = await readJsonBody(req)
      } catch {
        return sendError(res, 400, 'body invalido, se esperaba JSON')
      }
      if (typeof body.link !== 'string') return sendError(res, 400, 'falta "link"')

      try {
        const { parseLink } = await import('./files.mjs')
        const { keyHex, path: ruta } = parseLink(body.link)
        if (ruta === '/')
          return sendError(res, 400, 'el link apunta al drive entero, no a un archivo')

        const fs = await import('bare-fs')
        const path = await import('bare-path')
        const destino = path.default.join(descargasDir(), path.default.basename(ruta))
        await fs.default.promises.mkdir(descargasDir(), { recursive: true })

        const r = await filesApi.pull(keyHex, ruta, destino, { timeoutMs: 60000 })
        return sendJson(res, 200, { destino, bytes: r && r.bytes ? r.bytes : null })
      } catch (err) {
        return sendError(res, 502, 'no se pudo bajar: ' + (err && err.message ? err.message : err))
      }
    }

    // /v1/connection/:id se elimino: emitia una credencial POR NODO REMOTO,
    // como si existiera una key "para hablarle a tal proveedor". No es asi --
    // la key autentica contra ESTE gateway y es el quien despues rutea. Las
    // credenciales se administran en /v1/keys.

    const kickMatch = pathname.match(/^\/v1\/nodes\/([^/]+)\/kick$/)
    if (req.method === 'POST' && kickMatch) {
      // Sin esto, cualquiera en la misma red vacia el panel en vivo pateando
      // nodos ajenos -- el mismo gate opcional que ya protege el chat.
      const motivoKick = rechazoPorKey(req)
      if (motivoKick) return sendError(res, 401, motivoKick)

      const node = store.kick(decodeURIComponent(kickMatch[1]))
      return node ? sendJson(res, 200, node) : sendError(res, 404, 'nodo desconocido')
    }

    const nodeMatch = pathname.match(/^\/v1\/nodes\/([^/]+)$/)
    if (req.method === 'POST' && nodeMatch) {
      const motivoPatch = rechazoPorKey(req)
      if (motivoPatch) return sendError(res, 401, motivoPatch)

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

  // '127.0.0.1', no sin host: sin esto bare-http1 bindea 0.0.0.0 aunque el
  // log diga "localhost", y cualquiera en la wifi del hackathon llega al
  // gateway -incluidas las rutas de archivos y admin, sin credencial-.
  server.listen(port, '127.0.0.1', () => {
    console.log('')
    console.log(`  [gateway] listening on http://localhost:${port}`)
    console.log(`  [gateway] chat:    http://localhost:${port}/`)
    console.log(`  [gateway] my node: http://localhost:${port}/node`)
    console.log(`  [gateway] network: http://localhost:${port}/network`)
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
  // Se cierra el ledger antes que el motor: un apagado ordenado tiene que
  // dejar el gasto del ultimo request en disco, y el motor puede tardar.
  budget.close()
  if (engineMod && realModelId) await engineMod.shutdown(realModelId)
}
