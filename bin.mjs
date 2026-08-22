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
  summary('Levantar el gateway del marketplace (demo, ver ROADMAP_FASE2-6.md)'),
  description(
    'Sirve los 3 paneles (cliente/proveedor/admin) y una API que imita la\n' +
      'forma del gateway real de Fase 3. El ruteo es contra un registro en\n' +
      'memoria: un nodo responde con inferencia real (engine.mjs), el resto\n' +
      'son mocks. No hay P2P todavia -eso es Fase 2/3 completas.'
  ),
  flag('--port <n>', 'puerto HTTP del gateway (default 8787)'),
  flag(
    '--gpu-layers <n>',
    'capas a mandar a la GPU del nodo real. 0 = todo CPU (8x mas rapido en la iGPU de la demo, ver NOTES.md)'
  ),
  () => {
    pending = runServe()
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

  const { createGateway, shutdownGateway } = await import('./qvac/gateway.mjs')
  const server = createGateway({ port, gpuLayers })

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
