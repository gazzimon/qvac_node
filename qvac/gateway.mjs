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
import * as x402 from './x402.mjs'
import * as atestacion from './atestacion.mjs'
import * as costs from './costs.mjs'
import * as quota from './quota.mjs'
import { pickCandidate, estaSaturado } from './routing.mjs'
// Ver la nota de upstream.mjs: bajo Bare esto no es un global.
import AbortController from 'bare-abort-controller'

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

// B14 / D9 — el `finish_reason` que ve el cliente.
//
// D9 lo declara NO NEGOCIABLE: si la respuesta se corto por el tope, tiene que
// decir `length`. Cobrar por un tope y reportar terminacion normal es mentir en
// el unico campo que el cliente mira para saber si le falta texto -- y el que
// mira un agente para decidir si pedir la continuacion.
//
// El dato lo da QUIEN GENERO: el proveedor externo lo manda en el ultimo chunk
// (upstream.mjs lo lee y lo reporta por `onFinish`). Contarlo de este lado no
// serviria: contamos deltas de SSE, no tokens, asi que compararlos contra el
// tope daria un numero parecido y no el hecho.
//
// Sin dato se reporta `stop`, que es lo que el gateway hacia con TODAS las
// respuestas. La diferencia es que ahora es el default de "nadie lo dijo" y no
// una afirmacion sobre todas.
function finishReasonDe(reportado) {
  if (typeof reportado !== 'string' || reportado === '') return 'stop'
  // Se pasa tal cual el vocabulario de OpenAI, que es el que el cliente espera:
  // stop, length, content_filter, tool_calls. Un valor que no conocemos viaja
  // igual en vez de aplanarse a 'stop': inventarle un final conocido a algo que
  // el proveedor nombro distinto es la misma mentira mas chica.
  return reportado
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
// Un upstream que corre en esta maquina NO es un tercero. Todo lo que decide
// privacidad y gasto -- el opt-in, el filtro de `local: true`, la condicion de
// "sin capacidad local" -- pregunta esto y no el `kind`, que solo dice COMO se
// le pide (por HTTP) y no A QUIEN.
function esTercero(node) {
  return !!node && node.kind === 'upstream' && node.local !== true
}

// Con que etiqueta entra al rastro lo que genero este candidato.
function targetDe(node) {
  if (!node) return 'none'
  if (node.kind === 'peer') return 'peer'
  if (node.kind === 'mock') return 'mock'
  return esTercero(node) ? 'upstream' : 'local'
}

// FASE 8 — `costMicros` es el ESTIMADO, no el real, y la diferencia importa.
//
// El real se sabe al terminar; estos headers salen ANTES del primer token,
// porque en SSE no hay otro momento (R4 del roadmap). Asi que lo que viaja es
// la COTA SUPERIOR con la que se autorizo el gasto -- el mismo numero que
// aparto la reserva --, y el chat lo muestra como techo y no como precio.
//
// Mandar el real obligaria a un trailer HTTP o a un segundo request contra el
// log, y las dos cosas son peores que decir la verdad de lo que se sabe cuando
// se sabe.
function provenanceHeaders(node, costMicros = 0) {
  return {
    'X-Pyrus-Operator': encodeURIComponent((node && node.operator) || ''),
    'X-Pyrus-Kind': (node && node.kind) || 'unknown',
    'X-Pyrus-Cost-Estimate-Micros': String(Math.max(0, Math.ceil(Number(costMicros) || 0))),
    // De que lado del borde de la maquina se genero la respuesta. `kind` no
    // alcanza: un upstream puede ser un tercero o un motor propio detras de
    // HTTP, y el chat necesita saber cual para no prometer de menos ni de mas.
    'X-Pyrus-Scope': esTercero(node) ? 'external' : 'local',
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

// FASE 7 — la direccion de cobro de ESTE nodo, o null si no tiene wallet.
//
// Llega ya armada desde bin.mjs, que es el dueño del directorio de storage y el
// unico que conoce la passphrase. El gateway NUNCA abre el keystore ni ve la
// seed: solo muestra lo que ya viaja publico en el manifiesto firmado.
let economicPropio = null

export function setEconomic(economic) {
  economicPropio = economic || null
  return economicPropio
}

// FASE 11 — la red donde vive la wallet, para que el panel /wallet pueda LEER
// saldos. Llega ya resuelta desde bin.mjs (`wallet.redDe`): nombre, chainId,
// caip2, rpc, explorer. Es dato PUBLICO — el mismo RPC contra el que se firma
// el cobro — y no afloja la invariante de arriba: se lee con la direccion, que
// viaja en el manifiesto, no con la seed. Sin esto el panel dice "sin wallet".
let walletRed = null

export function setWalletRed(red) {
  walletRed = red && red.rpc ? red : null
  return walletRed
}

// FASE 9 / D24 — con que se firma la atestacion de lo que este nodo sirvio.
//
// Es una FUNCION, no una clave: bin.mjs abre el keystore, se queda con la
// cuenta y le pasa acá un `(mensaje) => Promise<firma>`. La invariante de arriba
// no se afloja — el gateway sigue sin ver la seed —, pero ahora puede pedir una
// firma sin tenerla.
//
// Sin esto no hay atestacion. NO se emite una sin firmar: un artefacto que
// parece una prueba y no lo es es peor que uno ausente, y es exactamente la
// forma de "quedar completo" siendo deshonesto.
let firmarConWallet = null

export function setWalletSigner(fn) {
  firmarConWallet = typeof fn === 'function' ? fn : null
  return !!firmarConWallet
}

export function walletStatus() {
  return {
    // `false` no es un error: un nodo que solo consume no necesita wallet, y su
    // manifiesto anuncia el bloque marcado como mock.
    configurada: !!economicPropio,
    address: economicPropio ? economicPropio.walletAddress : null,
    chains: economicPropio ? economicPropio.chains : [],
    settlement: economicPropio ? economicPropio.settlement : null
  }
}

// FASE 11 — una llamada JSON-RPC cruda contra el RPC de la red de la wallet.
// `bare-fetch` como en upstream.mjs. Solo para LEER (`eth_getBalance`,
// `eth_call` a `balanceOf`): este gateway no arma ni firma transacciones.
async function rpcCall(url, method, params) {
  const mod = await import('bare-fetch')
  const fetch = mod.default || mod.fetch || mod
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  if (!r.ok) throw new Error('RPC HTTP ' + r.status)
  const j = await r.json()
  if (j && j.error) throw new Error(j.error.message || 'RPC error')
  return j ? j.result : null
}

// `balanceOf(address)` — selector 0x70a08231, la direccion a 32 bytes.
function balanceOfData(address) {
  return (
    '0x70a08231' + '000000000000000000000000' + String(address).toLowerCase().replace(/^0x/, '')
  )
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

// FASE 9 / D9(a) — el tope de salida cuando el request SE COBRA a precio fijo.
//
// `topeDeSalida` devuelve el del upstream, y CERO para todo lo demas: hoy un
// par y el motor local no tienen techo, y esta bien, porque no cobran nada.
//
// Con un 402 de por medio eso deja de servir. D9(a) es "hasta N tokens de
// salida por $X", y el DoD pide que el 402 declare esa N: un precio fijo por
// trabajo sin acotar es exactamente lo que la decision advierte que no hay que
// hacer. Asi que cuando hay cobro SIEMPRE hay techo, incluso donde el camino
// gratis no lo necesita.
//
// El numero se declara ANTES de generar y se aplica DESPUES: son el mismo, y
// tienen que serlo -- declarar uno y recortar con otro es cobrar por un trabajo
// distinto del que se acordo.
const MAX_TOKENS_COBRADO = 2048

function topeDeSalidaCobrado(node, pedido) {
  const propio = topeDeSalida(node, pedido)
  if (propio > 0) return propio
  // Un cliente puede pedir MENOS que el techo; no puede pedir mas, ni no pedir.
  return pedido > 0 ? Math.min(pedido, MAX_TOKENS_COBRADO) : MAX_TOKENS_COBRADO
}

// Tokens del prompt, estimados por caracteres, SOLO para la reserva.
//
// El numero exacto lo sabe el tokenizador del proveedor y llega recien con el
// `usage` del ultimo chunk -- despues de gastar-. Se divide por 3 y no por los
// ~4 caracteres por token que es la regla habitual: la reserva es una cota
// SUPERIOR, y equivocarse para arriba corta antes de tiempo mientras que
// equivocarse para abajo deja pasar gasto por encima del tope.
//
// SE CUENTAN BYTES UTF-8, NO CARACTERES, y ese es el arreglo de B6. La version
// anterior dividia caracteres por 3 y se declaraba cota superior, que en ingles
// es cierto y en chino, japones, coreano, arabe o hindi es falso: ahi la
// relacion se acerca a 1 token por caracter y la reserva quedaba muy por debajo
// del gasto, justo donde el comentario prometia lo contrario. En UTF-8 esos
// alfabetos ocupan 3 bytes por caracter, asi que contar bytes hace que un solo
// divisor los cubra a todos.
//
// No se afirma que sea una cota superior DEMOSTRABLE: un tokenizador con
// byte-fallback puede, en el peor caso patologico, emitir un token por byte. Es
// una estimacion deliberadamente conservadora -- ~2 bytes por token cubre con
// margen el texto real en cualquiera de esos alfabetos-, y el `usage` del
// proveedor corrige el numero al liquidar.
function estimarPromptTokens(messages) {
  let bytes = 0
  for (const m of messages || []) bytes += Buffer.byteLength(String((m && m.content) || ''), 'utf8')
  return Math.ceil(bytes / 2)
}

// FASE 9 / D9 — tokens de SALIDA estimados desde el TEXTO acumulado.
//
// No es el mismo estimador que el de arriba y no puede serlo: aquel es una cota
// SUPERIOR deliberada, porque equivocarse para arriba en una reserva corta antes
// de tiempo y equivocarse para abajo deja pasar gasto. Este decide DONDE SE
// CORTA una respuesta, y ahi la asimetria se da vuelta: sobreestimar le recorta
// texto al cliente que ya pago por el.
//
// Y sobre todo: se cuenta desde el TEXTO, no desde los deltas. El gateway
// incrementa su contador una vez por delta con contenido, y quien decide como se
// trocea el stream es el proveedor -- un par que emite un caracter por delta
// haria saltar un tope contado en deltas a los 2048 caracteres. El texto no
// depende del troceo. Es el mismo argumento por el que la atestacion de D24
// lleva `outputHash` y no un conteo.
//
// Es una ESTIMACION y no coincide con el tokenizador del modelo: ~4 bytes por
// token es la regla habitual para texto latino y se queda corta en CJK. Por eso
// el numero que se declara en el 402 y el que se aplica son el mismo, pero
// ninguno de los dos es una medicion. Queda dicho en el README, no escondido.
function estimarTokensDeSalida(texto) {
  return Math.floor(Buffer.byteLength(String(texto || ''), 'utf8') / 4)
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
function streamFromPeer({ node, model, messages, onChunk, onStart, signal = null }) {
  return new Promise((resolve) => {
    let started = false
    let finished = false
    let timer = null
    let requestId = null

    const finish = (r) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      // Si se corta por timeout o error, se le avisa al par para que deje de
      // generar: seguir gastando su CPU en tokens que ya no tienen destino es
      // justo lo que chat:cancel existe para evitar.
      if (!r.ok && requestId) swarmRef.cancelChat(requestId)
      resolve({ ...r, started })
    }

    // FASE 9 / D27 — un corte DELIBERADO no es una falla del par.
    //
    // Hay dos: el cliente cerró la pestaña (caso 1) y se tocó el tope de tokens
    // que declaró el 402 (caso 3). En los dos, lo que el par emitió hasta acá
    // es válido, el cliente lo recibió, y D27 decide que se cobra. Sin esto el
    // request se quedaba esperando el reloj de inactividad —60 segundos— y
    // terminaba como `peer_stalled`, o sea como si el par hubiera fallado:
    // ni se cobraba ni se atestiguaba lo que sí se había servido.
    //
    // Con `started` en false es al revés: no salió un solo token, no hay nada
    // que cobrar ni que atestiguar, y eso es un corte sin resultado.
    const onAbort = () => {
      if (finished) return
      if (requestId) swarmRef.cancelChat(requestId)
      finish(
        started
          ? { ok: true, cortado: true, code: null, message: null }
          : { ok: false, code: 'aborted', message: 'el request se corto antes del primer token' }
      )
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

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

// Lo que costo UN intento, con las tres verdades distintas que puede haber:
//
//   1. No llego un solo token. El proveedor no genero nada y no nos va a
//      facturar nada: cobrar la cota superior seria cobrar por un request que
//      no ocurrio. Es el caso del proveedor colgado y el del que rechaza antes
//      de empezar -- y ahora tambien el del candidato que fallo y se reintento
//      en otro, que no puede cobrarse dos veces.
//
//   2. Llegaron tokens Y el `usage` del proveedor. Son los tokens REALES,
//      contados por SU tokenizador. Es lo que se liquida.
//
//   3. Llegaron tokens y NO llego el `usage`. Hubo gasto y no sabemos cuanto:
//      se cobra la reserva entera, que es la cota superior con la que se
//      autorizo. Se equivoca para arriba, que es el unico lado que no se pasa
//      del tope (B2). Y se dice en voz alta: un proveedor que no manda usage
//      es algo que el operador tiene que ver y arreglar, no una diferencia
//      silenciosa entre este ledger y la factura de fin de mes.
//
// Los deltas contados de este lado NO sirven para facturar un externo: son
// chunks de SSE, no tokens, y los de entrada directamente no se ven.
function costoDelIntento({ node, usoExterno, tokens, reserva }) {
  if (!esTercero(node)) {
    return costs.real({ model: claveDePrecio(node), completionTokens: tokens })
  }
  if (!usoExterno && tokens === 0) return 0
  if (!usoExterno) {
    const costo = reserva.micros || 0
    console.error(
      `[${node.id}] el proveedor no mando "usage": se liquida por la reserva ` +
        `(${costs.formatUSD(costo)}), que es la cota superior y no el costo real`
    )
    return costo
  }
  return costs.real({
    model: claveDePrecio(node),
    promptTokens: Number(usoExterno.prompt_tokens) || 0,
    completionTokens: Number.isFinite(Number(usoExterno.completion_tokens))
      ? Number(usoExterno.completion_tokens)
      : tokens
  })
}

// Un intento contra un candidato que NO es un par: el motor embebido, un
// upstream (propio o de un tercero) o un mock del modo --demo.
//
// Devuelve la MISMA forma que streamFromPeer y, como el, no rechaza nunca:
// { ok, started, code, message }. Esa simetria es lo que permite que un solo
// loop recorra candidatos de cualquier clase. Antes habia dos caminos
// separados -- uno con reintento y otro sin el -- y el reintento se frenaba en
// la frontera entre pares y no-pares: si fallaban todos los pares, el modelo
// local nunca se probaba aunque estuviera en la misma lista de candidatos.
//
// `started` es el dato con el que D4 decide: una vez que salio un token para
// el cliente, no se reintenta en otro nodo porque una respuesta a medias no se
// puede retomar en otra maquina.
async function streamFromLocal({
  node,
  messages,
  prompt,
  maxSalida,
  signal,
  onChunk,
  onUsage,
  onFinish
}) {
  let started = false
  try {
    let crudos
    if (node.kind === 'real') {
      const mid = await ensureRealModel()
      crudos = engineMod.complete({ modelId: mid, history: messages })
    } else if (node.kind === 'upstream') {
      // La fila del registro y la instancia que sabe hablar con la API son dos
      // cosas: la fila puede sobrevivir a una relectura de config que saco al
      // upstream, y en ese caso hay que fallar diciendolo -- no caer al mock,
      // que devolveria texto inventado con los headers de un proveedor real.
      const up = upstreams.get(node.id)
      if (!up) throw new Error('el asistente externo ya no esta configurado en este nodo')
      if (!up.disponible()) {
        throw new Error(
          'falta la credencial del asistente externo: pone la variable de entorno ' + up.apiKeyEnv
        )
      }
      crudos = up.completar({ messages, maxTokens: maxSalida, signal, onUsage, onFinish })
    } else {
      crudos = mockTokens(node, prompt)
    }

    for await (const delta of crudos) {
      // Cortar el `for await` cierra el generador, y el finally de completar()
      // aborta el fetch. Por eso alcanza con salir: no hace falta propagar la
      // cancelacion a mano hasta el socket del proveedor.
      if (signal.aborted) break
      started = true
      onChunk(delta)
    }
    return { ok: true, started, code: null, message: null }
  } catch (err) {
    // FASE 9 / D27 — si el que corto fuimos NOSOTROS, no es una falla del
    // proveedor.
    //
    // B3 cableo este signal al fetch del externo, asi que abortar no hace salir
    // al `for await` por el `break` de arriba: hace TIRAR al generador. Sin esta
    // guarda, un cliente que cierra la pestaña o un tope de D9 que salta se
    // reportaban como `upstream_error`, y con eso no se liquidaba ni se
    // atestiguaba un prefijo que el cliente SI habia recibido -- justo al reves
    // de lo que decide D27.
    //
    // `started` es la condicion: sin un solo token no hay prefijo que cobrar, y
    // ahi el corte sigue siendo un request sin resultado. Y el signal es SOLO
    // nuestro -- los relojes del protocolo con el proveedor viven adentro de
    // `completar()` con su propio controlador (B16)--, asi que un proveedor
    // colgado no entra por aca.
    if (signal.aborted && started) {
      return { ok: true, started, cortado: true, code: null, message: null }
    }
    const message = String((err && err.message) || err)
    return {
      ok: false,
      started,
      // Un 429 del proveedor es "no puedo AHORA", igual que el at_capacity de
      // un par: el loop lo trata como saturacion y prueba el siguiente. Es la
      // unica forma de reaccionar a una cuota diaria agotada, que el ledger no
      // ve porque no se mide en dolares.
      code: /\b429\b/.test(message)
        ? 'at_capacity'
        : esTercero(node)
          ? 'upstream_error'
          : 'local_error',
      message
    }
  }
}

// Sirve un request recorriendo los candidatos EN ORDEN hasta que uno conteste.
//
// Antes se llamaba handleRemoteChat y solo miraba pares; el motor local y los
// upstream tenian su propio camino sin reintento, y elegido el nodo el request
// se casaba con el. Ahora hay un solo recorrido para todas las clases: si el
// mejor candidato falla ANTES del primer token -- este saturado, no tenga
// credencial, no haya swarm, se quede sin cuota diaria -- se prueba el
// siguiente, sea de la clase que sea.
// FASE 9 / D12 — liquidar y dejar el recibo recuperable.
//
// Va DESPUES de servir. Si falla, el cliente ya recibio sus tokens y este nodo
// se queda sin cobrar: es el precio de no poner una transaccion on-chain
// delante del TTFT, esta aceptado por D12, y es lo que la Fase 10 arregla de
// verdad acumulando recibos en vez de liquidar de a uno.
//
// No tira nunca. Una liquidacion que falla no puede llevarse puesta una
// respuesta que ya salio bien.
const recibos = new Map()

// Cuantos recibos se guardan. Es memoria del proceso, no un ledger: el ledger
// de verdad es la cadena. Esto existe para que un cliente que perdio el evento
// SSE pueda recuperarlo en los minutos siguientes.
const MAX_RECIBOS = 200

// FASE 9 / D25 — prefill y decode, separados, y de dónde salió cada número.
//
// D22 (precio plano) NO se toca: esto REGISTRA, no tarifa. Y no cambia la
// matemática de ruteo, que sigue preguntándole el precio al ledger en
// micro-dólares como cerró la Fase 8 — ni `estimarRequest` ni `costoDelIntento`
// leen nada de acá.
//
// El campo que importa tanto como los dos números es `tokensFuente`, y está por
// una razón que el propio gateway ya tenía escrita: lo que este proceso cuenta
// son CHUNKS DE SSE, no tokens, y los de entrada directamente no los ve. Cuando
// el proveedor manda `usage` esos son los tokens reales, contados por su
// tokenizador; cuando no lo manda, lo que queda es una estimación del prompt y
// un conteo de deltas. Son dos cosas distintas y sin el campo se leen iguales:
// la Fase 10 va a querer liquidar sobre esta serie y tiene que poder separarlas.
function tokensD25({ usoExterno, tokens, promptTokens }) {
  const decodeReal = usoExterno && Number.isFinite(Number(usoExterno.completion_tokens))
  const prefillReal = usoExterno && Number.isFinite(Number(usoExterno.prompt_tokens))

  return {
    tokensPrefill: prefillReal ? Number(usoExterno.prompt_tokens) : promptTokens,
    tokensDecode: decodeReal ? Number(usoExterno.completion_tokens) : tokens,
    // 'proveedor' solo si los DOS salieron del usage. Con uno solo el par ya no
    // es comparable con otro, y decir "proveedor" a medias sería peor que decir
    // "gateway": haría creer que hay una medición donde hay una estimación.
    tokensFuente: decodeReal && prefillReal ? 'proveedor' : 'gateway'
  }
}

// FASE 9 / D24 — el artefacto donde el proveedor atestigua QUE SIRVIO.
//
// Devuelve `{ atestacion }` o `{ sinAtestacion: motivo }`. Nunca una atestación
// a medias: el motivo viaja en el recibo para que la ausencia sea LEGIBLE, que
// es la diferencia entre un campo faltante y un mock que parece funcional.
//
// La regla de QUIEN puede firmar vive en `atestacion.porQueNoSeFirma` -- y en
// particular la del par, que es la que más importa y la que más fácil se
// afloja: este nodo no atestigua trabajo ajeno.
async function atestacionDe({ id, node, messages, contenido, d25, finishReason }) {
  const payTo = economicPropio && economicPropio.walletAddress
  const motivo = atestacion.porQueNoSeFirma({
    node,
    walletAddress: payTo,
    tieneFirmante: !!firmarConWallet
  })
  if (motivo) return { sinAtestacion: motivo }

  const sinFirmar = atestacion.construir({
    requestId: id,
    modelId: node.modelId || null,
    // Declarados, no medidos. `runtime` distingue el motor embebido de una API
    // de un tercero y del teatro del modo --demo: un mock firmado con una wallet
    // real sigue siendo un mock, y el artefacto tiene que decirlo donde se vea.
    quantization: atestacion.cuantizacionDe(node.modelId),
    runtime: runtimeDe(node),
    promptHash: atestacion.hashDeMensajes(messages),
    outputHash: atestacion.hashDe(contenido),
    tokensPrefill: d25.tokensPrefill,
    tokensDecode: d25.tokensDecode,
    finishReason,
    providerPubkey: payTo
  })

  const firmada = await atestacion.firmar(sinFirmar, firmarConWallet)
  if (!firmada) return { sinAtestacion: 'la wallet no pudo firmar la atestacion' }
  return { atestacion: firmada }
}

// Con qué se generó, para el campo `runtime` de la atestación. Es lo que este
// nodo puede afirmar de primera mano, a diferencia de `quantization`, que sale
// del nombre del modelo y por lo tanto es una declaración sobre otra.
function runtimeDe(node) {
  if (!node) return 'unknown'
  if (node.kind === 'real') return 'llamacpp'
  if (node.kind === 'upstream') return 'upstream:' + node.id
  if (node.kind === 'mock') return 'mock'
  return node.kind || 'unknown'
}

async function liquidarYRegistrar(pago, id, extra = null) {
  const recibo = await x402.liquidar({ pago, requisito: pago.requisito })

  if (recibo.success) {
    console.log(`[x402] liquidado ${id}: tx ${recibo.transaction} en ${recibo.network}`)
  } else {
    // Se dice fuerte: este nodo sirvio y no cobro.
    console.error(
      `[x402] NO se pudo cobrar ${id}: ${recibo.errorReason || ''} ${recibo.errorMessage || ''}`
    )
  }

  let cabecera = null
  try {
    cabecera = await x402.cabeceraDeRecibo(recibo)
  } catch (err) {
    console.error(`[x402] no se pudo codificar el recibo: ${(err && err.message) || err}`)
  }

  // D24 — la atestacion se GUARDA junto al recibo de liquidacion, que es donde
  // D12 ya obligaba a construir algo. Los dos artefactos prueban mitades
  // distintas del mismo intercambio: el recibo, que alguien pago; la atestacion,
  // que este nodo entrego esto. En esta fase NADIE la consume todavia -- eso es
  // la Fase 10 --, y es deliberado: hacia atras no se firma.
  recibos.set(id, { recibo, ...(extra || {}), at: Date.now() })
  // Se poda al escribir y no con un timer: un timer no corre si el proceso
  // estuvo quieto, y ademas mantendria vivo un Map que a nadie le importa.
  if (recibos.size > MAX_RECIBOS) {
    const sobran = recibos.size - MAX_RECIBOS
    let n = 0
    for (const k of recibos.keys()) {
      if (n++ >= sobran) break
      recibos.delete(k)
    }
  }

  return { recibo, cabecera, ...(extra || {}) }
}

async function handleChatConReintentos({
  req,
  res,
  node,
  candidatos,
  model,
  messages,
  stream,
  // La cuenta contra la que se reserva. La reserva se abre POR INTENTO y no
  // una vez: el precio depende del nodo, y con reintentos entre candidatos de
  // precios distintos una sola reserva acotaria el gasto del equivocado.
  cuenta = null,
  maxTokensPedido = 0,
  // La maquina que el cliente fijo, si fijo alguna: corta el reintento.
  pin = null,
  // Por que se eligio a este candidato y no a otro. Va al log de ruteo.
  decision = null,
  motivo = null,
  // FASE 9 — el pago verificado, si el cliente pago en vez de traer key.
  pago = null,
  // FASE 9 / D9(a) — el tope de salida que el 402 DECLARO, en tokens.
  //
  // Es el mismo numero que viajo en `accepts[].outputTokenLimit` y tiene que
  // serlo: declarar uno y recortar con otro es cobrar por un trabajo distinto
  // del que se acordo. Cero cuando no hubo cobro -- el camino con API key no
  // tiene techo por este lado, lo acota el presupuesto.
  //
  // Va como escalar y no se recalcula por candidato: el cliente FIRMO contra el
  // numero que se le declaro, y si el reintento cae en otro candidato el trato
  // sigue siendo ese.
  topeCobrado = 0
}) {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  const prompt = lastUserText(messages)
  const promptTokens = estimarPromptTokens(messages)

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
  // B14 — COMO termino el que contesto. `null` significa "nadie lo dijo", que
  // no es lo mismo que `stop`: sin el dato se reporta terminacion normal, que
  // es lo que hacia antes con TODAS las respuestas.
  let finReal = null
  // Lo que se estimo para el intento EN CURSO. Vive fuera del loop porque lo
  // lee `emitUnsafe` al escribir los headers, y adentro del loop la reserva es
  // un const de cada vuelta. Con reintento entre candidatos de precios
  // distintos, el header tiene que decir el del que efectivamente contesto.
  let costoEstimado = 0

  // FASE 9 / D27 caso 3 — se llego al tope de tokens que declaro el 402.
  //
  // Es una variable aparte de `cancelado` porque significan cosas opuestas para
  // el cobro: `cancelado` es que el cliente se fue, esto es que la respuesta
  // termino como se habia acordado. Las dos cortan el stream y las dos SE
  // COBRAN (D27), pero la atestacion sale con `finishReason` distinto y eso es
  // justo lo que la hace servir para algo.
  let cortadoPorTope = false

  const emit = (delta) => {
    // FASE 9 / D27 — despues de un corte, lo que siga llegando NO entra.
    //
    // Antes se seguia acumulando en `contenido` aunque ya no se escribiera
    // nada: el cliente veia N tokens y el gateway guardaba N+k. Con la
    // atestacion de D24 eso deja de ser un detalle contable — D27 pide que el
    // hash de la parcial sea el del prefijo que el cliente EFECTIVAMENTE
    // recibio, porque si no, no hay contra que verificarlo.
    if (cancelado || cortadoPorTope) return

    // El primer delta con contenido es el primer token, no el chunk de
    // apertura: ese solo trae {role} y llegaria antes, midiendo de menos.
    if (ttftMs === null) ttftMs = Date.now() - startedAt
    tokens++
    contenido += delta

    // FASE 9 / D9(a) — el tope que el 402 declaro, aplicado.
    //
    // Esto FALTABA: `topeDeSalidaCobrado` armaba el `outputTokenLimit` del
    // `accepts[]` y despues no lo aplicaba nadie -- el camino de generacion
    // usaba `topeDeSalida`, que para un par, el motor local y un mock devuelve
    // lo que pidio el cliente, o sea cero, o sea sin techo. El 402 cobraba un
    // precio fijo declarando "hasta N tokens" y generaba sin limite.
    //
    // D9 lo llama no negociable por el lado del `finish_reason`: si se recorta
    // por el tope, tiene que decir `length` y no `stop`. Se marca acá y lo
    // reporta `finishReasonDe` mas abajo.
    if (topeCobrado > 0 && estimarTokensDeSalida(contenido) >= topeCobrado) {
      cortadoPorTope = true
      finReal = 'length'
      // Se corta de los dos lados: al par por su propio canal, al motor local y
      // al externo por el signal. No es un fallo -- `streamFromPeer` resuelve
      // ok:true si ya habia empezado, y el `for await` de `streamFromLocal`
      // sale por el break y devuelve ok:true igual.
      if (requestIdEnVuelo) swarmRef.cancelChat(requestIdEnVuelo)
      cancelacion.abort()
    }

    if (!stream) return
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
        // `elegido`, no `node`: con reintento el que contesta puede no ser el
        // que se eligio primero, y el header nombra a QUIEN CONTESTO. Decia el
        // del primer intento, o sea mentia en el unico caso donde el dato
        // importa.
        ...provenanceHeaders(elegido || node, costoEstimado),
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
  let terminado = false
  let requestIdEnVuelo = null

  // B3 -- el cliente se fue y el gasto tiene que irse con el. Del lado del par
  // se le manda un chat:cancel; del lado local y del externo, este signal es
  // el que corta el `for await` y aborta el fetch al proveedor. Lo que sigue
  // corriendo despues de que el cliente cerro la pestaña son dolares de la
  // cuenta del operador.
  const cancelacion = new AbortController()
  const onClientGone = () => {
    // Despues de terminar, el 'close' del response es el cierre normal:
    // abortar ahi seria disparar un error sobre un request que salio bien.
    if (terminado) return
    cancelado = true
    if (requestIdEnVuelo) swarmRef.cancelChat(requestIdEnVuelo)
    cancelacion.abort()
  }
  req.on('close', onClientGone)
  res.on('close', onClientGone)

  const intentos = []
  let elegido = null
  let ultimo = null
  let usoExterno = null
  let costoTotal = 0
  // El candidato que se salteo por falta de saldo, si despues contesto otro.
  // Es una decision de PLATA y el rastro tiene que poder distinguirla de una
  // eleccion normal: sin esto, "eligio local" y "queria el externo y no le
  // alcanzaba" se ven identicas en el panel.
  let degradado = null
  // La ultima reserva rechazada. Si NINGUN candidato llego a intentarse por
  // falta de saldo, es lo que convierte el fracaso en un 402 con numeros en
  // vez de un 502 generico.
  let sinSaldo = null

  for (const cand of candidatos) {
    if (cancelado) break

    // Un par sin agente lanzado no se puede intentar -- pero NO corta la
    // lista: el modelo de esta maquina puede estar mas abajo, y antes ese caso
    // devolvia 503 sin llegar a mirarlo.
    if (cand.kind === 'peer' && !swarmRef) {
      ultimo = {
        ok: false,
        code: 'agent_offline',
        message:
          'your node is offline, so the network is out of reach — launch your local agent to use it.'
      }
      intentos.push({ nodeId: cand.id, operator: cand.operator, ok: false, code: 'agent_offline' })
      continue
    }

    // FASE 6.5 — la reserva va por INTENTO: despues de saber a quien se le va
    // a pedir (el precio depende del nodo) y antes de pedirselo. Un tope que
    // se evalua despues del gasto es un descuento.
    const tope = topeDeSalida(cand, maxTokensPedido)
    const estimado = estimarRequest({ node: cand, maxTokens: tope, promptTokens })
    costoEstimado = estimado
    const reserva = budget.reserve(cuenta, estimado)
    if (!reserva.ok) {
      // No alcanza para ESTE candidato. No es el final del camino: el
      // siguiente puede ser gratis, y contestar con el motor local es mejor
      // que negar el servicio. Es la degradacion del DoD de la Fase 8.5,
      // ahora como un paso mas del recorrido y no como un caso especial.
      sinSaldo = reserva
      if (!degradado) {
        degradado = {
          de: cand.id,
          motivo:
            `${reserva.scope === 'nodo' ? 'presupuesto del nodo agotado' : 'presupuesto agotado'}: ` +
            `quedan ${costs.formatUSD(reserva.remaining)} de un tope de ${costs.formatUSD(reserva.cap)}`
        }
      }
      intentos.push({
        nodeId: cand.id,
        operator: cand.operator,
        ok: false,
        code: 'budget_exhausted'
      })
      continue
    }

    // Lo que genero un intento fallido no cuenta para el siguiente. Sin esto,
    // en el camino no-stream -- donde el contenido se junta y se manda al
    // final -- la respuesta del que contesto saldria pegada al pedazo del que
    // se cayo, y el cliente leeria las dos mitades como una sola.
    if (!headersSent) {
      contenido = ''
      tokens = 0
      ttftMs = null
      finReal = null
    }

    elegido = cand
    usoExterno = null
    let saturado = false
    store.beginRequest(cand.id)
    try {
      const r =
        cand.kind === 'peer'
          ? await streamFromPeer({
              node: cand,
              model,
              messages,
              onStart: (rid) => {
                requestIdEnVuelo = rid
                // El cliente se fue MIENTRAS se armaba el request: se cancela
                // ya mismo, sin esperar a que el par empiece a generar.
                if (cancelado) swarmRef.cancelChat(rid)
              },
              onChunk: emit,
              // D27 — el mismo signal que corta al motor local y al externo.
              // Sin esto un corte del cliente o del tope dejaba al par
              // generando hasta que saltara el reloj de inactividad, y el
              // request terminaba como si el par hubiera fallado.
              signal: cancelacion.signal
            })
          : await streamFromLocal({
              node: cand,
              messages,
              prompt,
              maxSalida: tope,
              signal: cancelacion.signal,
              onChunk: emit,
              onUsage: (u) => {
                usoExterno = u
              },
              onFinish: (f) => {
                finReal = f
              }
            })
      requestIdEnVuelo = null
      ultimo = r
      intentos.push({ nodeId: cand.id, operator: cand.operator, ok: r.ok, code: r.code || null })

      if (r.ok) break

      // D4: si ya se le mando aunque sea un token AL CLIENTE, no se reintenta.
      // El contexto de una respuesta a medias no se puede retomar en otro nodo.
      //
      // La condicion es `headersSent` y no `r.started`, y la diferencia es
      // real: `started` dice que el PROVEEDOR empezo a generar, pero en el
      // camino no-stream el contenido se junta y no sale hasta el final, asi
      // que el cliente todavia no vio nada y el reintento sigue siendo
      // legitimo. Cortar por `started` renunciaba a reintentar justo cuando
      // no habia ningun motivo para no hacerlo.
      if (headersSent) break

      // Dijo que esta lleno. De un par es informacion mas fresca que el ultimo
      // `node:status`, que puede tener hasta 2s de atraso (swarm.mjs:48); de un
      // upstream es un 429, o sea la cuota del proveedor agotada. En los dos
      // casos volver a elegirlo en los proximos segundos se come el mismo
      // rechazo. S5 de NOTES-SATURACION.md.
      //
      // Se ANOTA aca y se aplica en el finally, DESPUES del endRequest. Al
      // reves -- que es como estaba -- el endRequest de la salida bajaba en uno
      // el contador que markSaturated acababa de llenar, y el nodo quedaba con
      // exactamente un slot libre: o sea no saturado, o sea elegible otra vez
      // para el request siguiente. La marca no protegia de nada.
      if (r.code === 'at_capacity') saturado = true

      // Con la maquina fijada por el cliente no hay a quien reintentarle: pedir
      // un nodo concreto y recibir la respuesta de otro es exactamente lo que
      // el pin existe para impedir.
      if (pin) break

      console.log(
        `[gateway] ${cand.operator} fallo antes del primer token (${r.code}), pruebo otro`
      )
    } finally {
      store.endRequest(cand.id)
      if (saturado) store.markSaturated(cand.id)
      // Se liquida ESTE intento antes de pasar al siguiente. Una reserva que
      // no se liquida queda comprometiendo saldo hasta que reinicie el
      // proceso, y con reintentos habria una por candidato probado.
      const costo = costoDelIntento({ node: cand, usoExterno, tokens, reserva })
      budget.settle(reserva.id, costo)
      costoTotal += costo
    }
  }

  // FASE 9 / D25 — las dos dimensiones, calculadas una sola vez: las miran la
  // atestacion de D24 y el rastro del final, y tienen que ser el mismo numero.
  const d25 = tokensD25({ usoExterno, tokens, promptTokens })

  // FASE 9 / D27 — QUIEN CORTO decide, y decide dos cosas distintas: si se cobra
  // y que dice la atestacion. Los tres casos, en el orden en que se distinguen:
  //
  //   1. el cliente cerro la pestaña  -> atestacion PARCIAL sobre el prefijo que
  //      efectivamente recibio, y SI se cobra hasta ahi;
  //   2. el proveedor se cayo         -> NINGUNA atestacion y NO se cobra. Sale
  //      solo: sin `ultimo.ok` no se entra a este bloque y nunca se liquida;
  //   3. se toco el tope de D9        -> atestacion completa, `length`, se cobra.
  //
  // El caso 2 no aparece como rama porque no puede: es la ausencia de las otras
  // dos. Que se lea asi es a proposito -- un caso de "no cobrar" que dependiera
  // de una condicion escrita seria un caso que alguien puede borrar sin querer.
  const finAtestado = cortadoPorTope
    ? 'length'
    : cancelado
      ? 'client_cancelled'
      : finishReasonDe(finReal)

  try {
    if (ultimo && ultimo.ok) {
      // B14 — la guarda del 200 vacio va ANTES de partir los dos caminos.
      //
      // Estaba solo del lado del stream, con el `return` del no-stream por
      // delante: quien pedia sin `stream: true` -- un curl, Open WebUI, el
      // default de cualquier SDK de OpenAI -- recibia 200 con `content: ""` y
      // `finish_reason: "stop"`. O sea exactamente lo que el comentario de
      // abajo decia que no habia que devolver, en la mitad de los casos.
      if (!headersSent && contenido === '') {
        return sendError(res, 502, 'el par termino el request sin devolver ningun token', {
          type: 'server_error',
          code: 'empty_response'
        })
      }

      if (!stream) {
        // D12 — en el camino SIN stream no hay problema: la respuesta se arma
        // entera antes de escribir un byte, asi que se liquida ACA y el recibo
        // viaja en `X-PAYMENT-RESPONSE` como manda el spec, sin desviacion.
        const recibo = pago
          ? await liquidarYRegistrar(
              pago,
              id,
              await atestacionDe({
                id,
                node: elegido,
                messages,
                contenido,
                d25,
                finishReason: finAtestado
              })
            )
          : null

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
              {
                index: 0,
                message: { role: 'assistant', content: contenido },
                finish_reason: finishReasonDe(finReal)
              }
            ]
          },
          {
            ...provenanceHeaders(elegido || node, costoEstimado),
            ...(recibo ? { 'X-PAYMENT-RESPONSE': recibo.cabecera } : {})
          }
        )
      }

      // D12 — con stream los headers ya salieron ANTES del primer token, asi
      // que el recibo no puede viajar en uno. Va como EVENTO SSE FINAL, y esa
      // es la desviacion del spec que D12 acepta a cambio de no meter una
      // transaccion on-chain delante del TTFT.
      //
      // La condicion de D12 es que la desviacion se pueda descubrir desde la
      // respuesta misma: un cliente x402 estandar que busque el header y no lo
      // encuentre tiene que poder enterarse de POR QUE. De ahi `x402Note` y el
      // `receiptUrl`, que no son parte del spec y estan a proposito.
      if (pago) {
        const recibo = await liquidarYRegistrar(
          pago,
          id,
          await atestacionDe({
            id,
            node: elegido,
            messages,
            contenido,
            d25,
            finishReason: finAtestado
          })
        )
        // El cliente puede haberse ido: D27 caso 1 dice que igual se liquida y
        // se atestigua -- el trabajo se hizo y el prefijo llego --, pero
        // escribirle a un socket cerrado tira, y esa excepcion se llevaria
        // puesto el `res.end()` ordenado del finally. La liquidacion ya ocurrio
        // arriba: lo unico que se pierde es el aviso, y queda en /v1/receipts.
        if (!cancelado) {
          try {
            res.write(
              `data: ${JSON.stringify({
                x402Version: 2,
                x402Note:
                  'El recibo viaja como evento SSE final y no en X-PAYMENT-RESPONSE: ' +
                  'en streaming los headers salen antes del primer token, asi que liquidar ' +
                  'para poder escribirlo pondria una transaccion on-chain delante del TTFT. ' +
                  'Ver D12 del roadmap. Tambien se puede recuperar por receiptUrl.',
                paymentResponse: recibo.recibo,
                // D24 — la atestacion viaja con el recibo, o el motivo por el
                // que no hay. Una ausencia con motivo es un dato; una ausencia
                // muda es un agujero que alguien va a leer como "no hace falta".
                attestation: recibo.atestacion || null,
                attestationMissing: recibo.sinAtestacion || undefined,
                receiptUrl: `/v1/receipts/${id}`
              })}

`
            )
          } catch (err) {
            console.log(`[gateway] el recibo no se pudo escribir: ${(err && err.message) || err}`)
          }
        }
      }

      const close = chunkEvent({
        id,
        created,
        model,
        delta: {},
        finishReason: finishReasonDe(finReal)
      })
      res.write(`data: ${JSON.stringify(close)}\n\n`)
      res.write('data: [DONE]\n\n')
      return
    }

    // Ningun candidato pudo. Si no se escribio nada todavia, el fracaso viaja
    // como status HTTP y con el motivo del ultimo intento.
    //
    // El 402 va primero: que no alcance el saldo no es un fallo del proveedor
    // sino una decision de este nodo, y merece su propio status y sus numeros.
    if (!elegido && sinSaldo) {
      return sendError(
        res,
        402,
        // B13 — se dice CUAL de los dos topes se agoto. "No te alcanza" sin
        // decir cual techo tocaste no es accionable: bajarle el tope a una key
        // no arregla un nodo sin saldo, y al reves tampoco.
        `${sinSaldo.scope === 'nodo' ? 'presupuesto del nodo agotado' : 'presupuesto agotado'}: ` +
          `quedan ${costs.formatUSD(sinSaldo.remaining)} de un tope de ${costs.formatUSD(sinSaldo.cap)}`,
        { type: 'insufficient_quota', code: 'budget_exhausted' }
      )
    }

    const motivo = ultimo ? ultimo.message : 'no hay ningun nodo sirviendo ese modelo'
    const code = ultimo ? ultimo.code : 'no_peer'

    if (!headersSent) {
      // La puerta del producto: sin agente lanzado no se llega a la red, y el
      // mensaje tiene que decir el siguiente paso en vez de solo negar.
      if (code === 'agent_offline') {
        return sendError(
          res,
          503,
          'your node is offline, so the network is out of reach — launch your local agent to use it. Your own local model still answers.',
          { type: 'service_unavailable', code }
        )
      }
      // 502 cuando el que fallo fue OTRA maquina -- un par o una API de un
      // tercero -: el error no es de este gateway, y un 500 mandaria a revisar
      // el lado equivocado. Es la distincion que hace cualquier proxy.
      const status = elegido && !esTercero(elegido) && elegido.kind !== 'peer' ? 500 : 502
      const prefijo = elegido && elegido.kind === 'peer' ? 'el par remoto no pudo responder: ' : ''
      return sendError(res, status, `${prefijo}${motivo}`, {
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

    terminado = true
    const ms = Date.now() - startedAt
    const ok = !!(ultimo && ultimo.ok)

    // Ya se liquido por intento adentro del loop; aca solo se reporta el
    // acumulado. Liquidar de nuevo cobraria dos veces el mismo request.
    const costoReal = costoTotal

    store.pushLog({
      modelId: model,
      // De donde salieron los tokens. 'local' es esta maquina -- con el motor
      // embebido o con un motor propio detras de HTTP -; 'peer' es otra
      // maquina de la red; 'upstream' es la API de un tercero; 'mock' es
      // teatro del modo --demo. Distinguirlos importa: sin el campo, una
      // corrida con --demo produce un rastro con tok/s inventados que no se
      // puede separar de uno real, y un upstream local inflaria el panel de
      // consumo externo con requests que nunca salieron de la maquina.
      target: targetDe(elegido),
      costMicros: costoReal,
      nodeId: elegido ? elegido.id : null,
      operator: elegido ? elegido.operator : null,
      candidatos: candidatos.length,
      reason: degradado
        ? `${degradado.motivo} — se degrado de ${degradado.de} a otro candidato`
        : `${intentos.length > 1 ? `${intentos.length} de ${candidatos.length} candidatos intentados — ` : ''}` +
          `${motivo || `${candidatos.length} candidato(s) para "${model}"`}`,
      // El rastro tiene que poder distinguir "eligio local" de "queria el
      // externo y no le alcanzo el saldo". Sin esto las dos entradas se ven
      // iguales, y la degradacion -- que es una decision de plata -- queda sin
      // auditoria.
      degradado: degradado || undefined,
      // POR QUE se eligio a este y no a otro: la carga del elegido y la de los
      // que quedaron atras. Es el DoD de la Fase 8 -- antes el log solo podia
      // decir "el primero", que no es un motivo.
      decision: decision || undefined,
      intentos: intentos.length > 1 ? intentos : undefined,
      ok,
      code: ok ? null : (ultimo && ultimo.code) || (sinSaldo ? 'budget_exhausted' : 'no_peer'),
      tokens,
      ttftMs,
      tokensPerSec: tokensPerSec({ tokens, ttftMs, ms }),
      ms,
      // FASE 9 / D25 — los campos NUEVOS. `tokens`, `ttftMs` y `ms` quedan como
      // estaban: hay panel y rastro historico leyendolos, y cambiarles el
      // significado convertiria las entradas viejas en otra cosa sin avisar.
      //
      // El prefill procesa el prompt en paralelo y lo limita el computo; el
      // decode genera token a token y lo limita el ancho de banda de memoria.
      // Una tarifa unica mezcla dos costos que no escalan igual. D22 igual NO se
      // toca: registrar es barato y es la unica forma de tener despues con que
      // informar esa decision -- cambiar el precio hoy seria decidirlo sin datos.
      tokensPrefill: d25.tokensPrefill,
      tokensDecode: d25.tokensDecode,
      tokensFuente: d25.tokensFuente,
      // D27 — como termino, en el vocabulario de la atestacion y no en el de
      // OpenAI. Sin esto, en el rastro un corte del cliente y una respuesta
      // completa se ven identicos, que es justo el caso mas frecuente del uso
      // real y donde un proveedor tiene mas margen para reclamar tokens que
      // nadie recibio.
      finishReason: finAtestado
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

// FASE 9 — el piso de un cobro por x402, en micro-dolares.
//
// La inferencia P2P vale CERO para el ledger, y eso es correcto: ese contador
// mide dolares que este nodo le paga a un tercero, y a un par no se le paga en
// dolares. Pero un 402 que pide cero no es un cobro. Este es el numero que
// convierte "no me cuesta nada" en "esto es lo que sale", y es de negocio:
// USD 0,001, que es el monto con el que el roadmap dice empezar (riesgo #2).
const PRECIO_MINIMO_MICROS = 1000

function estimarRequest({ node, maxTokens = 0, promptTokens = 0 }) {
  const clave = claveDePrecio(node)
  if (!clave || !costs.conocido(clave)) return 0
  return costs.estimar({ model: clave, promptTokens, maxTokens })
}

// FASE 9 / D10 — el 402 de un candidato concreto.
//
// Devuelve el cuerpo del desafio, o null si a este candidato no se le puede
// cobrar. Null NO es un error: un par que no declara wallet, o un nodo sin
// ninguna red usable, son estados legitimos -- y el llamador tiene que poder
// distinguirlos de "hay que pagar" para no contestar 402 sin decir a quien.
//
// El `payTo` sale del manifiesto FIRMADO del candidato (store.mjs lo guarda al
// verificarlo), o de la wallet propia si el que va a contestar es este nodo.
// Nunca de una constante: D10 decide que se le paga DIRECTO al proveedor, y si
// el gateway pusiera su propia direccion seria el intermediario que el README
// promete que no existe.
async function cobroDe({ node, maxTokensPedido, req }) {
  if (!node) return null

  const propio = node.kind !== 'peer'
  const payTo = propio
    ? economicPropio && economicPropio.walletAddress
    : node.economic && node.economic.walletAddress
  if (!payTo) return null

  // El tope de salida que se va a aplicar, que es el numero que hace honesto
  // al precio fijo de D9(a): "hasta N tokens por $X". Se declara el MISMO que
  // el gateway impone despues.
  const maxTokens = topeDeSalidaCobrado(node, maxTokensPedido)

  // Lo que costaria servirlo. Para el camino P2P y el local hoy da cero -- el
  // precio del ledger es cero porque el pago P2P es justamente esta fase --,
  // asi que se cobra un minimo declarado en vez de cero: un 402 que pide cero
  // no es un cobro, y regalarlo tampoco es lo que el nodo acepto al declarar
  // una wallet.
  const estimado = estimarRequest({ node, maxTokens, promptTokens: 0 })
  const micros = Math.max(estimado, PRECIO_MINIMO_MICROS)

  const proto = 'http'
  const host = req.headers.host || 'localhost'
  try {
    const desafio = await x402.desafio({
      payTo,
      micros,
      maxTokens,
      recurso: `${proto}://${host}/v1/chat/completions`,
      descripcion: `Inferencia de ${node.modelId} en ${node.operator}, hasta ${maxTokens} tokens de salida`
    })
    if (!desafio) return null
    // Se devuelve TODO lo que hizo falta para armarlo, porque verificar tiene
    // que usar exactamente los mismos numeros. Recalcularlos del otro lado es
    // la forma mas facil de rechazar un pago correcto.
    return { desafio, payTo, micros, maxTokens }
  } catch (err) {
    // Un 402 mal armado es peor que ninguno: el cliente firmaria una
    // autorizacion contra datos equivocados. Se avisa y se cae al 401.
    console.error(`[x402] no se pudo armar el 402: ${(err && err.message) || err}`)
    return null
  }
}

// Verifica el X-PAYMENT contra el cobro que se le ofrecio.
//
// El cliente elige UNA de las redes del `accepts[]`, asi que se prueba contra
// la que dice el pago. Si no dice ninguna, se prueba contra la primera que se
// ofrecio, que es la preferida de D15.
async function verificarCobro(cobro, cabecera) {
  let red = null
  try {
    const sobre = JSON.parse(Buffer.from(String(cabecera), 'base64').toString('utf8'))
    const elegida = cobro.desafio.accepts.find((a) => a.network === sobre.network)
    red = elegida ? redDe(elegida.network) : null
  } catch {
    // Un header ilegible lo rechaza `verificarPago` con su propio motivo.
  }
  if (!red) red = redDe(cobro.desafio.accepts[0].network)

  return x402.verificarPago(cabecera, {
    payTo: cobro.payTo,
    activo: await x402.activoDe(red),
    micros: cobro.micros,
    red
  })
}

// El requisito EXACTO contra el que se firmo, que es contra el que hay que
// liquidar. Recalcularlo seria liquidar contra numeros distintos de los que el
// cliente acepto.
function requisitoDe(cobro, red) {
  const id = x402.CAIP2[red]
  return cobro.desafio.accepts.find((a) => a.network === id) || cobro.desafio.accepts[0]
}

function redDe(caip2) {
  for (const [nombre, id] of Object.entries(x402.CAIP2)) if (id === caip2) return nombre
  return null
}

async function handleChat(req, res) {
  // FASE 9 / D16 — TRES caminos de acceso que no se pisan:
  //
  //   local: true                 gratis, sin red, sin pago. La excepcion del
  //                               README se mantiene.
  //   Authorization: Bearer …     la key emitida por el panel. Es el camino del
  //                               humano que ya configuro un bot.
  //   ni key ni pago              402.
  //
  // El 402 como DEFAULT PARA DESCONOCIDOS es la fase entera: es lo que permite
  // que un agente consuma sin registrarse en nada. Y no reemplaza a las keys --
  // convive, que es lo que D16 decide.
  //
  // El rechazo por falta de key ya no puede ser un 401 seco: si este nodo puede
  // cobrar, el que no trae credencial no esta mal autenticado, esta sin pagar,
  // y esas dos cosas son respuestas distintas. Se decide DESPUES de elegir
  // candidato, porque el 402 tiene que decir cuanto y a quien, y las dos cosas
  // dependen de quien vaya a contestar.
  const sinCredencial = rechazoPorKey(req)

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
  const externos = candidatos.filter(esTercero)

  // Un upstream LOCAL sobrevive a este filtro, y tiene que sobrevivir: el
  // pedido dice "que no salga de esta maquina", y un llama-server en localhost
  // no la saca. Filtrarlo dejaria sin contestar al unico caso donde el candado
  // y la capacidad no estan en conflicto.
  if (local) candidatos = candidatos.filter((n) => n.kind !== 'peer' && !esTercero(n))

  // D19 — las otras dos condiciones del externo. Se aplican como FILTRO de
  // candidatos y no como un `if` en el despacho: un upstream inelegible tiene
  // que ser invisible para pickCandidate, o terminaria ganando por carga (esta
  // siempre en 0) y recien ahi lo rechazariamos.
  let vetoExterno = null
  if (externos.length > 0) {
    // Solo las reglas DURAS filtran. "Hay capacidad local" ya no esta acá:
    // se volvio una posicion en la lista, mas abajo, porque la capacidad
    // declarada de un candidato no prueba que ese candidato funcione.
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
    }
    // El opt-in y el candado `local: true` son reglas DURAS: sacan al externo
    // de la lista y no hay vuelta. La tercera condicion de D19 -- "sin
    // capacidad local" -- no puede serlo, y esa es la diferencia que se vio
    // recien probandolo con un motor local apagado:
    //
    //   la capacidad DECLARADA de un candidato no dice que ese candidato
    //   funcione. Un llama-server que no esta levantado anuncia 0/2 -- o sea
    //   "tengo lugar" --, el externo quedaba vetado por eso, el local fallaba
    //   y no habia a quien recurrir. El respaldo existia solo en el papel.
    //
    // Asi que el externo deja de filtrarse y pasa AL FINAL de la lista. Con el
    // recorrido por candidatos, quedar ultimo ES la condicion: se lo intenta
    // cuando los de casa no pudieron, medido por lo que paso y no por lo que
    // anunciaron. Y mientras alguno de casa conteste, el prompt no sale.
    if (vetoExterno) candidatos = candidatos.filter((n) => !esTercero(n))
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

  // FASE 8 — el precio entra al ruteo.
  //
  // Se le pasa a `pickCandidate` una funcion ya ATADA A ESTE REQUEST: el costo
  // de un candidato no es una propiedad del candidato, depende del prompt y del
  // tope de salida. Un prompt largo contra un modelo caro y el mismo prompt
  // contra uno gratis no se comparan con una tarifa, se comparan con el numero
  // que le va a salir a esta persona por ESTA pregunta.
  //
  // Es exactamente `estimarRequest`, la misma funcion con la que se abre la
  // reserva del presupuesto unas lineas mas abajo. Que sean la MISMA importa:
  // rutear por un numero y cobrar por otro seria elegir con informacion que no
  // es la que despues se descuenta.
  const promptTokensDelRuteo = estimarPromptTokens(messages)
  const eleccion = pickCandidate(candidatos, {
    statsFor: store.statsFor,
    precioDe: (cand) =>
      estimarRequest({
        node: cand,
        maxTokens: topeDeSalida(cand, norm.maxTokens || 0),
        promptTokens: promptTokensDelRuteo
      }),
    pin
  })

  // El cliente fijo una maquina que ya no esta entre los candidatos. NO se
  // rutea a otra: el que elige una maquina quiere esa, y contestarle con otra
  // sin avisar vacia de sentido a la funcion. El 404 dice cual pidio.
  if (pin && !eleccion.node) {
    return sendError(res, 404, eleccion.reason, { code: 'node_not_found' })
  }

  // El MEJOR candidato, no el unico: quien recorre la lista es
  // handleChatConReintentos. Aca solo se usa para los errores de mas abajo,
  // que hablan del que se eligio primero.
  const node = eleccion.node

  // FASE 9 — el pago, recien acá, porque antes no se sabia ni cuanto ni a quien.
  let pagoVerificado = null
  // D9(a) — el tope que se DECLARO en el 402, para poder APLICARLO despues.
  // Cero mientras no haya cobro: el camino con API key lo acota el presupuesto.
  let topeDeclarado = 0
  if (sinCredencial) {
    const cobro = await cobroDe({ node, maxTokensPedido: norm.maxTokens || 0, req })

    // Este nodo no puede cobrar -- sin wallet, o sin ninguna red usable -- asi
    // que el unico camino que queda es el de siempre: la key.
    if (!cobro) return sendError(res, 401, sinCredencial)

    const cabecera = req.headers['x-payment'] || req.headers['X-PAYMENT']
    if (!cabecera) {
      // 402 y no 401: no le falta credencial, le falta pagar. Son dos arreglos
      // distintos del lado del cliente y merecen dos respuestas distintas.
      return sendJson(res, 402, cobro.desafio, provenanceHeaders(node, 0))
    }

    // D12 — la verificacion es SINCRONICA y no toca la cadena. Es la parte que
    // protege al proveedor de gastar GPU gratis, y va ANTES de generar un solo
    // token: despues seria tarde, que es todo el punto.
    const verificado = await verificarCobro(cobro, cabecera)
    if (!verificado.ok) {
      // Se contesta 402 otra vez, con el desafio, y no 400: el cliente puede
      // volver a firmar. Un 400 le diria "tu request esta mal" cuando lo que
      // esta mal es el pago, y no le daria contra que volver a firmar.
      console.error(`[x402] pago rechazado: ${verificado.motivo}`)
      return sendJson(
        res,
        402,
        { ...cobro.desafio, error: verificado.motivo },
        provenanceHeaders(node, 0)
      )
    }
    console.log(
      `[x402] pago verificado de ${verificado.payer.slice(0, 10)}… por ${cobro.micros} micros`
    )
    pagoVerificado = { ...verificado, requisito: requisitoDe(cobro, verificado.red) }
    // El MISMO numero que viajo en el `accepts[]`, no uno recalculado. D9 lo
    // dice sin vuelta: se declara antes de generar y se aplica despues, y tienen
    // que ser el mismo. Hasta acá se declaraba y no se aplicaba.
    topeDeclarado = cobro.maxTokens
  }
  // El orden puntuado, no el de llegada: si el mejor falla antes del primer
  // token, D4 reintenta en el segundo MEJOR, no en el siguiente de la lista.
  //
  // Con una salvedad: los terceros van al fondo, sin importar que tengan la
  // carga mas baja (siempre la tienen: es la de una API que no es nuestra).
  // Es la tercera condicion de D19 aplicada como POSICION y no como filtro
  // -- ver la nota de arriba --, y `partition` la deja estable, asi que entre
  // ellos conservan el orden por carga que les dio pickCandidate.
  const orden = eleccion.orden
  const propios = orden.filter((n) => !esTercero(n))
  // La tercera condicion de D19: mientras alguien de casa pueda atender AHORA,
  // el externo va al fondo. Si estan todos saturados no se lo demora: ahi el
  // orden de pickCandidate ya pone adelante al que tiene lugar, y el externo
  // es el unico que lo tiene. Es el caso que el roadmap pide -- red saturada,
  // el request se va afuera -- y demorarlo tambien lo romperia.
  candidatos = propios.some((n) => !estaSaturado(n))
    ? [...propios, ...orden.filter(esTercero)]
    : orden
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

  // El recorrido de candidatos, la reserva por intento, el streaming, la
  // liquidacion y el rastro viven todos ahi. handleChat elige QUE candidatos
  // hay y en que orden; ese otro los prueba hasta que uno conteste.
  return await handleChatConReintentos({
    req,
    res,
    node,
    candidatos,
    model,
    messages,
    stream,
    cuenta: cuentaDe(req),
    maxTokensPedido: norm.maxTokens || 0,
    pin,
    decision,
    motivo: motivoRuteo,
    // FASE 9 — el pago ya verificado, para liquidarlo DESPUES de servir (D12).
    pago: pagoVerificado,
    topeCobrado: topeDeclarado
  })
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
    if (req.method === 'GET' && pathname === '/wallet') {
      const { WALLET_HTML } = await import('./pages.mjs')
      return sendHtml(res, WALLET_HTML)
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
        // B12 -- `owned_by` decia el operador, o sea "OpenRouter (externo)":
        // era la tercera puerta por la que se leia que proveedor paga este nodo,
        // y la unica de las tres que no se puede cerrar con credencial. Un
        // cliente OpenAI tiene que poder descubrir el catalogo ANTES de tener
        // key -- cerrar esta ruta romperia justamente la compatibilidad que es
        // la razon de que exista --, asi que se cierra el dato y no la puerta.
        //
        // El `id` ya no delata nada: desde `anunciadoComo` el catalogo lleva el
        // nombre con el que ESTA red anuncia el modelo, no el del proveedor.
        .map((n) => ({ id: n.modelId, object: 'model', created, owned_by: 'pyrusllm' }))
      return sendJson(res, 200, { object: 'list', data })
    }
    // Vista rica del marketplace: precio, operador, carga. La consumen los
    // paneles; no es parte del protocolo de OpenAI y por eso vive aparte.
    //
    // B12 -- pide credencial, por lo mismo que B7 se la puso a /v1/upstream.
    // `toPublic` devuelve `operator` ("OpenRouter (externo)") y `pricing`
    // ("USD 0.20 / per 1m completion tokens"), que es EXACTAMENTE lo que aquella
    // ruta protege: quien es el proveedor y que se le paga. Cerrar una de las
    // dos y dejar la otra abierta no protegia nada -- solo hacia falta pedir el
    // dato por la puerta de al lado.
    if (req.method === 'GET' && pathname === '/v1/nodes') {
      const motivoNodos = rechazoPorKey(req)
      if (motivoNodos) return sendError(res, 401, motivoNodos)

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
      // B7 -- pide credencial igual que el POST. La respuesta no lleva
      // secretos (el NOMBRE de la variable de entorno, nunca su valor), pero si
      // lleva quien es el proveedor, que modelos se le pagan y si la credencial
      // esta cargada. Con eso, cualquiera que llegue al puerto sabe si hay una
      // cuenta con saldo del otro lado y contra que API. El resto de las rutas
      // que hablan de plata ya piden key; esta se habia quedado afuera.
      const rechazoLectura = rechazoPorKey(req)
      if (rechazoLectura) return sendError(res, 401, rechazoLectura)
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
    // B12 -- y esta es la que mas expone de las tres. Ademas del proveedor y su
    // precio, cada entrada lleva `costMicros` -- el gasto en dolares, request
    // por request -- y `degradado`, que es el rastro de las decisiones de plata.
    // Era la unica ruta del sistema desde la que se podia leer cuanto gasta el
    // operador sin presentar nada.
    // FASE 7 — a donde cobra este nodo.
    //
    // Pide credencial por el mismo criterio que B12: es informacion de plata.
    // El limite honesto es que la direccion NO es un secreto -- viaja en el
    // manifiesto firmado que se le anuncia a toda la red, y tiene que viajar,
    // porque es a quien hay que pagarle. Lo que el gate protege es que un
    // tercero cualquiera pueda preguntarle al puerto si esta maquina cobra.
    if (req.method === 'GET' && pathname === '/v1/wallet') {
      const motivoWallet = rechazoPorKey(req)
      if (motivoWallet) return sendError(res, 401, motivoWallet)
      return sendJson(res, 200, walletStatus())
    }
    // FASE 11 — los saldos de la wallet de cobro, para el panel /wallet. SOLO
    // LECTURA: `eth_getBalance` nativo + `balanceOf` de USD₮0 en Plasma. El
    // gate es el mismo de /v1/wallet: la direccion no es secreta pero un
    // tercero cualquiera no tiene por que sondear cuanto tiene esta maquina.
    //
    // Un RPC caido NO devuelve ceros: el campo se deja en null y el panel lo
    // dibuja "—" con el motivo. Afirmar "0" seria decir que la wallet esta
    // vacia cuando lo unico que pasa es que no se pudo mirar.
    if (req.method === 'GET' && pathname === '/v1/wallet/balances') {
      const motivoBal = rechazoPorKey(req)
      if (motivoBal) return sendError(res, 401, motivoBal)

      const address = economicPropio ? economicPropio.walletAddress : null
      if (!address || !walletRed) {
        return sendJson(res, 200, {
          configurada: false,
          address,
          red: null,
          nativo: null,
          tokens: [],
          error: null
        })
      }

      const red = {
        nombre: walletRed.nombre || null,
        caip2: walletRed.caip2 || null,
        chainId: walletRed.chainId || null,
        explorer: walletRed.explorer || null,
        mainnet: !!walletRed.mainnet
      }

      let nativo = null
      let error = null
      try {
        const wei = await rpcCall(walletRed.rpc, 'eth_getBalance', [address, 'latest'])
        nativo = { decimals: 18, raw: String(wei == null ? '0x0' : wei) }
      } catch (err) {
        nativo = { decimals: 18, raw: null, error: (err && err.message) || String(err) }
        error = 'no se pudo leer el balance nativo contra el RPC'
      }

      const tokens = []
      // Solo el activo de Plasma, y desde la MISMA constante que usa x402: una
      // sola fuente de verdad para una direccion de contrato (ver x402.mjs).
      if (walletRed.caip2 === 'eip155:9745' && x402.PLASMA_USDT0_SIN_VERIFICAR) {
        const t = x402.PLASMA_USDT0_SIN_VERIFICAR
        const fila = {
          symbol: t.symbol,
          name: t.name,
          address: t.asset,
          decimals: t.decimals,
          verificado: false
        }
        try {
          const raw = await rpcCall(walletRed.rpc, 'eth_call', [
            { to: t.asset, data: balanceOfData(address) },
            'latest'
          ])
          fila.raw = String(raw == null ? '0x0' : raw)
        } catch (err) {
          fila.raw = null
          fila.error = (err && err.message) || String(err)
        }
        tokens.push(fila)
      }

      return sendJson(res, 200, { configurada: true, address, red, nativo, tokens, error })
    }
    // FASE 9 / D12 — recuperar el recibo de un request que se pago.
    //
    // Existe porque con stream el recibo viaja como evento SSE final, y un
    // cliente que corto la conexion antes del ultimo evento se quedaria sin el.
    // NO pide credencial: quien pago no tiene ninguna -- ese es todo el punto
    // del 402 -- y el id de la completion ya es un secreto suficiente para
    // recuperar un dato que ademas termina siendo publico en la cadena.
    if (req.method === 'GET' && pathname.startsWith('/v1/receipts/')) {
      const id = decodeURIComponent(pathname.slice('/v1/receipts/'.length))
      const guardado = recibos.get(id)
      if (!guardado) {
        return sendError(res, 404, 'no hay recibo para ese id', { code: 'receipt_not_found' })
      }
      // El recibo de liquidacion se sigue devolviendo APLANADO en la raiz: es la
      // forma que ya leen los clientes y el test, y anidarlo ahora romperia a
      // quien busca `transaction` donde estaba. La atestacion de D24 entra al
      // lado, en su propia clave.
      return sendJson(res, 200, {
        id,
        ...guardado.recibo,
        // D24 — que sirvio este nodo, firmado por su wallet. `null` con motivo
        // cuando no la hay: el caso normal es que el que sirvio haya sido un
        // par, y ahi la atestacion la firma el (Fase 10), no nosotros.
        attestation: guardado.atestacion || null,
        attestationMissing: guardado.sinAtestacion || undefined
      })
    }
    if (req.method === 'GET' && pathname === '/v1/routing-log') {
      const motivoLog = rechazoPorKey(req)
      if (motivoLog) return sendError(res, 401, motivoLog)
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
      const nodo = budget.nodeUsage()
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
        remaining: costs.formatUSD(uso.remaining),
        // B13 — el tope del NODO va al lado del de la cuenta, porque el que
        // corta de verdad puede ser cualquiera de los dos. Mostrar solo el de
        // la cuenta hacia que un cliente con saldo de sobra viera "me quedan
        // USD 20" y recibiera un 402 igual, sin nada que lo explicara.
        node: {
          spent_micros: nodo.spent,
          reserved_micros: nodo.reserved,
          cap_micros: nodo.cap,
          remaining_micros: nodo.remaining,
          spent: costs.formatUSD(nodo.spent),
          cap: costs.formatUSD(nodo.cap),
          remaining: costs.formatUSD(nodo.remaining)
        }
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
