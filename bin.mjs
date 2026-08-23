import { command, flag, arg, summary, description } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import pkg from './package.json'
import App from './app.js'
import { MODELS, MODEL_INFO, DEFAULT_MODEL, DEFAULT_CTX_SIZE } from './qvac/models.mjs'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')
const runtimeLabel = isDev ? 'bare (dev)' : 'pear (installed)'

// El trabajo de cada subcomando arranca desde el runner de paparam, que no es
// awaiteable desde afuera. Se guarda la promesa aca y se espera al final.
let pending = null

const promptCmd = command(
  'prompt',
  summary('Responder un prompt con inferencia 100% local'),
  description(
    'Carga un LLM con QVAC y responde sin salir de esta maquina.\n' +
      'Los pesos viajan por hypercore (P2P), no por HTTP, y quedan\n' +
      'cacheados en ~/.qvac/models para las corridas siguientes.'
  ),
  arg('<prompt>', 'el texto a responder, o "-" para leerlo de stdin'),
  flag(
    '--model <alias>',
    `modelo: ${Object.keys(MODELS).join(' | ')} o un nombre exacto del registry (default ${DEFAULT_MODEL})`
  ),
  flag('--ctx <n>', `tamano de contexto (default ${DEFAULT_CTX_SIZE})`),
  flag(
    '--gpu-layers <n>',
    'capas a mandar a la GPU. 0 = todo CPU. Sin el flag decide el SDK.' +
      ' En una iGPU floja (Intel UHD 620) 0 es 5x mas rapido: ver NOTES.md'
  ),
  flag('--no-download', 'fallar en vez de bajar los pesos si no estan en cache'),
  flag('--quiet|-q', 'imprimir solo la respuesta, sin diagnostico ni mediciones'),
  () => {
    pending = runPrompt()
  }
)

const serveCmd = command(
  'serve',
  summary('Levantar el gateway compatible con OpenAI y los paneles'),
  description(
    'Sirve los 3 paneles (cliente/proveedor/admin) y POST /v1/chat/completions\n' +
      'en formato OpenAI: { model, messages[], stream }.\n\n' +
      'Arranca con el registro VACIO: sin nodos anunciados devuelve un error\n' +
      'claro de "no hay nodos sirviendo ese modelo", que es el estado real\n' +
      'mientras el descubrimiento por swarm no este conectado (Fase 2-b).\n' +
      'Con --demo se puebla con nodos SIMULADOS para el video.'
  ),
  flag('--port <n>', 'puerto HTTP del gateway (default 8787)'),
  flag(
    '--demo',
    'poblar el registro con nodos simulados (1 real + 3 mocks) para la demo.' +
      ' Sin este flag el gateway arranca sin ningun nodo.'
  ),
  flag('--swarm', 'unirse al topic P2P y poblar el registro con pares verificados (Fase 2-b)'),
  flag(
    '--no-store',
    'no abrir el Hyperbee/Hyperdrive: el nodo corre sin persistencia ni archivos,' +
      ' como antes de Fase 5. Util para correr dos nodos sobre el mismo --storage.'
  ),
  flag('--operator <nombre>', 'nombre del operador que se anuncia en el manifiesto'),
  flag(
    '--gpu-layers <n>',
    'capas a mandar a la GPU del nodo real. 0 = todo CPU (8x mas rapido en la iGPU de la demo, ver NOTES.md)'
  ),
  () => {
    pending = runServe()
  }
)

// El comando que verifica el DoD de Fase 2 sin levantar el gateway: se une al
// topic, anuncia su manifiesto firmado y reporta que pares aparecieron y si su
// manifiesto verifico. Es lo que se corre en las DOS maquinas del runbook.
const peersCmd = command(
  'peers',
  summary('Unirse al topic P2P y listar los pares con manifiesto verificado'),
  description(
    'Anuncia el manifiesto firmado de este nodo en el topic fijo y muestra los\n' +
      'pares que se descubren, con el tiempo de join -> primer par y\n' +
      'join -> primer manifiesto verificado (D7 del ROADMAP).\n\n' +
      'Sale solo con --timeout, o con Ctrl+C.'
  ),
  flag('--operator <nombre>', 'nombre del operador que se anuncia en el manifiesto'),
  flag('--timeout <s>', 'salir despues de N segundos (default: no sale, Ctrl+C)'),
  flag('--expect <n>', 'exit code 1 si al salir no hay al menos N pares verificados'),
  () => {
    pending = runPeers()
  }
)

// ---------------------------------------------------------------------------
// Archivos entre maquinas (Hyperdrive). Ver qvac/files.mjs.
// ---------------------------------------------------------------------------

const sendCmd = command(
  'send',
  summary('Publicar un archivo o carpeta y compartirlo por P2P'),
  description(
    'Mete el archivo en el Hyperdrive de este nodo y lo anuncia en la DHT.\n' +
      'Imprime un link qvac:// que la otra maquina baja con `qvac-node fetch`.\n\n' +
      'El proceso QUEDA CORRIENDO a proposito: Hypercore no es store-and-forward,\n' +
      'no hay servidor donde el archivo quede guardado. Los bytes salen de esta\n' +
      'maquina, asi que tiene que estar prendida mientras la otra baja.\n\n' +
      'Solo se transfiere lo que se pide: un drive con 40 GB publicados no\n' +
      'obliga a nadie a bajar mas que el archivo que eligio.'
  ),
  arg('<ruta>', 'archivo o carpeta a publicar'),
  flag('--as <nombre>', 'nombre con el que se publica (default: el del archivo)'),
  () => {
    pending = runSend()
  }
)

const fetchCmd = command(
  'fetch',
  summary('Bajar un archivo publicado por otra maquina'),
  description(
    'Toma un link qvac://<clave>/<ruta> y baja ese archivo a disco.\n\n' +
      'Cada bloque se verifica contra el merkle root del drive al llegar: un\n' +
      'archivo alterado a mitad de camino no puede completarse. Lo que la clave\n' +
      'NO prueba es de quien es; eso depende del canal por el que llego el link.'
  ),
  arg('<link>', 'link qvac:// que imprimio `qvac-node send`'),
  flag('--out <dir>', 'carpeta destino (default: la actual)'),
  flag('--timeout <s>', 'cuanto esperar a que aparezca un par con el drive (default 60)'),
  () => {
    pending = runFetch()
  }
)

const filesCmd = command(
  'files',
  summary('Listar los archivos publicados por este nodo o por un par'),
  description(
    'Sin argumentos lista lo que publica esta maquina.\n' +
      'Con --link lista lo que publica el drive de otra, sin bajar el contenido:\n' +
      'la metadata de un Hyperdrive se replica aparte de los blobs.'
  ),
  flag('--link <qvac://…>', 'listar el drive de otra maquina en vez del propio'),
  flag('--timeout <s>', 'cuanto esperar al par remoto (default 30)'),
  () => {
    pending = runFiles()
  }
)

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--update-delay <ms>', 'ventana de jitter del OTA en ms (default 10000)'),
  promptCmd,
  serveCmd,
  peersCmd,
  sendCmd,
  fetchCmd,
  filesCmd,
  () => {
    pending = runNode()
  }
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))

if (pending) await pending

// ---------------------------------------------------------------------------
// qvac-node prompt "..."
// ---------------------------------------------------------------------------

async function runPrompt() {
  const quiet = promptCmd.flags.quiet === true
  const allowDownload = promptCmd.flags.download !== false
  const pick = promptCmd.flags.model || DEFAULT_MODEL
  const ctxSize = Number.isFinite(+promptCmd.flags.ctx) ? +promptCmd.flags.ctx : DEFAULT_CTX_SIZE
  const gpuLayers = promptCmd.flags.gpuLayers === undefined ? undefined : +promptCmd.flags.gpuLayers
  const say = quiet ? () => {} : (line = '') => console.log(line)

  // "-" lee el prompt de stdin. No es un lujo: en Windows el binario
  // standalone de bare-build recibe el argv en la codepage ANSI y le rompe
  // cualquier caracter no-ASCII —"Respondé" llega como "Respond�"—,
  // mientras que `bare.exe` con el mismo string lo pasa intacto. stdin es un
  // stream de bytes y no pasa por esa conversion. Repro y detalle en NOTES.md.
  const text = promptCmd.args.prompt === '-' ? await readStdin() : promptCmd.args.prompt

  if (!text || text.trim() === '') {
    console.error('[qvac] el prompt esta vacio.')
    Bare.exitCode = 1
    return
  }

  // Import DINAMICO: importar el motor hace dlopen del addon de llamacpp
  // (96 MB en win32-x64) en el acto. `qvac-node` a secas no tiene por que
  // pagar eso. bare-pack igual lo mete en el binario standalone: el traverse
  // sigue los `import()` con especificador literal.
  const engine = await import('./qvac/engine.mjs')

  let modelId = null
  const t0 = Date.now()

  try {
    const { entry, name, cached, modelSrc } = await engine.resolveModel(pick)
    const mb = (entry.expectedSize / 1e6).toFixed(0)

    say()
    say(`  QVAC-NODE v${pkg.version} - inferencia 100% local`)
    say()
    say(`  modelo   : ${name}  ${entry.params}  ${mb} MB`)
    say(`  pesos    : ${cached ? 'en cache' : 'faltan, se bajan por hypercore'}`)
    say(`  cache    : ${engine.modelsDir()}`)
    say(`  runtime  : ${runtimeLabel}`)
    say()

    // La descarga de pesos es un efecto explicito de PEDIR una inferencia,
    // nunca un efecto de arrancar el nodo. Esa invariante del runbook sigue en
    // pie: `qvac-node` a secas no baja un solo byte de modelo. `--no-download`
    // esta para forzar el modo estricto igual.
    if (!cached && !allowDownload) {
      throw new Error(
        `"${name}" no esta en cache y se paso --no-download. Son ${mb} MB. Corre el mismo comando sin --no-download.`
      )
    }

    let lastPct = -1
    if (!cached) say(`  bajando ${mb} MB por hypercore...`)

    modelId = await engine.loadModel({
      modelSrc,
      ctxSize,
      gpuLayers,
      onProgress: (p) => {
        // Solo cuando de verdad esta bajando: con el modelo en cache el SDK
        // igual emite progreso, y una barra que va de 0% a 0% confunde.
        if (quiet || cached) return
        const pct = Math.floor((p && (p.progress ?? p.percent ?? 0)) * 100)
        if (pct === lastPct) return
        lastPct = pct
        process.stdout.write(`\r  descarga ${pct}%   `)
        if (pct >= 100) process.stdout.write('\n')
      }
    })

    const tLoaded = Date.now()
    say(`  modelo listo en ${secs(tLoaded - t0)}`)
    say()
    say(`> ${text}`)
    say()

    let firstTokenAt = null
    for await (const delta of engine.complete({ modelId, prompt: text })) {
      if (firstTokenAt === null) firstTokenAt = Date.now()
      process.stdout.write(delta)
    }
    process.stdout.write('\n')

    const tEnd = Date.now()
    say()
    say(`  carga del modelo    : ${secs(tLoaded - t0)}`)
    say(`  primer token (TTFT) : ${firstTokenAt ? secs(firstTokenAt - tLoaded, 2) : 'n/d'}`)
    say(`  respuesta completa  : ${secs(tEnd - tLoaded)}`)
    say()
  } catch (err) {
    console.error('\n[qvac] fallo la inferencia:', (err && err.message) || err)
    Bare.exitCode = 1
  } finally {
    // Sin esto el proceso no termina: `unloadModel` deja arriba el swarm, el
    // cliente del registry y el corestore a proposito.
    await engine.shutdown(modelId)
  }
}

function secs(ms, digits = 1) {
  return (ms / 1000).toFixed(digits) + 's'
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

// ---------------------------------------------------------------------------
// qvac-node serve
// ---------------------------------------------------------------------------

async function runServe() {
  const port = Number.isFinite(+serveCmd.flags.port) ? +serveCmd.flags.port : 8787
  const gpuLayers = Number.isFinite(+serveCmd.flags.gpuLayers)
    ? +serveCmd.flags.gpuLayers
    : undefined

  const demo = serveCmd.flags.demo === true
  const useSwarm = serveCmd.flags.swarm === true

  const { createGateway, shutdownGateway } = await import('./qvac/gateway.mjs')
  const server = createGateway({ port, gpuLayers, demo })

  let nodeSwarm = null
  let provider = null
  let data = null
  if (useSwarm) {
    // El swarm escribe en el MISMO registro que lee el gateway: un manifiesto
    // verificado se vuelve una fila del marketplace, y los paneles la dibujan
    // sin saber que vino de un par. Esa es la costura de Fase 2-c.
    const store = await import('./qvac/store.mjs')
    const operator = serveCmd.flags.operator || `Nodo de ${os.hostname()}`

    // El Hyperbee y el Hyperdrive se abren ANTES del join: el manifiesto que
    // se firma al conectarse lleva la clave del directorio adentro, y firmarlo
    // sin ella significaria anunciar el mock de D2 durante toda la sesion.
    if (serveCmd.flags.store !== false) {
      data = await openData(swarmStorageDir())
      store.attachDirectory(data.directory)

      const hidratados = await store.hydrateFromDirectory()
      if (hidratados > 0) {
        console.log(`  [store] ${hidratados} par/es del directorio, offline hasta que se conecten`)
      }

      // La poda es del arranque y no de un timer: correrla mientras el nodo
      // sirve tokens seria meter escrituras al bee en el camino caliente.
      data.directory.pruneLog().catch(() => {})
    }

    nodeSwarm = await joinSwarm({ operator, store, data })

    // Este nodo tambien SIRVE: `serve --swarm` es el nodo completo (gateway +
    // proveedor). Se registra la fila local en el registro con o sin --demo,
    // porque no es un mock: es esta maquina, y sin ella `node:status`
    // anunciaria capacidad CERO mientras esta sirviendo.
    const { Provider } = await import('./qvac/provider.mjs')
    const models = swarmModels()
    for (const m of models) {
      store.registerLocal({
        modelId: m.modelId,
        displayName: m.displayName,
        operator,
        tags: ['general', 'chat'],
        pricing: '1000000 QVAC / per 1m completion tokens',
        maxConcurrentRequests: m.maxConcurrentRequests
      })
    }

    provider = new Provider({
      engineLoader: () => import('./qvac/engine.mjs'),
      store,
      models,
      maxConcurrent: 3
    })
    nodeSwarm.setProvider(provider)

    // El gateway necesita el swarm y los archivos para poder mandar chat:request
    // a un par y publicar los que se suben.
    const gw = await import('./qvac/gateway.mjs')
    gw.setSwarm(nodeSwarm)
    if (data && data.files) gw.setFiles(data.files)
  }

  let closing = false
  const shutdown = async (code) => {
    if (closing) return
    closing = true
    console.log('\n[gateway] cerrando...')

    // `server.close()` destruye las conexiones ociosas pero ESPERA a las que
    // estan en vuelo, y su callback nunca corre mientras haya un SSE abierto.
    // Con una inferencia real de 30s en curso, Ctrl+C no salia. El timeout
    // corta por lo sano: 3s para cerrar prolijo, despues se sale igual.
    const forced = setTimeout(() => {
      console.log('[gateway] habia requests en vuelo, saliendo igual.')
      Bare.exit(code)
    }, 3000)
    forced.unref?.()

    // El provider primero: corta los streams en vuelo antes de que el swarm
    // les cierre el socket abajo.
    if (provider) await provider.shutdown()
    if (nodeSwarm) await nodeSwarm.destroy()

    // El corestore va DESPUES del swarm: cerrarlo con sockets replicando
    // encima deja streams escribiendo contra cores ya cerrados. Si tarda, el
    // timeout de arriba corta igual.
    if (data) await data.close().catch(() => {})

    await shutdownGateway()
    server.close(() => {
      clearTimeout(forced)
      Bare.exit(code)
    })
  }

  process.on('SIGHUP', () => shutdown(129))
  process.on('SIGINT', () => shutdown(130))
  process.on('SIGQUIT', () => shutdown(131))
  process.on('SIGTERM', () => shutdown(143))

  console.log('Ctrl+C para salir.\n')
}

// ---------------------------------------------------------------------------
// Swarm (Fase 2-b): identidad + join al topic, compartido por `serve --swarm`
// y por `peers`.
// ---------------------------------------------------------------------------

// Lo que este nodo declara servir. Es su modelo real, no el catalogo del modo
// --demo: anunciar un mock seria mentirle a la red.
//
// UNA sola fuente: la usa el manifiesto que se firma Y el Provider que atiende
// los chat:request. Si divergieran, el nodo anunciaria un modelo que despues
// rechaza -- y el error se veria del lado del que confio en el manifiesto.
//
// maxConcurrentRequests 3: medido, no elegido. Tres completions concurrentes
// sobre el mismo modelo cargado corren en paralelo real y sin mezclarse entre
// si (probado con prompts distinguibles, ver NOTES.md).
function swarmModels() {
  return [
    {
      modelId: DEFAULT_MODEL,
      displayName: (MODEL_INFO[DEFAULT_MODEL] && MODEL_INFO[DEFAULT_MODEL].displayName) || DEFAULT_MODEL,
      maxConcurrentRequests: 3,
      pricing: [{ unit: 'per_1m_completion_tokens', amount: '1000000', currency: 'QVAC' }]
    }
  ]
}

function swarmStorageDir() {
  return cmd.flags.storage || path.join(isDev ? os.tmpdir() : persistent(), appName)
}

// Abre el Corestore y lo que cuelga de el: el Hyperbee del directorio y el
// Hyperdrive de archivos. Devuelve las tres cosas mas un `close()` que las
// cierra en orden.
//
// UN SOLO PROCESO POR DIRECTORIO DE STORAGE. El Corestore toma un lock de
// RocksDB sobre su carpeta: `qvac-node send` mientras corre `qvac-node serve`
// sobre el mismo `--storage` falla al abrir. Es una restriccion real y no un
// bug; para correr los dos a la vez, pasale `--storage` distinto al segundo.
async function openData(dir, { files = true } = {}) {
  const { openStore, closeStore } = await import('./qvac/corestore.mjs')
  const { Directory } = await import('./qvac/directory.mjs')

  const corestore = await openStore(dir)

  const directory = new Directory(corestore)
  await directory.ready()

  let filesApi = null
  if (files) {
    const { Files } = await import('./qvac/files.mjs')
    filesApi = new Files(corestore, { dir })
    await filesApi.ready()
  }

  return {
    corestore,
    directory,
    files: filesApi,
    async close() {
      if (filesApi) await filesApi.close()
      await directory.close()
      await closeStore()
    }
  }
}

async function joinSwarm({ operator, store = null, data = null }) {
  const { loadOrCreateIdentity } = await import('./qvac/identity.mjs')
  const { NodeSwarm, TOPIC_NAME } = await import('./qvac/swarm.mjs')

  const dir = swarmStorageDir()
  const identity = loadOrCreateIdentity(dir)

  const models = swarmModels()

  const nodeSwarm = new NodeSwarm({
    identity,
    models,
    operator: operator || `Nodo de ${os.hostname()}`,
    tags: ['general', 'chat'],
    store,
    corestore: data ? data.corestore : null,
    directory: data ? data.directory : null,
    files: data ? data.files : null
  })

  console.log('')
  console.log(`  [swarm] topic    : ${TOPIC_NAME}`)
  console.log(`  [swarm] identidad: ${identity.publicKey.toString('hex').slice(0, 16)}…`)
  console.log(`  [swarm] ${identity.created ? 'clave NUEVA generada' : 'clave existente reusada'}`)
  console.log(`  [swarm] anuncia  : ${models.map((m) => m.modelId).join(', ')}`)
  if (data) {
    console.log(
      `  [swarm] directorio: ${data.directory.keyHex.slice(0, 16)}… (v${data.directory.version})`
    )
    if (data.files) console.log(`  [swarm] archivos : ${data.files.keyHex.slice(0, 16)}…`)
  }
  console.log('')

  await nodeSwarm.join()
  nodeSwarm.startStatusBroadcast()

  // El drive se anuncia tambien en SU propio topic, no solo por
  // `files:announce` a los pares del marketplace. Asi un link `qvac://` que
  // alguien pegue en otra maquina se puede bajar sin que esa maquina tenga que
  // entrar al marketplace ni descubrir a este nodo por el topic comun.
  if (data && data.files) {
    data.files.swarm = nodeSwarm.swarm
    await data.files.serve()
  }

  console.log('  [swarm] anunciado en la DHT, esperando pares...')
  console.log('')

  return nodeSwarm
}

// ---------------------------------------------------------------------------
// qvac-node peers
// ---------------------------------------------------------------------------

async function runPeers() {
  const timeoutS = Number.isFinite(+peersCmd.flags.timeout) ? +peersCmd.flags.timeout : null
  const expect = Number.isFinite(+peersCmd.flags.expect) ? +peersCmd.flags.expect : null

  const nodeSwarm = await joinSwarm({ operator: peersCmd.flags.operator })

  // El resumen se imprime UNA vez al salir, por cualquiera de las dos vias
  // (timeout o Ctrl+C), para que el runbook tenga siempre la misma salida que
  // leer -- y para que el exit code no dependa de como se corto.
  let done = false
  const finish = async (code) => {
    if (done) return
    done = true

    const t = nodeSwarm.timings()
    const verificados = nodeSwarm.verifiedPeers()

    console.log('')
    console.log('  --- resumen ---')
    console.log(`  pares conectados AHORA: ${t.peers}`)
    console.log(`  con manifiesto OK     : ${t.verified}`)
    // El numero del DoD. Un par que se conecto, verifico y se fue cumplio el
    // DoD igual: si el otro nodo corta antes, "conectados ahora" da cero.
    console.log(`  verificados EN TOTAL  : ${t.verifiedEver}`)
    console.log(`  join -> primer par    : ${t.joinToFirstPeerMs ?? 'n/d'} ms`)
    console.log(`  join -> primer OK     : ${t.joinToFirstManifestMs ?? 'n/d'} ms`)
    for (const p of verificados) {
      const op = (p.manifest.metadata && p.manifest.metadata.operator) || '?'
      const modelos = p.manifest.models.map((m) => m.modelId).join(', ')
      const carga = p.status
        ? `${p.status.activeRequests}/${p.status.maxConcurrentRequests}`
        : 'n/d'
      console.log(`    · ${op} [${p.key.slice(0, 8)}…] modelos: ${modelos} carga: ${carga}`)
    }
    console.log('')

    // El gate del runbook. Sin esto un verificador puede dar OK sobre cero
    // pares -- exactamente el falso positivo que ya se cazo una vez en la
    // MacBook (ver NOTES.md).
    if (expect !== null && t.verifiedEver < expect) {
      console.error(
        `[peers] FALLO: se esperaban al menos ${expect} par(es) con manifiesto verificado, hubo ${t.verifiedEver}.`
      )
      code = 1
    } else if (expect !== null) {
      console.log(`  [peers] OK: ${t.verifiedEver} par(es) verificado(s), se esperaban ${expect}.`)
    }

    await nodeSwarm.destroy()
    Bare.exit(code)
  }

  if (timeoutS !== null) {
    console.log(`  [peers] saliendo en ${timeoutS}s...`)
    setTimeout(() => finish(0), timeoutS * 1000)
  } else {
    console.log('  Ctrl+C para salir.')
  }

  process.on('SIGHUP', () => finish(129))
  process.on('SIGINT', () => finish(0))
  process.on('SIGQUIT', () => finish(131))
  process.on('SIGTERM', () => finish(143))
}

// ---------------------------------------------------------------------------
// qvac-node send / fetch / files
// ---------------------------------------------------------------------------

// Sesion minima para los comandos de archivos: corestore + drive + un swarm
// propio. NO se une al topic del marketplace -- un `fetch` no tiene por que
// anunciarse como nodo de inferencia ni descubrir proveedores. Se une nada mas
// que al topic del drive que le interesa.
async function filesSession() {
  const Hyperswarm = (await import('hyperswarm')).default
  const { loadOrCreateIdentity } = await import('./qvac/identity.mjs')

  const dir = swarmStorageDir()
  const identity = loadOrCreateIdentity(dir)
  const data = await openData(dir)

  const swarm = new Hyperswarm({ keyPair: identity })
  // Cada conexion replica el corestore entero. Es la unica cosa que estos
  // comandos hacen sobre la red.
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    data.corestore.replicate(socket)
  })

  data.files.swarm = swarm

  return {
    ...data,
    swarm,
    async close() {
      await swarm.destroy()
      await data.close()
    }
  }
}

function mb(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1e6) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1e6).toFixed(1)} MB`
}

async function runSend() {
  const fs = await import('bare-fs')
  const ruta = sendCmd.args.ruta

  let stat
  try {
    stat = fs.default.statSync(ruta)
  } catch {
    console.error(`[files] no existe: ${ruta}`)
    Bare.exitCode = 1
    return
  }

  const sesion = await filesSession()

  try {
    const esDir = stat.isDirectory()
    const res = esDir
      ? await sesion.files.shareDir(ruta, sendCmd.flags.as)
      : await sesion.files.share(ruta, sendCmd.flags.as)

    // El drive se anuncia en su propio topic. `flushed()` espera a que este
    // publicado en la DHT: sin eso, imprimir el link y que el otro lo pegue al
    // segundo siguiente es una carrera que pierde el que baja.
    await sesion.files.serve()

    console.log('')
    console.log(`  QVAC-NODE v${pkg.version} — compartiendo por P2P`)
    console.log('')
    if (esDir) {
      console.log(`  carpeta  : ${res.base}  (${res.files.length} archivo/s)`)
      const total = res.files.reduce((n, f) => n + f.bytes, 0)
      console.log(`  tamaño   : ${mb(total)}`)
    } else {
      console.log(`  archivo  : ${res.path}`)
      console.log(`  tamaño   : ${mb(res.bytes)}`)
    }
    console.log(`  drive    : ${sesion.files.keyHex}`)
    console.log('')
    console.log('  En la otra maquina:')
    console.log('')
    console.log(`    qvac-node fetch ${res.link}`)
    console.log('')
    console.log('  Este proceso tiene que quedar CORRIENDO mientras el otro baja:')
    console.log('  los bytes salen de aca, no de un servidor. Ctrl+C para cortar.')
    console.log('')
  } catch (err) {
    console.error(`[files] no se pudo publicar: ${(err && err.message) || err}`)
    await sesion.close()
    Bare.exitCode = 1
    return
  }

  const finish = async (code) => {
    console.log('\n[files] cerrando...')
    await sesion.close()
    Bare.exit(code)
  }

  process.on('SIGHUP', () => finish(129))
  process.on('SIGINT', () => finish(0))
  process.on('SIGQUIT', () => finish(131))
  process.on('SIGTERM', () => finish(143))
}

async function runFetch() {
  const pathMod = await import('bare-path')
  const { parseLink } = await import('./qvac/files.mjs')

  let link
  try {
    link = parseLink(fetchCmd.args.link)
  } catch (err) {
    console.error(`[files] ${err.message}`)
    Bare.exitCode = 1
    return
  }

  const timeoutMs = (Number.isFinite(+fetchCmd.flags.timeout) ? +fetchCmd.flags.timeout : 60) * 1000
  const outDir = fetchCmd.flags.out || '.'
  const sesion = await filesSession()

  console.log('')
  console.log(`  drive    : ${link.keyHex.slice(0, 16)}…`)
  console.log(`  ruta     : ${link.path}`)
  console.log('  buscando un par que lo tenga...')

  let code = 0
  const t0 = Date.now()

  try {
    // Una ruta que termina en '/' es una carpeta. Es la unica pista que hay:
    // preguntarle al drive obliga a esperar la metadata, y si no aparece nadie
    // no se puede distinguir "es carpeta" de "no hay par".
    if (link.path.endsWith('/')) {
      const escritos = await sesion.files.pullDir(link.keyHex, link.path, outDir, {
        timeoutMs,
        onFile: ({ dest }) => console.log(`  ✓ ${dest}`)
      })
      console.log('')
      console.log(`  ${escritos.length} archivo/s en ${secs(Date.now() - t0)}`)
    } else {
      const nombre = link.path.split('/').filter(Boolean).pop()
      const dest = pathMod.default.join(outDir, nombre)

      let ultimo = -1
      const res = await sesion.files.pull(link.keyHex, link.path, dest, {
        timeoutMs,
        onProgress: ({ progress, bytes, total }) => {
          const pct = Math.floor(progress * 100)
          if (pct === ultimo) return
          ultimo = pct
          process.stdout.write(`\r  bajando ${pct}%  ${mb(bytes)} / ${mb(total)}   `)
        }
      })
      process.stdout.write('\n')
      console.log('')
      console.log(`  ✓ ${res.path}  (${mb(res.bytes)} en ${secs(Date.now() - t0)})`)
    }
    console.log('')
  } catch (err) {
    console.error(`\n[files] no se pudo bajar: ${(err && err.message) || err}`)
    code = 1
  }

  await sesion.close()
  Bare.exit(code)
}

async function runFiles() {
  const { parseLink } = await import('./qvac/files.mjs')
  const timeoutMs = (Number.isFinite(+filesCmd.flags.timeout) ? +filesCmd.flags.timeout : 30) * 1000

  const sesion = await filesSession()
  let code = 0

  try {
    if (filesCmd.flags.link) {
      const link = parseLink(filesCmd.flags.link)
      console.log(`\n  drive remoto ${link.keyHex.slice(0, 16)}…\n`)
      const entradas = await sesion.files.listRemote(link.keyHex, link.path, { timeoutMs })
      if (entradas.length === 0) console.log('  (vacio)')
      for (const e of entradas) console.log(`  ${e.path.padEnd(40)} ${mb(e.bytes)}`)
    } else {
      console.log(`\n  drive local ${sesion.files.keyHex}\n`)
      const entradas = await sesion.files.list()
      if (entradas.length === 0) {
        console.log('  (todavia no publicaste nada)')
        console.log('')
        console.log(`  Proba:  ${appName} send ./archivo.pdf`)
      }
      for (const e of entradas) console.log(`  ${e.path.padEnd(40)} ${mb(e.bytes)}`)
    }
    console.log('')
  } catch (err) {
    console.error(`[files] ${(err && err.message) || err}`)
    code = 1
  }

  await sesion.close()
  Bare.exit(code)
}

// ---------------------------------------------------------------------------
// qvac-node  (nodo: banner + OTA)
// ---------------------------------------------------------------------------

async function runNode() {
  if (cmd.flags.version) {
    console.log(`${appName} v${pkg.version}`)
    return
  }

  const updates = cmd.flags.updates

  // Ventana de jitter del updater. El default de pear-runtime-updater es UNA
  // HORA (`_defaultDelay = 3_600_000`), y solo se ignora si la version nueva
  // aparece dentro de los primeros 60s de vida del proceso
  // (`_bootGracePeriod`). Pasado ese minuto, el update se agenda en un punto
  // aleatorio de la ventana.
  //
  // Ese default es correcto para una flota grande -evita que miles de nodos se
  // actualicen a la vez- y es inservible aca: el OTA en vivo es el pitch, y con
  // una hora de jitter la demo simplemente no muestra nada. 10s da un update
  // visible sin volverlo sincronizado entre todos los nodos.
  const updateDelay = Number.isFinite(+cmd.flags.updateDelay) ? +cmd.flags.updateDelay : 10000
  const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName))
  const dir = storage || path.join(os.tmpdir(), 'pear', appName)

  // Banner. El numero de version se imprime a proposito en grande: es lo que
  // cambia en vivo cuando se demuestra el OTA, y tiene que verse en el proyector.
  console.log('')
  console.log('  QVAC-NODE  v' + pkg.version)
  console.log('  ' + pkg.description)
  console.log('')
  console.log(`  runtime  : ${runtimeLabel}`)
  console.log(
    `  updates  : ${updates === false ? 'disabled (--no-updates)' : `enabled (jitter ${updateDelay}ms)`}`
  )
  console.log(`  storage  : ${dir}`)
  console.log('')

  const app = new App({
    dir,
    app: isDev ? null : os.execPath(),
    updates,
    updateDelay,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name: isWindows ? appName + '.exe' : appName
  })

  app.on('message', (message) => console.log(message))
  app.on('updating', () => console.log('[updater] bajando nueva version'))
  app.on('updated', () => console.log('[updater] descarga completa... aplicando'))
  app.on('update-applied', () =>
    console.log('[updater] update aplicado, reinicia para correr la ultima version')
  )

  // Progreso de la descarga OTA. Se imprime en una sola linea reescrita, en vez
  // de una por evento: el updater emite seguido y a 55MB inunda la terminal.
  // Esta linea es lo que el jurado mira durante la demo del OTA.
  app.on('updating-progress', (s) => {
    const mb = (s.bytes / 1e6).toFixed(1)
    const pct = Math.round((s.progress || 0) * 100)
    const speed = (s.speed / 1e6).toFixed(1)
    process.stdout.write(`\r[updater] ${pct}%  ${mb} MB  ${speed} MB/s  ${s.peers} peer(s)   `)
    if (pct >= 100) process.stdout.write('\n')
  })

  // Un updater caido NO tumba el nodo: si esta sirviendo tokens, sigue
  // sirviendolos. Se avisa y se sigue.
  app.on('updater-error', (err) => {
    console.error('\n[updater] fallo la actualizacion:', err.message)
    console.error('[updater] el nodo sigue corriendo en la version actual.')
  })

  app.on('error', (err) => console.error('[app:error]', err))

  process.on('SIGHUP', () => app.exit(129))
  process.on('SIGINT', () => app.exit(130))
  process.on('SIGQUIT', () => app.exit(131))
  process.on('SIGTERM', () => app.exit(143))

  try {
    await app.ready()
    console.log(`CLI listo. Proba:  ${appName} prompt "hola"`)
    console.log('Ctrl+C para salir.\n')
  } catch (err) {
    console.error('[app:error]', err)
    await app.close().finally(() => Bare.exit(1))
  }
}
