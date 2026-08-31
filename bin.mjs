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

// Each subcommand's work starts from paparam's runner, which isn't
// awaitable from outside. The promise is stashed here and awaited at the end.
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
    'do not open the Hyperbee/Hyperdrive: the node runs with no persistence or files,' +
      ' as it did before Phase 5. Useful for running two nodes over the same --storage.'
  ),
  flag('--operator <nombre>', 'operator name advertised in the manifest'),
  flag(
    '--model <alias>',
    `model this node serves: ${Object.keys(MODELS).join(' | ')} (default ${DEFAULT_MODEL}).` +
      ' The one advertised in the manifest AND the one the engine loads: a single source.'
  ),
  flag(
    '--ctx <n>',
    `model's context window (default ${DEFAULT_CTX_SIZE}). Prompt + reasoning +` +
      ' answer TOGETHER: a "thinking" model with 2048 runs out of room before answering.'
  ),
  flag(
    '--gpu-layers <n>',
    'layers to hand off to the real node\'s GPU. 0 = all CPU (8x faster on the demo iGPU, see NOTES.md)'
  ),
  flag(
    '--log-inference',
    'show progress of each generation: TTFT, bytes and chunks every 5s.' +
      ' Without this, an answer that takes minutes looks exactly like a hung process.'
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

  // "-" reads the prompt from stdin. Not a luxury: on Windows the standalone
  // bare-build binary receives argv in the ANSI codepage and mangles any
  // non-ASCII character —"Respondé" arrives as "Respond�"—,
  // while `bare.exe` with the same string passes it through intact. stdin is
  // a byte stream and doesn't go through that conversion. Repro and detail in NOTES.md.
  const text = promptCmd.args.prompt === '-' ? await readStdin() : promptCmd.args.prompt

  if (!text || text.trim() === '') {
    console.error('[pyrusllm] the prompt is empty.')
    Bare.exitCode = 1
    return
  }

  // DYNAMIC import: importing the engine dlopens the llamacpp addon
  // (96 MB on win32-x64) right away. Plain `pyrusllm` shouldn't have to
  // pay for that. bare-pack still bundles it into the standalone binary: the
  // traverse follows `import()` calls with a literal specifier.
  const engine = await import('./qvac/engine.mjs')

  let modelId = null
  const t0 = Date.now()

  try {
    const { entry, name, cached, modelSrc } = await engine.resolveModel(pick)
    const mb = (entry.expectedSize / 1e6).toFixed(0)

    say()
    say(`  PyrusLLM v${pkg.version} - 100% local inference`)
    say()
    say(`  model    : ${name}  ${entry.params}  ${mb} MB`)
    say(`  weights  : ${cached ? 'cached' : 'missing, downloading over hypercore'}`)
    say(`  cache    : ${engine.modelsDir()}`)
    say(`  runtime  : ${runtimeLabel}`)
    say()

    // Downloading weights is an explicit effect of REQUESTING an inference,
    // never an effect of starting the node. That invariant from the runbook
    // still holds: plain `pyrusllm` doesn't download a single byte of model.
    // `--no-download` is there to force strict mode regardless.
    if (!cached && !allowDownload) {
      throw new Error(
        `"${name}" is not cached and --no-download was passed. That's ${mb} MB. Run the same command without --no-download.`
      )
    }

    let lastPct = -1
    if (!cached) say(`  downloading ${mb} MB over hypercore...`)

    modelId = await engine.loadModel({
      modelSrc,
      ctxSize,
      gpuLayers,
      onProgress: (p) => {
        // Only while it's actually downloading: with the model cached the SDK
        // still emits progress, and a bar that goes from 0% to 0% is confusing.
        if (quiet || cached) return
        const pct = Math.floor((p && (p.progress ?? p.percent ?? 0)) * 100)
        if (pct === lastPct) return
        lastPct = pct
        process.stdout.write(`\r  download ${pct}%   `)
        if (pct >= 100) process.stdout.write('\n')
      }
    })

    const tLoaded = Date.now()
    say(`  model ready in ${secs(tLoaded - t0)}`)
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
    say(`  model load          : ${secs(tLoaded - t0)}`)
    say(`  first token (TTFT)  : ${firstTokenAt ? secs(firstTokenAt - tLoaded, 2) : 'n/a'}`)
    say(`  full answer         : ${secs(tEnd - tLoaded)}`)
    say()
  } catch (err) {
    console.error('\n[pyrusllm] inference failed:', (err && err.message) || err)
    Bare.exitCode = 1
  } finally {
    // Without this the process never exits: `unloadModel` deliberately leaves
    // the swarm, the registry client and the corestore up.
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

// Loads the `.env` from the working directory and the one from storage, in
// that order. Whichever defines a variable first wins, and a variable
// ALREADY present in the environment beats both: see the note in
// qvac/dotenv.mjs.
//
// It reports that it loaded, with the NAMES and never the values. Without
// that notice, "the .env wasn't read" and "the .env was read but the
// variable is named differently" look exactly the same from outside -- which
// is how an afternoon got lost.
async function cargarEnv() {
  const dotenv = await import('./qvac/dotenv.mjs')
  const vistos = []
  for (const dir of [process.cwd(), swarmStorageDir()]) {
    const { cargadas } = await dotenv.cargar(dir)
    for (const nombre of cargadas) if (!vistos.includes(nombre)) vistos.push(nombre)
  }
  if (vistos.length) console.log(`  [env] .env: ${vistos.join(', ')}`)
}

// Reads `<storage>/upstreams.json` and turns each external model into a row
// in the registry. This is ALL of Phase 8.5's wiring on the startup side:
// from here on /v1/models lists it, chat offers it, and routing scores it.
//
// An upstream is registered OFFLINE if it's missing the credential or the
// price. The two absences are different and neither can pass silently:
//
//   - without a credential it cannot answer, and the error would only surface
//     on the first prompt, with the user watching;
//   - without a price `costs.estimar` returns ZERO, the reserve doesn't set
//     anything aside and the spending cap stops cutting off on exactly the
//     one path that costs dollars. An external that's free-in-the-ledger's-
//     eyes is worse than an external that's turned off.
//
// Offline, not absent, because the panel has to show it along with what it's
// missing: "you misconfigured it" and "you configured nothing" can't look
// the same.
async function registrarUpstreams({ gw, store, dir }) {
  const upstream = await import('./qvac/upstream.mjs')
  const costs = await import('./qvac/costs.mjs')

  const cfg = await upstream.leerConfig(dir)
  if (cfg.error) {
    console.error(`  [upstream] ${cfg.error}`)
    console.error('  [upstream] continuing without an external assistant')
    return
  }

  // Reread in full: the rows and prices from a previous run are cleared
  // before writing the new ones, or a model removed from the file would
  // keep being advertised.
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams(cfg.upstreams)
  gw.setUpstreamOptIn(cfg.optIn)

  if (cfg.upstreams.length === 0) return

  for (const u of cfg.upstreams) {
    // The price is registered against the registry's ROW ID and not against
    // the modelId: if two nodes serve the same model -- a free peer and this
    // API charging -- indexing by model name would charge the peer the third
    // party's rate. See claveDePrecio() in gateway.mjs.
    const filaId = `upstream:${u.id}`
    const conPrecio = u.precio ? costs.registrarPrecio(filaId, u.precio) : false

    // What this upstream is missing to be able to answer. Both requirements
    // apply to a REMOTE provider and neither to a local one:
    //
    //   - credential: a localhost endpoint carries none;
    //   - price: an endpoint of your own costs no dollars, so zero isn't a
    //     hole in the ledger -- it's the truth. Requiring it would leave
    //     disabled the one upstream that can never go over a cap.
    const falta = []
    if (!u.disponible()) falta.push(`missing the ${u.apiKeyEnv} environment variable`)
    if (!conPrecio && !u.esLocal) falta.push('missing "pricePerMTok" in the config')

    store.registerUpstream({
      id: u.id,
      // The name it enters the marketplace under, which may not be the one
      // the provider uses: two doors to the same model have to land on the
      // same catalogue row so they can compete against each other.
      modelId: u.anunciadoComo,
      displayName: u.displayName,
      // The operator shown in the panel and carried in the provenance
      // headers. States the provider AND which side it's on: the privacy
      // promise is scoped right in the name of whoever answered.
      operator: u.esLocal ? `${u.label} (local)` : `${u.label} (external)`,
      pricing: conPrecio
        ? `${costs.formatUSD(u.precio.salida)} / per 1m completion tokens`
        : u.esLocal
          ? 'no cost: runs on this machine'
          : 'no price declared',
      tags: u.tags,
      maxConcurrentRequests: u.maxConcurrent,
      status: falta.length ? 'offline' : 'online',
      local: u.esLocal
    })

    const comoSeLlama =
      u.anunciadoComo === u.model
        ? u.model
        : `${u.anunciadoComo} (the provider calls it ${u.model})`

    if (falta.length) {
      console.log(`  [upstream] ${u.displayName} (${u.label}) DISABLED: ${falta.join('; ')}`)
    } else if (u.esLocal) {
      console.log(
        `  [upstream] ${u.displayName} (${u.label}) ready at ${u.baseUrl} — local, no cost — ${comoSeLlama}`
      )
    } else {
      console.log(
        `  [upstream] ${u.displayName} (${u.label}) ready — up to ${u.maxTokens} output tokens, ` +
          `${costs.formatUSD(u.precio.salida)}/1M — ${comoSeLlama}`
      )
    }
  }

  // The opt-in is about THIRD PARTIES. A node whose upstreams are all local
  // has no reason to read a notice about prompts leaving the machine,
  // because none do: showing it anyway trains people to ignore the notice
  // on the day it's actually true.
  if (cfg.upstreams.some((u) => !u.esLocal)) {
    console.log(
      cfg.optIn
        ? '  [upstream] opt-in ON: with the network at no capacity, the prompt may go out to a third party'
        : '  [upstream] opt-in off: no prompt leaves to a third party (turn it on at /node)'
    )
  }
}

// Brings up the gateway and the panels. Used by TWO paths: `pyrusllm serve`
// with its flags, and plain `pyrusllm` -- which also runs the OTA updater.
// Takes options instead of reading serveCmd.flags because on the second path
// that subcommand never got parsed and all its flags are undefined.
async function startGateway(opts = {}) {
  const port = Number.isFinite(+opts.port) ? +opts.port : 8787
  const gpuLayers = Number.isFinite(+opts.gpuLayers) ? +opts.gpuLayers : undefined

  const demo = opts.demo === true
  const useSwarm = opts.swarm === true
  const withStore = opts.store !== false

  // The `.env` goes FIRST, before anything else: upstream credentials are
  // read from the environment, and loading it after registering them would
  // leave the upstreams disabled over a variable that was there the whole time.
  //
  // It's looked up in the working directory and not the storage one: a
  // `.env` belongs to the project being run, and whoever writes it puts it
  // next to where it executes. Also in storage, for the installed binary,
  // which has no obvious "next to it".
  await cargarEnv()

  // PHASE 6.5 — the spend ledger is opened BEFORE the gateway. If it opened
  // afterward, the first requests would run uncounted: a handful, but
  // exactly the startup ones, which is when a freshly launched loop spends
  // fastest. A cap with a blind window is not a cap.
  const budget = await import('./qvac/budget.mjs')
  const budgetDir = swarmStorageDir()
  try {
    const fs = await import('bare-fs')
    fs.default.mkdirSync(budgetDir, { recursive: true })
  } catch {
    // If it can't be created, budget.open warns and falls back to memory.
  }
  budget.open(budgetDir)

  // And the API key registry BEFORE the gateway, for the same reason and one
  // more: the account the ledger charges spend against IS the key, so a
  // registry that doesn't survive the process is a cap that resets on
  // restart. They go together or the one above guarantees nothing.
  const apikeys = await import('./qvac/apikeys.mjs')
  const cargadas = apikeys.open(budgetDir)
  if (cargadas > 0) console.log(`  [apikeys] ${cargadas} key(s) from the saved registry`)

  // `modeloElegido()` validates the alias and throws if it doesn't exist:
  // better not to start than to advertise a model the engine can't load later.
  const modelo = modeloElegido()

  const ctx = serveCmd.flags && serveCmd.flags.ctx ? Number(serveCmd.flags.ctx) : undefined
  if (ctx !== undefined && (!Number.isFinite(ctx) || ctx < 512)) {
    throw new Error(`--ctx "${serveCmd.flags.ctx}" must be an integer >= 512`)
  }

  const logInference = !!(serveCmd.flags && serveCmd.flags.logInference)

  const { createGateway, shutdownGateway } = await import('./qvac/gateway.mjs')
  const server = createGateway({ port, gpuLayers, demo, model: modelo, ctx, logInference })

  const gw = await import('./qvac/gateway.mjs')
  const store = await import('./qvac/store.mjs')
  const operator = opts.operator || `Node on ${os.hostname()}`

  // PHASE 9 — the wallet is opened at STARTUP, not when joining the swarm.
  //
  // It used to be inside `launchAgent`, and that had two consequences that
  // weren't obvious: a node with a wallet running `serve` WITHOUT `--swarm`
  // could never charge -- the gateway never found out it existed --, and
  // with `--swarm`, requests arriving during the seconds the join takes got
  // 401 instead of 402. Both surfaced by testing the DoD curl against the
  // real node, not in the tests.
  //
  // La wallet no depende del swarm: es de esta maquina. `joinSwarm` la vuelve a
  // leer para el manifiesto, que es otra cosa -- ahi va FIRMADA.
  // D30.1 — el keystore NO sale de `budgetDir`: ese puede estar en temp.
  const dirWallet = await walletStorageDir()
  const cobro = await economicDelNodo(dirWallet)
  gw.setEconomic(cobro.economic)
  // D24 — no signer means no attestation, and that's correct: better to not
  // issue one than to issue it unsigned. The gateway says so in the receipt.
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

  // PHASE 10 — the batch receipt accumulator is opened HERE, with the same
  // precedence as the ledger and the API keys (before the gateway) and for
  // the same reason: a receipt arriving before the pending ones from a
  // previous run are loaded would start an incomplete batch. It's opened
  // against `dirWallet` — D30.1's persistent dir, NOT `budgetDir`, which is
  // temp under bare — because what gets saved there are signed EIP-3009
  // authorizations, i.e. charges. It's injected with what to sign with (the
  // node's wallet) and what to settle with (`x402.liquidar`); the flush
  // builds-signs-settles by size, by time, and in the `close` below. The
  // provider shares this same singleton, so there is only one persistence layer.
  const lote = await import('./qvac/lote.mjs')
  const x402 = await import('./qvac/x402.mjs')
  const pendientesLote = lote.abrir(dirWallet, { firmar: cobro.firmar, liquidar: x402.liquidar })
  if (pendientesLote > 0) {
    console.log(`  [lote] ${pendientesLote} receipt(s) pending from a previous run`)
  }

  // This machine can answer with ITS OWN model without having joined
  // anything, and the registry has to say so from startup. If the local row
  // only appeared with --swarm, a gateway with no agent launched would have
  // NO node at all and chat would answer "no nodes serving that model" --
  // when the machine can answer on its own. This is the local half of the
  // gate: you enter the network by launching the agent, but your own model
  // is always reachable.
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

  // PHASE 8.5 — the external assistant, if the operator configured one. This
  // goes AFTER the local row on purpose: the order they're registered in
  // doesn't decide anything (that's pickCandidate's job), but the startup
  // log reads better with this machine first and the third party after.
  await registrarUpstreams({ gw, store, dir: budgetDir })

  let nodeSwarm = null
  let provider = null
  let data = null

  // What used to run once at startup with --swarm is now a function: the
  // chat's "Launch local agent" button calls it over HTTP, so nobody has to
  // go back to the terminal to restart the process with another flag.
  async function launchAgent() {
    if (nodeSwarm) return nodeSwarm

    // The swarm writes to the SAME registry the gateway reads: a verified
    // manifest becomes a marketplace row, and the panels draw it without
    // knowing it came from a peer. That's Phase 2-c's seam. `store` and
    // `operator` are runServe's own: declaring them again here would shadow
    // them with ANOTHER default name.

    // The Hyperbee and the Hyperdrive are opened BEFORE the join: the
    // manifest signed on connecting carries the directory's key inside, and
    // signing it without one would mean advertising D2's mock for the whole session.
    if (withStore) {
      data = await openData(swarmStorageDir())
      store.attachDirectory(data.directory)

      const hidratados = await store.hydrateFromDirectory()
      if (hidratados > 0) {
        console.log(`  [store] ${hidratados} peer(s) from the directory, offline until they connect`)
      }

      // Pruning happens at startup and not on a timer: running it while the
      // node is serving tokens would put writes to the bee on the hot path.
      data.directory.pruneLog().catch(() => {})
    }

    nodeSwarm = await joinSwarm({ operator, store, data })

    // This node also SERVES: `serve --swarm` is the full node (gateway +
    // provider). The local row gets registered in the registry with or
    // without --demo, because it's not a mock: it's this machine, and
    // without it `node:status` would advertise ZERO capacity while it's
    // actually serving.
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

    // S2 from NOTES-SATURACION.md: the HONEST capacity comes from the same
    // list as the ADVERTISED one. It used to be two `3` literals written
    // separately, and swarmModels()'s comment already declared the intent
    // for it to be a single source -- but the Provider wasn't reading it.
    // With the manifest now editable from the panel that stops being
    // theoretical: raising the advertised capacity wouldn't raise the
    // enforced one, and the node would end up advertising what it doesn't serve.
    provider = new Provider({
      engineLoader: () => import('./qvac/engine.mjs'),
      store,
      models,
      maxConcurrent: capacidadDeclarada(models),
      // PHASE 10 — the same signing capability the gateway receives. Used to
      // attest (D24) and accumulate in the batch what THIS node serves a
      // peer. Without a wallet, the node still serves but doesn't charge a
      // routed request -- `chat:done` says so with a reason.
      walletAddress: cobro.economic ? cobro.economic.walletAddress : null,
      firmarConWallet: cobro.firmar
    })
    nodeSwarm.setProvider(provider)

    // The gateway needs the swarm and the files to be able to send
    // chat:request to a peer and publish the ones that get uploaded.
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
    console.log('\n[gateway] closing...')

    // `server.close()` destroys idle connections but WAITS for the ones in
    // flight, and its callback never runs while an SSE stream is still open.
    // With a real 30s inference in progress, Ctrl+C wouldn't exit. The
    // timeout cuts it off cleanly: 3s to close nicely, after that it exits anyway.
    const forced = setTimeout(() => {
      console.log('[gateway] there were requests in flight, exiting anyway.')
      Bare.exit(code)
    }, 3000)
    forced.unref?.()

    // The provider first: cuts off in-flight streams before the swarm
    // closes their socket underneath them.
    if (provider) await provider.shutdown()
    if (nodeSwarm) await nodeSwarm.destroy()

    // The corestore goes AFTER the swarm: closing it with sockets still
    // replicating on top leaves streams writing against already-closed
    // cores. If it takes too long, the timeout above cuts it off anyway.
    if (data) await data.close().catch(() => {})

    // PHASE 10 — one last flush of the batch and persist whatever's left.
    // `cerrar` persists BEFORE attempting the flush: if the facilitator
    // doesn't answer and the forced-exit above cuts in, the pending ones are
    // already on disk and the next startup retries them.
    try {
      await lote.cerrar()
    } catch (err) {
      console.error(`[lote] on close: ${(err && err.message) || err}`)
    }

    // The two files that back the spending cap. apikeys' `close` is the only
    // thing that flushes `lastUsedAt` to disk -- `verifyKey` touches it on
    // every request and doesn't save, to avoid paying an fsync on the hot path.
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

  console.log('Ctrl+C to exit.\n')
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

// Opening the browser is what turns "I ran a command" into "the app opened".
// It's best-effort on purpose: if it fails -- no graphical environment, over
// SSH, no registered browser -- the URL is printed and that's it.
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
// Swarm (Phase 2-b): identity + join the topic, shared by `serve --swarm`
// and by `peers`.
// ---------------------------------------------------------------------------

// What this node declares it serves. Its real model, not the --demo mode's
// catalogue: advertising a mock would be lying to the network.
//
// ONE single source: used by both the manifest that gets signed AND the
// Provider handling chat:request. If they diverged, the node would advertise
// a model it later rejects -- and the error would show up on the side of
// whoever trusted the manifest.
//
// maxConcurrentRequests 3: measured, not chosen. Three concurrent completions
// over the same loaded model run in real parallel with no mixing between
// them (tested with distinguishable prompts, see NOTES.md).
// The alias this node serves. Comes from `--model` and falls back to the
// default. Validated against the catalogue: a misspelled alias has to fail
// at startup, not on the first chat -- by then the manifest is already
// signed and advertised.
function modeloElegido() {
  // Optional chaining because `peers` also calls `swarmModels()`, and there
  // `serveCmd` was never invoked: without the `?.` it would be a TypeError
  // instead of falling back to the default, which is the right behavior for
  // a command that doesn't pick a model.
  const pick = (serveCmd.flags && serveCmd.flags.model) || DEFAULT_MODEL
  if (!MODELS[pick]) {
    throw new Error(
      `--model "${pick}" is not in the catalogue. Options: ${Object.keys(MODELS).join(', ')}`
    )
  }
  return pick
}

function swarmModels(pick = modeloElegido()) {
  return [
    {
      modelId: pick,
      displayName: (MODEL_INFO[pick] && MODEL_INFO[pick].displayName) || pick,
      maxConcurrentRequests: 3,
      pricing: [{ unit: 'per_1m_completion_tokens', amount: '1000000', currency: 'QVAC' }]
    }
  ]
}

// The sum of the slots this node declares in its manifest. The Provider
// counts requests in flight regardless of model, so the limit it enforces
// has to be the declared total -- not a single model's own.
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

// D30.1 — THE KEYSTORE DOES NOT GO TO %TEMP%, AND THAT'S WHY IT DOESN'T COME
// FROM `swarmStorageDir`.
//
// Under `bare` —i.e. in development, which is exactly where funding is going
// to get tested— `swarmStorageDir()` sends everything to `os.tmpdir()`. For
// the Corestore that's fine: it just re-downloads. Not for a wallet, because
// Windows clears temp, and what's lost in there is the only copy of a seed.
//
// The resolution logic lives in `wallet.mjs` and not here because it's the
// rule that needs to be testable on its own; this just passes it the three
// paths and shouts if the result still landed in temp. An explicit
// `--storage` is honored —it's the operator's call— but not silently.
async function walletStorageDir() {
  const { directorioKeystore } = await import('./qvac/wallet.mjs')
  const r = directorioKeystore({
    storage: cmd.flags.storage || null,
    persistente: persistent(),
    app: appName
  })
  if (r.volatil) {
    console.error(`  [wallet] HEADS UP: ${r.motivo}`)
    console.error('  [wallet] a wallet funded there can disappear without warning')
  }
  return r.dir
}

// Opens the Corestore and whatever hangs off it: the directory's Hyperbee
// and the files Hyperdrive. Returns all three plus a `close()` that closes
// them in order.
//
// ONE SINGLE PROCESS PER STORAGE DIRECTORY. The Corestore takes a RocksDB
// lock on its folder: `pyrusllm send` while `pyrusllm serve` is running over
// the same `--storage` fails to open. This is a real restriction, not a bug;
// to run both at once, pass the second one a different `--storage`.
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

// PHASE 7 — the node's payment address, if it has one.
//
// Returns the `economic` block ready for the manifest, or null. No wallet is
// the NORMAL case for a node that doesn't charge yet: it just goes without
// one and the manifest carries the mock, marked as such. What DOES get a
// loud warning is a wallet that exists and can't be opened, because there
// somebody configured it and the node is ignoring it -- and "never charges"
// can't look the same as "couldn't open my wallet".
// Returns `{ economic, firmar }`: the public block that goes in the
// manifest, and a FUNCTION that signs with the wallet (D24). The account
// never leaves here, and the seed even less so: the gateway asks for
// signatures, not keys.
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
      console.log(`  [wallet] HEADS UP: ${red.nombre} is MAINNET and moves real money.`)
      console.log(`  [wallet] D30: this debuts on testnet. ${wallet.VAR_RED}=plasma-testnet`)
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
      console.log(`  HEADS UP: ${red.nombre} is MAINNET. D30: this debuts on testnet.`)
      console.log(`  To point at the test one:  ${wallet.VAR_RED}=plasma-testnet`)
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
  // Just the public block: the address goes into the manifest, never the
  // ability to sign. The gateway receives the signer, in runServe.
  const { economic } = await economicDelNodo(await walletStorageDir())

  const nodeSwarm = new NodeSwarm({
    identity,
    models,
    operator: operator || `Node at ${os.hostname()}`,
    tags: ['general', 'chat'],
    store,
    corestore: data ? data.corestore : null,
    directory: data ? data.directory : null,
    files: data ? data.files : null,
    economic
  })

  console.log('')
  console.log(`  [swarm] topic    : ${TOPIC_NAME}`)
  console.log(`  [swarm] identity : ${identity.publicKey.toString('hex').slice(0, 16)}…`)
  console.log(`  [swarm] ${identity.created ? 'NEW key generated' : 'existing key reused'}`)
  console.log(`  [swarm] advertises: ${models.map((m) => m.modelId).join(', ')}`)
  if (data) {
    console.log(
      `  [swarm] directory: ${data.directory.keyHex.slice(0, 16)}… (v${data.directory.version})`
    )
    if (data.files) console.log(`  [swarm] files    : ${data.files.keyHex.slice(0, 16)}…`)
  }
  console.log('')

  await nodeSwarm.join()
  nodeSwarm.startStatusBroadcast()

  // The drive is also advertised on ITS OWN topic, not just via
  // `files:announce` to marketplace peers. That way a `qvac://` link someone
  // pastes on another machine can be downloaded without that machine having
  // to join the marketplace or discover this node through the shared topic.
  if (data && data.files) {
    data.files.swarm = nodeSwarm.swarm
    await data.files.serve()
  }

  console.log('  [swarm] advertised on the DHT, waiting for peers...')
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

  // The summary is printed ONCE on exit, whichever of the two paths triggers
  // it (timeout or Ctrl+C), so the runbook always has the same output to
  // read -- and so the exit code doesn't depend on how it was cut off.
  let done = false
  const finish = async (code) => {
    if (done) return
    done = true

    const t = nodeSwarm.timings()
    const verificados = nodeSwarm.verifiedPeers()

    console.log('')
    console.log('  --- summary ---')
    console.log(`  peers connected NOW   : ${t.peers}`)
    console.log(`  with manifest OK      : ${t.verified}`)
    // The DoD number. A peer that connected, verified, and left still met
    // the DoD: if the other node disconnects earlier, "connected now" reads zero.
    console.log(`  verified EVER TOTAL   : ${t.verifiedEver}`)
    console.log(`  join -> first peer    : ${t.joinToFirstPeerMs ?? 'n/a'} ms`)
    console.log(`  join -> first OK      : ${t.joinToFirstManifestMs ?? 'n/a'} ms`)
    for (const p of verificados) {
      const op = (p.manifest.metadata && p.manifest.metadata.operator) || '?'
      const modelos = p.manifest.models.map((m) => m.modelId).join(', ')
      const carga = p.status
        ? `${p.status.activeRequests}/${p.status.maxConcurrentRequests}`
        : 'n/a'
      console.log(`    · ${op} [${p.key.slice(0, 8)}…] models: ${modelos} load: ${carga}`)
    }
    console.log('')

    // The runbook's gate. Without this a verifier could report OK over zero
    // peers -- exactly the false positive already caught once on the
    // MacBook (see NOTES.md).
    if (expect !== null && t.verifiedEver < expect) {
      console.error(
        `[peers] FAILED: expected at least ${expect} peer(s) with a verified manifest, got ${t.verifiedEver}.`
      )
      code = 1
    } else if (expect !== null) {
      console.log(`  [peers] OK: ${t.verifiedEver} peer(s) verified, expected ${expect}.`)
    }

    await nodeSwarm.destroy()
    Bare.exit(code)
  }

  if (timeoutS !== null) {
    console.log(`  [peers] exiting in ${timeoutS}s...`)
    setTimeout(() => finish(0), timeoutS * 1000)
  } else {
    console.log('  Ctrl+C to exit.')
  }

  process.on('SIGHUP', () => finish(129))
  process.on('SIGINT', () => finish(0))
  process.on('SIGQUIT', () => finish(131))
  process.on('SIGTERM', () => finish(143))
}

// ---------------------------------------------------------------------------
// pyrusllm send / fetch / files
// ---------------------------------------------------------------------------

// Minimal session for the file commands: corestore + drive + its own swarm.
// Does NOT join the marketplace topic -- a `fetch` has no reason to
// advertise itself as an inference node or discover providers. It joins only
// the topic of the drive it cares about.
async function filesSession() {
  const Hyperswarm = (await import('hyperswarm')).default
  const { loadOrCreateIdentity } = await import('./qvac/identity.mjs')

  const dir = swarmStorageDir()
  const identity = loadOrCreateIdentity(dir)
  const data = await openData(dir)

  const swarm = new Hyperswarm({ keyPair: identity })
  // Every connection replicates the whole corestore. That's the only thing
  // these commands do over the network.
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
    console.error(`[files] does not exist: ${ruta}`)
    Bare.exitCode = 1
    return
  }

  const sesion = await filesSession()

  try {
    const esDir = stat.isDirectory()
    const res = esDir
      ? await sesion.files.shareDir(ruta, sendCmd.flags.as)
      : await sesion.files.share(ruta, sendCmd.flags.as)

    // The drive is advertised on its own topic. `flushed()` waits for it to
    // be published on the DHT: without that, printing the link and having
    // the other side paste it the very next second is a race the downloader loses.
    await sesion.files.serve()

    console.log('')
    console.log(`  PyrusLLM v${pkg.version} — sharing over P2P`)
    console.log('')
    if (esDir) {
      console.log(`  folder   : ${res.base}  (${res.files.length} file(s))`)
      const total = res.files.reduce((n, f) => n + f.bytes, 0)
      console.log(`  size     : ${mb(total)}`)
    } else {
      console.log(`  file     : ${res.path}`)
      console.log(`  size     : ${mb(res.bytes)}`)
    }
    console.log(`  drive    : ${sesion.files.keyHex}`)
    console.log('')
    console.log('  On the other machine:')
    console.log('')
    console.log(`    pyrusllm fetch ${res.link}`)
    console.log('')
    console.log('  This process has to stay RUNNING while the other one downloads:')
    console.log('  the bytes come out of here, not from a server. Ctrl+C to stop.')
    console.log('')
  } catch (err) {
    console.error(`[files] could not publish: ${(err && err.message) || err}`)
    await sesion.close()
    Bare.exitCode = 1
    return
  }

  const finish = async (code) => {
    console.log('\n[files] closing...')
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
  console.log(`  path     : ${link.path}`)
  console.log('  looking for a peer that has it...')

  let code = 0
  const t0 = Date.now()

  try {
    // A path ending in '/' is a folder. It's the only clue there is: asking
    // the drive means waiting for the metadata, and if nobody shows up
    // there's no way to tell "it's a folder" apart from "no peer".
    if (link.path.endsWith('/')) {
      const escritos = await sesion.files.pullDir(link.keyHex, link.path, outDir, {
        timeoutMs,
        onFile: ({ dest }) => console.log(`  ✓ ${dest}`)
      })
      console.log('')
      console.log(`  ${escritos.length} file(s) in ${secs(Date.now() - t0)}`)
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
          process.stdout.write(`\r  downloading ${pct}%  ${mb(bytes)} / ${mb(total)}   `)
        }
      })
      process.stdout.write('\n')
      console.log('')
      console.log(`  ✓ ${res.path}  (${mb(res.bytes)} in ${secs(Date.now() - t0)})`)
    }
    console.log('')
  } catch (err) {
    console.error(`\n[files] could not download: ${(err && err.message) || err}`)
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
      console.log(`\n  remote drive ${link.keyHex.slice(0, 16)}…\n`)
      const entradas = await sesion.files.listRemote(link.keyHex, link.path, { timeoutMs })
      if (entradas.length === 0) console.log('  (empty)')
      for (const e of entradas) console.log(`  ${e.path.padEnd(40)} ${mb(e.bytes)}`)
    } else {
      console.log(`\n  local drive ${sesion.files.keyHex}\n`)
      const entradas = await sesion.files.list()
      if (entradas.length === 0) {
        console.log('  (you have not published anything yet)')
        console.log('')
        console.log(`  Try:  ${appName} send ./file.pdf`)
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
// pyrusllm  (node: banner + OTA)
// ---------------------------------------------------------------------------

async function runNode() {
  if (cmd.flags.version) {
    console.log(`${appName} v${pkg.version}`)
    return
  }

  const updates = cmd.flags.updates

  // The updater's jitter window. pear-runtime-updater's default is ONE HOUR
  // (`_defaultDelay = 3_600_000`), and it's only ignored if the new version
  // shows up within the process's first 60s of life (`_bootGracePeriod`).
  // Past that minute, the update gets scheduled at a random point in the window.
  //
  // That default is correct for a large fleet -it keeps thousands of nodes
  // from updating all at once- and useless here: live OTA is the whole
  // pitch, and with an hour of jitter the demo simply shows nothing. 10s
  // gives a visible update without making it synchronized across all nodes.
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
  app.on('updating', () => console.log('[updater] downloading new version'))
  app.on('updated', () => console.log('[updater] download complete... applying'))
  app.on('update-applied', () =>
    console.log('[updater] update applied, restart to run the latest version')
  )

  // OTA download progress. Printed as a single rewritten line instead of one
  // per event: the updater emits often and at 55MB it floods the terminal.
  // This is the line the judges are watching during the OTA demo.
  app.on('updating-progress', (s) => {
    const mb = (s.bytes / 1e6).toFixed(1)
    const pct = Math.round((s.progress || 0) * 100)
    const speed = (s.speed / 1e6).toFixed(1)
    process.stdout.write(`\r[updater] ${pct}%  ${mb} MB  ${speed} MB/s  ${s.peers} peer(s)   `)
    if (pct >= 100) process.stdout.write('\n')
  })

  // A crashed updater does NOT bring down the node: if it's serving tokens,
  // it keeps serving them. It's reported and life goes on.
  app.on('updater-error', (err) => {
    console.error('\n[updater] update failed:', err.message)
    console.error('[updater] the node keeps running on the current version.')
  })

  app.on('error', (err) => console.error('[app:error]', err))

  process.on('SIGHUP', () => app.exit(129))
  process.on('SIGINT', () => app.exit(130))
  process.on('SIGQUIT', () => app.exit(131))
  process.on('SIGTERM', () => app.exit(143))

  try {
    await app.ready()

    // Plain `pyrusllm` OPENS THE APP. The OTA updater keeps running
    // underneath: this is in addition to, not instead of. With --no-serve
    // you get the old behavior, which was just supervising the version and
    // nothing else.
    if (cmd.flags.serve === false) {
      console.log(`CLI ready. Try:  ${appName} prompt "hola"`)
      console.log('Ctrl+C to exit.\n')
      return
    }

    const port = Number.isFinite(+cmd.flags.port) ? +cmd.flags.port : 8787

    // Starts WITHOUT joining the swarm on purpose: entering the network is
    // what the page's "Launch local agent" button does, and that gate is the
    // product. A startup that already joined skips right past it.
    await startGateway({ port })

    const url = `http://localhost:${port}`
    const abierto = cmd.flags.open === false ? false : await openBrowser(url)
    console.log(abierto ? `  opening ${url}` : `  open ${url} in your browser`)
    console.log('')
  } catch (err) {
    console.error('[app:error]', err)
    await app.close().finally(() => Bare.exit(1))
  }
}
