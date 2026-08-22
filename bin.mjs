import { command, flag, arg, summary, description } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import pkg from './package.json'
import App from './app.js'
import { MODELS, DEFAULT_MODEL, DEFAULT_CTX_SIZE } from './qvac/models.mjs'

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
  if (useSwarm) {
    // El swarm escribe en el MISMO registro que lee el gateway: un manifiesto
    // verificado se vuelve una fila del marketplace, y los paneles la dibujan
    // sin saber que vino de un par. Esa es la costura de Fase 2-c.
    const store = await import('./qvac/store.mjs')
    const operator = serveCmd.flags.operator || `Nodo de ${os.hostname()}`

    nodeSwarm = await joinSwarm({ operator, store })

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

    // El gateway necesita el swarm para poder mandar chat:request a un par.
    const gw = await import('./qvac/gateway.mjs')
    gw.setSwarm(nodeSwarm)
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
      // El nombre exacto del registry, no una etiqueta linda: es el archivo de
      // pesos que este nodo realmente corre, y en un marketplace lo que se
      // anuncia tiene que ser lo que se sirve.
      displayName: MODELS[DEFAULT_MODEL] || DEFAULT_MODEL,
      maxConcurrentRequests: 3,
      pricing: [{ unit: 'per_1m_completion_tokens', amount: '1000000', currency: 'QVAC' }]
    }
  ]
}

function swarmStorageDir() {
  return cmd.flags.storage || path.join(isDev ? os.tmpdir() : persistent(), appName)
}

async function joinSwarm({ operator, store = null }) {
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
    store
  })

  console.log('')
  console.log(`  [swarm] topic    : ${TOPIC_NAME}`)
  console.log(`  [swarm] identidad: ${identity.publicKey.toString('hex').slice(0, 16)}…`)
  console.log(`  [swarm] ${identity.created ? 'clave NUEVA generada' : 'clave existente reusada'}`)
  console.log(`  [swarm] anuncia  : ${models.map((m) => m.modelId).join(', ')}`)
  console.log('')

  await nodeSwarm.join()
  nodeSwarm.startStatusBroadcast()
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
