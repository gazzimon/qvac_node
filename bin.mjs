import { command, flag, arg, summary, description } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import env from 'bare-env'
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
  summary('Answer a prompt with 100% local inference'),
  description(
    'Loads an LLM with QVAC and answers without leaving this machine.\n' +
      'The weights travel over hypercore (P2P), not over HTTP, and stay\n' +
      'cached in ~/.qvac/models for the following runs.'
  ),
  arg('<prompt>', 'the text to answer, or "-" to read it from stdin'),
  flag(
    '--model <alias>',
    `model: ${Object.keys(MODELS).join(' | ')} or an exact registry name (default ${DEFAULT_MODEL})`
  ),
  flag('--ctx <n>', `context size (default ${DEFAULT_CTX_SIZE})`),
  flag(
    '--gpu-layers <n>',
    'layers to send to the GPU. 0 = all CPU. Without the flag the SDK decides.' +
      ' On a weak iGPU (Intel UHD 620) 0 is 5x faster: see NOTES.md'
  ),
  flag('--no-download', 'fail instead of downloading the weights when they are not cached'),
  flag('--quiet|-q', 'print only the answer, with no diagnostics or measurements'),
  () => {
    pending = runPrompt()
  }
)

const serveCmd = command(
  'serve',
  summary('Start the OpenAI-compatible gateway and the panels'),
  description(
    'Serves the 3 panels (client/provider/admin) and POST /v1/chat/completions\n' +
      'in OpenAI format: { model, messages[], stream }.\n\n' +
      'It starts with an EMPTY registry: with no announced nodes it returns a\n' +
      'clear "no nodes serving that model" error, which is the real state\n' +
      'while swarm discovery is not connected (Phase 2-b).\n' +
      'With --demo it is populated with SIMULATED nodes for the video.'
  ),
  flag('--port <n>', 'gateway HTTP port (default 8787)'),
  flag(
    '--demo',
    'populate the registry with simulated nodes (1 real + 3 mocks) for the demo.' +
      ' Without this flag the gateway starts with no nodes at all.'
  ),
  flag('--swarm', 'join the P2P topic and populate the registry with verified peers (Phase 2-b)'),
  flag(
    '--no-store',
    'do not open the Hyperbee/Hyperdrive: the node runs with no persistence and no files,' +
      ' as before Phase 5. Useful to run two nodes over the same --storage.'
  ),
  flag('--operator <name>', 'operator name announced in the manifest'),
  flag(
    '--gpu-layers <n>',
    'layers to send to the real node GPU. 0 = all CPU (8x faster on the demo iGPU, see NOTES.md)'
  ),
  () => {
    pending = runServe()
  }
)

// The command that verifies the Phase 2 DoD without starting the gateway: it
// joins the topic, announces its signed manifest and reports which peers showed
// up and whether their manifest verified. This is what runs on BOTH machines in
// the runbook.
const peersCmd = command(
  'peers',
  summary('Join the P2P topic and list the peers with a verified manifest'),
  description(
    'Announces this node signed manifest on the fixed topic and shows the peers\n' +
      'that get discovered, with the join -> first peer and\n' +
      'join -> first verified manifest timings (D7 of the ROADMAP).\n\n' +
      'It only exits with --timeout, or with Ctrl+C.'
  ),
  flag('--operator <name>', 'operator name announced in the manifest'),
  flag('--timeout <s>', 'exit after N seconds (default: never exits, Ctrl+C)'),
  flag('--expect <n>', 'exit code 1 if fewer than N verified peers are present on exit'),
  () => {
    pending = runPeers()
  }
)

// ---------------------------------------------------------------------------
// Files between machines (Hyperdrive). See qvac/files.mjs.
// ---------------------------------------------------------------------------

const sendCmd = command(
  'send',
  summary('Publish a file or folder and share it over P2P'),
  description(
    'Puts the file into this node Hyperdrive and announces it on the DHT.\n' +
      'Prints a qvac:// link the other machine downloads with `pyrusllm fetch`.\n\n' +
      'The process STAYS RUNNING on purpose: Hypercore is not store-and-forward,\n' +
      'there is no server where the file is kept. The bytes come out of this\n' +
      'machine, so it has to stay on while the other one downloads.\n\n' +
      'Only what is asked for is transferred: a drive with 40 GB published does\n' +
      'not force anyone to download more than the file they picked.'
  ),
  arg('<path>', 'file or folder to publish'),
  flag('--as <name>', 'name it is published under (default: the file name)'),
  () => {
    pending = runSend()
  }
)

const fetchCmd = command(
  'fetch',
  summary('Download a file published by another machine'),
  description(
    'Takes a qvac://<key>/<path> link and downloads that file to disk.\n\n' +
      'Every block is verified against the drive merkle root as it arrives: a\n' +
      'file tampered with midway cannot complete. What the key does NOT prove\n' +
      'is whose it is; that depends on the channel the link arrived through.'
  ),
  arg('<link>', 'qvac:// link printed by `pyrusllm send`'),
  flag('--out <dir>', 'destination folder (default: the current one)'),
  flag('--timeout <s>', 'how long to wait for a peer with the drive to appear (default 60)'),
  () => {
    pending = runFetch()
  }
)

const filesCmd = command(
  'files',
  summary('List the files published by this node or by a peer'),
  description(
    'With no arguments it lists what this machine publishes.\n' +
      'With --link it lists what another machine drive publishes, without\n' +
      'downloading the content: Hyperdrive metadata replicates separately from\n' +
      'the blobs.'
  ),
  flag('--link <qvac://…>', 'list another machine drive instead of our own'),
  flag('--timeout <s>', 'how long to wait for the remote peer (default 30)'),
  () => {
    pending = runFiles()
  }
)

const walletCmd = command(
  'wallet',
  summary('Show, create or restore this node payout wallet'),
  description(
    'With no flags it shows the payout address, or says there is no wallet yet.\n' +
      '\n' +
      'The seed is stored ENCRYPTED with the PYRUS_WALLET_PASSPHRASE passphrase\n' +
      '(it can go in the .env). Honest limit: if that .env lives next to the\n' +
      'keystore, the encryption protects against a backup or a repo, not against\n' +
      'somebody who already has access to this machine.\n' +
      '\n' +
      '--create shows the 24 words ONCE. Write them down: without them and\n' +
      'without the keystore, the wallet is lost. --restore <phrase> uses them\n' +
      'again.'
  ),
  flag('--create', 'generate a new wallet for this node'),
  flag('--restore <phrase>', 'restore from the 24 words of a backup'),
  () => {
    pending = runWallet()
  }
)

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--port <n>', 'app HTTP port (default 8787)'),
  flag('--no-serve', 'only the OTA updater, without starting the app'),
  flag('--no-open', 'do not open the browser on start'),
  flag('--update-delay <ms>', 'OTA jitter window in ms (default 10000)'),
  promptCmd,
  serveCmd,
  peersCmd,
  sendCmd,
  fetchCmd,
  filesCmd,
  walletCmd,
  () => {
    pending = runNode()
  }
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))

if (pending) await pending

// ---------------------------------------------------------------------------
// pyrusllm prompt "..."
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
    console.error('[pyrusllm] the prompt is empty.')
    Bare.exitCode = 1
    return
  }

  // Import DINAMICO: importar el motor hace dlopen del addon de llamacpp
  // (96 MB en win32-x64) en el acto. `pyrusllm` a secas no tiene por que
  // pagar eso. bare-pack igual lo mete en el binario standalone: el traverse
  // sigue los `import()` con especificador literal.
  const engine = await import('./qvac/engine.mjs')

  let modelId = null
  const t0 = Date.now()

  try {
    const { entry, name, cached, modelSrc } = await engine.resolveModel(pick)
    const mb = (entry.expectedSize / 1e6).toFixed(0)

    say()
    say(`  PyrusLLM v${pkg.version} - 100% local inference`)
    say()
    say(`  modelo   : ${name}  ${entry.params}  ${mb} MB`)
    say(`  pesos    : ${cached ? 'en cache' : 'faltan, se bajan por hypercore'}`)
    say(`  cache    : ${engine.modelsDir()}`)
    say(`  runtime  : ${runtimeLabel}`)
    say()

    // La descarga de pesos es un efecto explicito de PEDIR una inferencia,
    // nunca un efecto de arrancar el nodo. Esa invariante del runbook sigue en
    // pie: `pyrusllm` a secas no baja un solo byte de modelo. `--no-download`
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
    console.error('\n[pyrusllm] inference failed:', (err && err.message) || err)
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
// pyrusllm serve
// ---------------------------------------------------------------------------

// Carga el `.env` del directorio de trabajo y el del storage, en ese orden.
// El primero que defina una variable gana, y una variable YA presente en el
// entorno le gana a los dos: ver la nota de qvac/dotenv.mjs.
//
// Se dice que se cargo, con los NOMBRES y nunca los valores. Sin ese aviso,
// "el .env no se leyo" y "el .env se leyo pero la variable se llama distinto"
// se ven exactamente igual desde afuera -- que es como se perdio una tarde.
async function cargarEnv() {
  const dotenv = await import('./qvac/dotenv.mjs')
  const vistos = []
  for (const dir of [process.cwd(), swarmStorageDir()]) {
    const { cargadas } = await dotenv.cargar(dir)
    for (const nombre of cargadas) if (!vistos.includes(nombre)) vistos.push(nombre)
  }
  if (vistos.length) console.log(`  [env] .env: ${vistos.join(', ')}`)
}

// Lee `<storage>/upstreams.json` y convierte cada modelo externo en una fila
// del registro. Es TODO el cableado de la Fase 8.5 del lado del arranque: a
// partir de aca /v1/models lo lista, el chat lo ofrece y el ruteo lo puntua.
//
// Un upstream se registra OFFLINE si le falta la credencial o el precio. Las
// dos ausencias son distintas y ninguna puede pasar en silencio:
//
//   - sin credencial no puede contestar, y el error saldria recien en el
//     primer prompt, con el usuario mirando;
//   - sin precio `costs.estimar` devuelve CERO, la reserva no aparta nada y el
//     tope de gasto deja de cortar justo en el unico camino que cuesta
//     dolares. Un externo gratis-a-los-ojos-del-contador es peor que un
//     externo apagado.
//
// Offline y no ausente porque el panel tiene que mostrarlo con lo que le
// falta: "configuraste mal" y "no configuraste nada" no pueden verse igual.
async function registrarUpstreams({ gw, store, dir }) {
  const upstream = await import('./qvac/upstream.mjs')
  const costs = await import('./qvac/costs.mjs')

  const cfg = await upstream.leerConfig(dir)
  if (cfg.error) {
    console.error(`  [upstream] ${cfg.error}`)
    console.error('  [upstream] se sigue sin asistente externo')
    return
  }

  // Se relee entero: las filas y los precios de una corrida anterior se borran
  // antes de escribir los nuevos, o un modelo sacado del archivo seguiria
  // anunciado.
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams(cfg.upstreams)
  gw.setUpstreamOptIn(cfg.optIn)

  if (cfg.upstreams.length === 0) return

  for (const u of cfg.upstreams) {
    // El precio se registra contra el ID DE LA FILA del registro y no contra
    // el modelId: si dos nodos sirven el mismo modelo -- un par gratis y esta
    // API cobrando-- indexar por nombre de modelo le cobraria al par la tarifa
    // del tercero. Ver claveDePrecio() en gateway.mjs.
    const filaId = `upstream:${u.id}`
    const conPrecio = u.precio ? costs.registrarPrecio(filaId, u.precio) : false

    // Que le falta a este upstream para poder contestar. Las dos exigencias
    // valen para un proveedor REMOTO y ninguna para uno local:
    //
    //   - credencial: un endpoint en localhost no lleva ninguna;
    //   - precio: un endpoint propio no cuesta dolares, asi que cero no es un
    //     agujero en el contador -- es la verdad. Exigirselo dejaria apagado
    //     al unico upstream que nunca puede pasarse de un tope.
    const falta = []
    if (!u.disponible()) falta.push(`falta la variable de entorno ${u.apiKeyEnv}`)
    if (!conPrecio && !u.esLocal) falta.push('falta "pricePerMTok" en la config')

    store.registerUpstream({
      id: u.id,
      // El nombre con el que entra al marketplace, que puede no ser el que usa
      // el proveedor: dos puertas al mismo modelo tienen que caer en la misma
      // fila del catalogo para poder competir entre si.
      modelId: u.anunciadoComo,
      displayName: u.displayName,
      // El operador que se muestra en el panel y viaja en los headers de
      // procedencia. Dice el proveedor Y de que lado esta: la promesa de
      // privacidad se acota en el nombre mismo de quien contesto.
      operator: u.esLocal ? `${u.label} (local)` : `${u.label} (externo)`,
      pricing: conPrecio
        ? `${costs.formatUSD(u.precio.salida)} / per 1m completion tokens`
        : u.esLocal
          ? 'sin costo: corre en esta maquina'
          : 'sin precio declarado',
      tags: u.tags,
      maxConcurrentRequests: u.maxConcurrent,
      status: falta.length ? 'offline' : 'online',
      local: u.esLocal
    })

    const comoSeLlama =
      u.anunciadoComo === u.model
        ? u.model
        : `${u.anunciadoComo} (el proveedor lo llama ${u.model})`

    if (falta.length) {
      console.log(`  [upstream] ${u.displayName} (${u.label}) DESACTIVADO: ${falta.join('; ')}`)
    } else if (u.esLocal) {
      console.log(
        `  [upstream] ${u.displayName} (${u.label}) listo en ${u.baseUrl} — local, sin costo — ${comoSeLlama}`
      )
    } else {
      console.log(
        `  [upstream] ${u.displayName} (${u.label}) listo — hasta ${u.maxTokens} tokens de salida, ` +
          `${costs.formatUSD(u.precio.salida)}/1M — ${comoSeLlama}`
      )
    }
  }

  // El opt-in habla de TERCEROS. Un nodo cuyos upstreams son todos locales no
  // tiene por que leer un aviso sobre prompts que salen de la maquina, porque
  // ninguno sale: decirselo igual entrena a ignorar el aviso el dia que sea
  // cierto.
  if (cfg.upstreams.some((u) => !u.esLocal)) {
    console.log(
      cfg.optIn
        ? '  [upstream] opt-in PRENDIDO: con la red sin capacidad, el prompt puede salir a un tercero'
        : '  [upstream] opt-in apagado: ningun prompt sale a un tercero (se prende en /node)'
    )
  }
}

// Levanta el gateway y los paneles. La usan DOS caminos: `pyrusllm serve` con
// sus flags, y `pyrusllm` a secas -- que ademas corre el updater OTA. Recibe
// opciones en vez de leer serveCmd.flags porque en el segundo camino ese
// subcomando nunca se parseo y todos sus flags son undefined.
async function startGateway(opts = {}) {
  const port = Number.isFinite(+opts.port) ? +opts.port : 8787
  const gpuLayers = Number.isFinite(+opts.gpuLayers) ? +opts.gpuLayers : undefined

  const demo = opts.demo === true
  const useSwarm = opts.swarm === true
  const withStore = opts.store !== false

  // El `.env` va PRIMERO de todo: las credenciales de los upstreams se leen
  // del entorno, y cargarlo despues de registrarlos dejaria los upstreams
  // apagados por una variable que estaba ahi todo el tiempo.
  //
  // Se busca en el directorio de trabajo y no en el de storage: un `.env` es
  // del proyecto que se esta corriendo, y el que lo escribe lo pone al lado de
  // donde ejecuta. Tambien en el storage, para el binario instalado, que no
  // tiene un "al lado" obvio.
  await cargarEnv()

  // FASE 6.5 — el ledger de consumo se abre ANTES del gateway. Si se abriera
  // despues, los primeros requests correrian sin contador: pocos, pero
  // justamente los del arranque, que es cuando un loop recien lanzado gasta
  // mas rapido. Un tope con una ventana ciega no es un tope.
  const budget = await import('./qvac/budget.mjs')
  const budgetDir = swarmStorageDir()
  try {
    const fs = await import('bare-fs')
    fs.default.mkdirSync(budgetDir, { recursive: true })
  } catch {
    // Si no se puede crear, budget.open avisa y sigue en memoria.
  }
  budget.open(budgetDir)

  // Y el registro de API keys ANTES que el gateway, por la misma razon y por
  // una mas: la cuenta a la que el ledger le imputa el gasto ES la key, asi que
  // un registro que no sobrevive al proceso es un tope que se resetea
  // reiniciando. Van juntos o el de arriba no garantiza nada.
  const apikeys = await import('./qvac/apikeys.mjs')
  const cargadas = apikeys.open(budgetDir)
  if (cargadas > 0) console.log(`  [apikeys] ${cargadas} key(s) del registro guardado`)

  const { createGateway, shutdownGateway } = await import('./qvac/gateway.mjs')
  const server = createGateway({ port, gpuLayers, demo })

  const gw = await import('./qvac/gateway.mjs')
  const store = await import('./qvac/store.mjs')
  const operator = opts.operator || `Node on ${os.hostname()}`

  // FASE 9 — la wallet se abre en el ARRANQUE, no al unirse al swarm.
  //
  // Estaba adentro de `launchAgent`, y eso tenia dos consecuencias que no se
  // veian: un nodo con wallet corriendo `serve` SIN `--swarm` nunca podia
  // cobrar -- el gateway no se enteraba de que existia --, y con `--swarm` los
  // requests que llegaban durante los segundos que tarda el join recibian 401
  // en vez de 402. Las dos salieron probando el curl del DoD contra el nodo de
  // verdad, no en los tests.
  //
  // La wallet no depende del swarm: es de esta maquina. `joinSwarm` la vuelve a
  // leer para el manifiesto, que es otra cosa -- ahi va FIRMADA.
  // D30.1 — el keystore NO sale de `budgetDir`: ese puede estar en temp.
  const dirWallet = await walletStorageDir()
  const cobro = await economicDelNodo(dirWallet)
  gw.setEconomic(cobro.economic)
  // D24 — sin firmante no hay atestacion, y eso es lo correcto: se prefiere no
  // emitirla a emitirla sin firma. El gateway lo dice en el recibo.
  gw.setWalletSigner(cobro.firmar)
  // FASE 11 — el panel /wallet lee saldos con la direccion PUBLICA y el RPC de
  // esta red; la seed no cruza. Sin red el panel muestra solo el aviso.
  gw.setWalletRed(cobro.red)

  // FASE 11 — crear o importar la wallet de cobro desde el panel /wallet, sin
  // `pyrusllm wallet --create` and without touching the environment. El closure es el dueño de
  // dir + passphrase: el gateway lo invoca y re-cablea economic/firmante/red,
  // pero NO ve la seed — se genera acá, se escribe cifrada, y la frase vuelve
  // una sola vez para que el panel la muestre y el operador la anote.
  //
  // La passphrase la resuelve `wallet.resolverPassphrase`: usa
  // PYRUS_WALLET_PASSPHRASE si está, y si no, genera una y la persiste 0600 en
  // `wallet.pass` para que `abrir()` la encuentre en el próximo arranque. El
  // límite honesto de tener esa clave en disco lo explica el encabezado de
  // wallet.mjs — es el mismo que ya tenía el `.env` al lado del keystore.
  const walletMod = await import('./qvac/wallet.mjs')
  gw.setWalletCreator(async ({ frase = null } = {}) => {
    const { passphrase } = walletMod.resolverPassphrase(dirWallet, { env, generar: true })
    const r = await walletMod.crear(dirWallet, passphrase, {
      red: walletMod.redDe(env, { dir: dirWallet }),
      frase
    })
    // Re-abrir y re-cablear: el gateway sirve la nueva dirección sin reiniciar.
    // El re-anuncio del manifiesto a los pares lo dispara el propio endpoint
    // del gateway (updateAnnouncement).
    const nuevo = await economicDelNodo(dirWallet)
    gw.setEconomic(nuevo.economic)
    gw.setWalletSigner(nuevo.firmar)
    gw.setWalletRed(nuevo.red)
    // FASE 12 — y el que manda plata, por lo mismo: una wallet recien creada
    // desde el panel tiene que poder enviar sin reiniciar el nodo.
    gw.setWalletSender(nuevo.enviar ? { enviar: nuevo.enviar, cotizar: nuevo.cotizar } : null)
    return { address: r.address, frase: r.frase, restaurada: r.restaurada }
  })

  // FASE 11 — cambiar de red desde el selector del panel. Escribe `wallet.red`
  // (lo lee `redDe` en el próximo arranque) y NO hace hot-swap: el aviso de
  // mainnet, la re-derivación y el re-firmado del manifiesto viven en el
  // arranque, así que el panel dice "reiniciá el nodo".
  //
  // Ir A mainnet exige `confirmar: 'MAINNET'` — D30: mainnet no se toca sin que
  // alguien lo escriba. La validación de nombre y la de mainnet viven acá para
  // que el gateway no tenga que importar `wallet.mjs`.
  gw.setWalletNetworkSetter((nombre, { confirmar } = {}) => {
    const objetivo = walletMod.REDES[String(nombre || '').trim()]
    if (!objetivo) {
      const e = new Error(`red desconocida: ${JSON.stringify(nombre)}`)
      e.code = 'red_desconocida'
      throw e
    }
    if (objetivo.mainnet && confirmar !== 'MAINNET') {
      const e = new Error(
        'cambiar a una red MAINNET (plata real) pide confirmar: mandá "confirmar":"MAINNET"'
      )
      e.code = 'confirmar_mainnet'
      throw e
    }
    return walletMod.guardarRed(dirWallet, nombre)
  })

  // FASE 12 — los tokens que el panel vigila. Mismo patron que el de arriba: el
  // closure es dueño de `dirWallet` y el gateway no importa `wallet.mjs`.
  //
  // Se relee el archivo en cada operacion en vez de cachear la lista: es un
  // archivo chico, lo tocan un humano y un panel, y una copia en memoria sobre
  // un archivo que se puede editar a mano es como se pierde lo que el otro
  // escribio. La validacion y el dedupe viven adentro de `guardarTokens`.
  gw.setWalletTokensStore({
    listar: (caip2) => walletMod.leerTokens(dirWallet)[caip2] || [],
    agregar: (caip2, tok) => {
      const tabla = walletMod.leerTokens(dirWallet)
      tabla[caip2] = (tabla[caip2] || []).concat([tok])
      return walletMod.guardarTokens(dirWallet, tabla)[caip2] || []
    },
    quitar: (caip2, address) => {
      const tabla = walletMod.leerTokens(dirWallet)
      const buscada = String(address || '').toLowerCase()
      tabla[caip2] = (tabla[caip2] || []).filter(
        (t) => String(t.address || '').toLowerCase() !== buscada
      )
      return walletMod.guardarTokens(dirWallet, tabla)[caip2] || []
    }
  })

  // FASE 12 — lo que Settings muestra de solo lectura. La ruta del keystore y la
  // version ya salen en el log de arranque; esto las pone donde se las busca
  // cuando algo no cuadra, que es tres pantallas de scroll despues.
  gw.setWalletInfo({ keystore: dirWallet, version: pkg.version })

  // FASE 12 — enviar desde el panel. `cobro.enviar` es un closure que se quedo
  // con la cuenta de WDK: el gateway pide una transferencia, no una clave. Sin
  // wallet abierta queda en null y el endpoint contesta 503 diciendo por que.
  gw.setWalletSender(cobro.enviar ? { enviar: cobro.enviar, cotizar: cobro.cotizar } : null)

  // FASE 12 — SE LE DA CUERDA A ethers ACA, Y NO EN EL PRIMER CLICK.
  //
  // Medido: la PRIMERA llamada de red de ethers a veces no vuelve, y como el
  // resto queda encolado detras de su deteccion de red, el proveedor se traba
  // entero — el panel gira para siempre y ningun envio posterior contesta hasta
  // reiniciar. Que esa primera llamada sea la de alguien apretando "Revisar" es
  // la peor version del problema.
  //
  // Asi que se hace acá, al arrancar, cuando no hay nadie esperando. NO se
  // espera y NO se corta si falla: un nodo sin internet tiene que arrancar
  // igual — la derivacion de la direccion nunca necesito la red y eso no cambia
  // (ver `cuentaDesde` en wallet.mjs). Si sale bien, el primer envio de verdad
  // ya encuentra el proveedor despierto.
  if (cobro.calentar) {
    cobro.calentar().then(
      (ok) => {
        if (ok) console.log('  [wallet] RPC alcanzable: la wallet puede enviar')
      },
      () => {}
    )
  }

  // Esta maquina puede responder con SU modelo sin haberse unido a nada, y el
  // registro tiene que decirlo desde el arranque. Si la fila local recien
  // apareciera con --swarm, un gateway sin agente lanzado no tendria NINGUN
  // nodo y el chat contestaria "no hay nodos sirviendo ese modelo" -- cuando
  // la maquina puede contestar sola. Es la mitad local de la puerta: a la red
  // se entra lanzando el agente, al modelo propio se llega siempre.
  for (const m of swarmModels()) {
    store.registerLocal({
      modelId: m.modelId,
      displayName: m.displayName,
      operator,
      tags: ['general', 'chat'],
      pricing: '1000000 QVAC / per 1m completion tokens',
      maxConcurrentRequests: m.maxConcurrentRequests
    })
  }

  // FASE 8.5 — el asistente externo, si el operador configuro alguno. Va
  // DESPUES de la fila local a proposito: el orden en que se registran no
  // decide nada (eso es pickCandidate), pero el log de arranque se lee mejor
  // con la maquina propia primero y el tercero despues.
  await registrarUpstreams({ gw, store, dir: budgetDir })

  let nodeSwarm = null
  let provider = null
  let data = null

  // Lo que antes corria una sola vez al arrancar con --swarm es ahora una
  // funcion: el boton "Launch local agent" del chat la llama por HTTP, asi
  // nadie tiene que volver a la terminal a reiniciar el proceso con otro flag.
  async function launchAgent() {
    if (nodeSwarm) return nodeSwarm

    // El swarm escribe en el MISMO registro que lee el gateway: un manifiesto
    // verificado se vuelve una fila del marketplace, y los paneles la dibujan
    // sin saber que vino de un par. Esa es la costura de Fase 2-c. `store` y
    // `operator` son los de runServe: declararlos de nuevo aca los sombreaba
    // con OTRO default de nombre.

    // El Hyperbee y el Hyperdrive se abren ANTES del join: el manifiesto que
    // se firma al conectarse lleva la clave del directorio adentro, y firmarlo
    // sin ella significaria anunciar el mock de D2 durante toda la sesion.
    if (withStore) {
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

    // S2 de NOTES-SATURACION.md: la capacidad HONRADA sale de la misma lista
    // que la ANUNCIADA. Antes eran dos literales `3` escritos aparte, y el
    // comentario de swarmModels() ya declaraba la intencion de que fuera una
    // sola fuente -- pero el Provider no la leia. Con el manifiesto editable
    // desde el panel eso deja de ser teorico: subir la capacidad anunciada no
    // subia la que se cumple, y el nodo pasaba a anunciar lo que no sirve.
    provider = new Provider({
      engineLoader: () => import('./qvac/engine.mjs'),
      store,
      models,
      maxConcurrent: capacidadDeclarada(models)
    })
    nodeSwarm.setProvider(provider)

    // El gateway necesita el swarm y los archivos para poder mandar chat:request
    // a un par y publicar los que se suben.
    gw.setSwarm(nodeSwarm)
    if (data && data.files) gw.setFiles(data.files)

    return nodeSwarm
  }

  gw.setLauncher(launchAgent)
  if (useSwarm) await launchAgent()

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

    // Los dos archivos que sostienen el tope de gasto. `close` de apikeys es lo
    // unico que baja el `lastUsedAt` a disco -- `verifyKey` lo toca en cada
    // request y no guarda, para no pagar un fsync en el camino caliente.
    apikeys.close()
    budget.close()

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
  return server
}

async function runServe() {
  await startGateway({
    port: serveCmd.flags.port,
    gpuLayers: serveCmd.flags.gpuLayers,
    demo: serveCmd.flags.demo === true,
    swarm: serveCmd.flags.swarm === true,
    operator: serveCmd.flags.operator,
    store: serveCmd.flags.store
  })
}

// Abrir el navegador es lo que convierte "corri un comando" en "se abrio la
// app". Es best-effort a proposito: si falla -- sin entorno grafico, por SSH,
// con el navegador sin registrar -- se imprime la URL y listo.
async function openBrowser(url) {
  try {
    const { spawn } = await import('bare-subprocess')
    const [file, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    const child = spawn(file, args, { stdio: 'ignore' })
    child.on('error', () => {})
    if (child.unref) child.unref()
    return true
  } catch {
    return false
  }
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
      displayName:
        (MODEL_INFO[DEFAULT_MODEL] && MODEL_INFO[DEFAULT_MODEL].displayName) || DEFAULT_MODEL,
      maxConcurrentRequests: 3,
      pricing: [{ unit: 'per_1m_completion_tokens', amount: '1000000', currency: 'QVAC' }]
    }
  ]
}

// La suma de los slots que este nodo declara en su manifiesto. El Provider
// cuenta requests en vuelo sin importar el modelo, asi que el limite que hace
// cumplir tiene que ser el total declarado -- no el de un modelo suelto.
function capacidadDeclarada(models) {
  const total = models.reduce(
    (n, m) => n + (Number.isFinite(m.maxConcurrentRequests) ? m.maxConcurrentRequests : 0),
    0
  )
  return total > 0 ? total : 1
}

function swarmStorageDir() {
  return cmd.flags.storage || path.join(isDev ? os.tmpdir() : persistent(), appName)
}

// D30.1 — EL KEYSTORE NO VA A %TEMP%, Y POR ESO NO SALE DE `swarmStorageDir`.
//
// Bajo `bare` —o sea en desarrollo, que es justo donde se va a probar el fondeo—
// `swarmStorageDir()` manda todo a `os.tmpdir()`. Para el Corestore eso es
// aceptable: se vuelve a bajar. Para una wallet no, porque Windows limpia temp y
// ahi adentro lo que se pierde es la unica copia de una seed.
//
// La resolucion vive en `wallet.mjs` y no aca porque es la regla que hay que
// poder probar sola; esto solo le pasa las tres rutas y grita si el resultado
// quedo en temp igual. Un `--storage` explicito se respeta —es del operador—
// pero no en silencio.
async function walletStorageDir() {
  const { directorioKeystore } = await import('./qvac/wallet.mjs')
  const r = directorioKeystore({
    storage: cmd.flags.storage || null,
    persistente: persistent(),
    app: appName
  })
  if (r.volatil) {
    console.error(`  [wallet] OJO: ${r.motivo}`)
    console.error('  [wallet] una wallet fondeada ahi puede desaparecer sin aviso')
  }
  return r.dir
}

// Abre el Corestore y lo que cuelga de el: el Hyperbee del directorio y el
// Hyperdrive de archivos. Devuelve las tres cosas mas un `close()` que las
// cierra en orden.
//
// UN SOLO PROCESO POR DIRECTORIO DE STORAGE. El Corestore toma un lock de
// RocksDB sobre su carpeta: `pyrusllm send` mientras corre `pyrusllm serve`
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

// FASE 7 — la direccion de cobro del nodo, si tiene una.
//
// Devuelve el bloque `economic` listo para el manifiesto, o null. Que no haya
// wallet es el caso NORMAL de un nodo que todavia no cobra: se sigue sin ella y
// el manifiesto lleva el mock, marcado. Lo que SI se avisa fuerte es la wallet
// que existe y no se puede abrir, porque ahi alguien la configuro y el nodo la
// esta ignorando -- y "no cobro nunca" no puede verse igual que "no pude abrir
// mi wallet".
// Devuelve `{ economic, firmar }`: el bloque publico que va al manifiesto, y una
// FUNCION que firma con la wallet (D24). La cuenta no sale de acá y la seed
// menos: el gateway pide firmas, no llaves.
async function economicDelNodo(dir) {
  const wallet = await import('./qvac/wallet.mjs')
  if (!wallet.existe(dir)) {
    return { economic: null, firmar: null, enviar: null, cotizar: null, calentar: null, red: null }
  }

  try {
    // D30.2 — la red se resuelve del entorno y SE LE PASA. Antes `abrir` recibia
    // un `rpc` que nadie completaba, asi que la constante de mainnet ganaba
    // siempre y no habia forma de operar contra 9746.
    // FASE 11 — con `dir` además mira `wallet.red`, que escribe el selector del
    // panel. El entorno sigue ganando.
    const red = wallet.redDe(env, { dir })
    // FASE 11 — la passphrase sale del entorno o, si el onboarding del panel la
    // generó, de `wallet.pass`. `generar:false`: acá solo se ABRE lo que ya
    // existe; si hay keystore y no hay passphrase en ningún lado, `abrir` corta
    // con un motivo, que es lo correcto.
    const { passphrase } = wallet.resolverPassphrase(dir, { env })
    const abierta = await wallet.abrir(dir, passphrase, { red })
    console.log(`  [wallet] direccion de cobro: ${abierta.address}`)
    console.log(`  [wallet] redes: ${wallet.CHAINS.join(', ')} — liquidacion: ${wallet.SETTLEMENT}`)
    console.log(`  [wallet] red: ${red.nombre} (eip155:${red.chainId}) via ${red.rpc}`)
    // D30 en una linea: mainnet no es donde se prueba. No corta —el operador
    // puede querer estar ahi— pero no puede pasar desapercibido.
    if (red.mainnet) {
      console.log(`  [wallet] OJO: ${red.nombre} es MAINNET y mueve plata real.`)
      console.log(`  [wallet] D30: se estrena en testnet. ${wallet.VAR_RED}=plasma-testnet`)
    }
    return {
      economic: wallet.economicDe(abierta.address),
      // FASE 9 / D24 — `account.sign` de WDK es un personal_sign EIP-191 sobre
      // el mensaje, que es lo que `recoverMessageAddress` verifica del otro
      // lado. Se envuelve en una closure para que lo unico que cruce a
      // gateway.mjs sea la capacidad de firmar, no la cuenta ni la frase.
      firmar: (mensaje) => abierta.cuenta.sign(mensaje),
      // FASE 12 — mandar plata, con la MISMA forma que `firmar`: una funcion,
      // no la cuenta. El gateway puede pedir una transferencia y no puede leer
      // la clave con la que se firma, que es toda la invariante.
      //
      // `monto` llega en unidades BASE (wei, o la potencia de los decimales del
      // token) y como BigInt: convertir con punto flotante un saldo de 18
      // decimales pierde precision justo en la cifra que se manda.
      enviar: ({ destino, monto, asset }) =>
        asset === 'native'
          ? abierta.cuenta.sendTransaction({ to: destino, value: monto })
          : abierta.cuenta.transfer({ token: asset, recipient: destino, amount: monto }),
      // El gas ESTIMADO para la pantalla de revision. Va aparte de `enviar` a
      // proposito: cotizar no firma ni difunde nada, y confundir las dos seria
      // mandar una transaccion cuando alguien solo estaba mirando cuanto sale.
      cotizar: ({ destino, monto, asset }) =>
        asset === 'native'
          ? abierta.cuenta.quoteSendTransaction({ to: destino, value: monto })
          : abierta.cuenta.quoteTransfer({ token: asset, recipient: destino, amount: monto }),
      // FASE 12 — la primera llamada de red de ethers, hecha a proposito y en
      // un momento en que nadie espera. Ver la nota del llamador en
      // `startGateway`. Es de solo lectura: pregunta el saldo, no firma nada.
      calentar: async () => {
        try {
          await abierta.cuenta.getBalance()
          return true
        } catch {
          // Sin internet, o el RPC caido. No es un error de arranque: el nodo se
          // anuncia igual, y el envio ya avisa por su cuenta cuando no anda.
          return false
        }
      },
      // FASE 11 — la red resuelta, para que el panel /wallet lea saldos con la
      // direccion PUBLICA. No lleva la seed ni la cuenta: solo rpc/chainId.
      red
    }
  } catch (err) {
    console.error(`  [wallet] ${(err && err.message) || err}`)
    console.error('  [wallet] el nodo se anuncia SIN direccion de cobro (economic queda en mock)')
    return { economic: null, firmar: null, enviar: null, cotizar: null, calentar: null, red: null }
  }
}

// ---------------------------------------------------------------------------
// pyrusllm wallet
// ---------------------------------------------------------------------------

async function runWallet() {
  await cargarEnv()
  const wallet = await import('./qvac/wallet.mjs')
  const dir = await walletStorageDir()
  const red = wallet.redDe(env, { dir })
  // PHASE 11 — from the environment, or from `wallet.pass` if the panel
  // onboarding generated it. That way `pyrusllm wallet` sees a wallet created
  // from the browser.
  const { passphrase } = wallet.resolverPassphrase(dir, { env })
  const restore = walletCmd.flags.restore

  if (walletCmd.flags.create || restore) {
    if (!passphrase) {
      console.error(`  missing ${wallet.VAR_PASSPHRASE}: it is what the seed is encrypted with.`)
      console.error(
        `  Put it in the .env of this directory, or create the wallet from the /wallet panel.`
      )
      process.exitCode = 1
      return
    }
    try {
      const r = await wallet.crear(dir, passphrase, {
        red,
        frase: typeof restore === 'string' ? restore : null
      })
      console.log('')
      console.log(`  payout address: ${r.address}`)
      console.log(`  networks: ${wallet.CHAINS.join(', ')} — settlement: ${wallet.SETTLEMENT}`)
      console.log(`  active network: ${red.nombre} (eip155:${red.chainId})`)
      console.log('')
      if (r.restaurada) {
        console.log('  wallet RESTORED from the backup.')
      } else {
        // They are shown ONCE and are never available again without the
        // passphrase. Saying so in plain words is part of the job: whoever
        // does not write them down finds out the day they lose the keystore.
        console.log('  WRITE DOWN THESE 24 WORDS. They are not shown again:')
        console.log('')
        const p = r.frase.split(' ')
        for (let i = 0; i < p.length; i += 6) {
          console.log('    ' + p.slice(i, i + 6).join(' '))
        }
        console.log('')
        console.log('  Without them AND without the keystore, the wallet is lost.')
      }
      console.log('')
      console.log(`  keystore: ${path.join(dir, 'wallet.json')} (encrypted)`)
      console.log('')
    } catch (err) {
      console.error(`  ${(err && err.message) || err}`)
      process.exitCode = 1
    }
    return
  }

  if (!wallet.existe(dir)) {
    console.log('')
    console.log('  This node has no wallet yet, so it declares no payout address.')
    console.log('  Its manifest announces `economic` as a mock, and that is marked.')
    console.log('')
    console.log(`  To create one:  ${appName} wallet --create`)
    console.log('')
    return
  }

  try {
    const abierta = await wallet.abrir(dir, passphrase, { red })
    console.log('')
    console.log(`  payout address: ${abierta.address}`)
    console.log(`  networks: ${wallet.CHAINS.join(', ')} — settlement: ${wallet.SETTLEMENT}`)
    console.log(`  active network: ${red.nombre} (eip155:${red.chainId}) via ${red.rpc}`)
    console.log(`  keystore: ${path.join(dir, 'wallet.json')} (encrypted)`)
    if (red.mainnet) {
      console.log('')
      console.log(`  OJO: ${red.nombre} es MAINNET. D30: se estrena en testnet.`)
      console.log(`  Para apuntar a la de prueba:  ${wallet.VAR_RED}=plasma-testnet`)
    }
    console.log('')
  } catch (err) {
    console.error('')
    console.error(`  ${(err && err.message) || err}`)
    console.error('')
    process.exitCode = 1
  }
}

async function joinSwarm({ operator, store = null, data = null }) {
  const { loadOrCreateIdentity } = await import('./qvac/identity.mjs')
  const { NodeSwarm, TOPIC_NAME } = await import('./qvac/swarm.mjs')

  const dir = swarmStorageDir()
  const identity = loadOrCreateIdentity(dir)

  const models = swarmModels()
  // Solo el bloque publico: al manifiesto va la direccion, nunca la capacidad de
  // firmar. El firmante lo recibe el gateway, en runServe.
  const { economic } = await economicDelNodo(await walletStorageDir())

  const nodeSwarm = new NodeSwarm({
    identity,
    models,
    operator: operator || `Nodo de ${os.hostname()}`,
    tags: ['general', 'chat'],
    store,
    corestore: data ? data.corestore : null,
    directory: data ? data.directory : null,
    files: data ? data.files : null,
    economic
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
// pyrusllm peers
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
// pyrusllm send / fetch / files
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
    console.log(`  PyrusLLM v${pkg.version} — sharing over P2P`)
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
    console.log(`    pyrusllm fetch ${res.link}`)
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
// pyrusllm  (nodo: banner + OTA)
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

  // Banner. The version number is printed large on purpose: it is what changes
  // live when the OTA is demonstrated, and it has to be readable on a
  // projector.
  console.log('')
  console.log('  PyrusLLM  v' + pkg.version)
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

    // `pyrusllm` a secas ABRE LA APP. El updater OTA sigue corriendo abajo:
    // esto es ademas, no en vez de. Con --no-serve queda el comportamiento
    // viejo, que era supervisar la version y nada mas.
    if (cmd.flags.serve === false) {
      console.log(`CLI listo. Proba:  ${appName} prompt "hola"`)
      console.log('Ctrl+C para salir.\n')
      return
    }

    const port = Number.isFinite(+cmd.flags.port) ? +cmd.flags.port : 8787

    // Arranca SIN unirse al swarm a proposito: entrar a la red es lo que hace
    // el boton "Launch local agent" de la pagina, y esa puerta es el producto.
    // Un arranque que ya se unio solo se la saltea.
    await startGateway({ port })

    const url = `http://localhost:${port}`
    const abierto = cmd.flags.open === false ? false : await openBrowser(url)
    console.log(abierto ? `  abriendo ${url}` : `  abri ${url} en el navegador`)
    console.log('')
  } catch (err) {
    console.error('[app:error]', err)
    await app.close().finally(() => Bare.exit(1))
  }
}
