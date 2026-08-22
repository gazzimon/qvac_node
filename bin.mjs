import { command, flag, summary } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import pkg from './package.json'
import App from './app.js'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--update-delay <ms>', 'ventana de jitter del OTA en ms (default 10000)')
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))
if (cmd.flags.help) Bare.exit()
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

const updates = cmd.flags.updates

// Ventana de jitter del updater. El default de pear-runtime-updater es UNA HORA
// (`_defaultDelay = 3_600_000`), y solo se ignora si la version nueva aparece
// dentro de los primeros 60s de vida del proceso (`_bootGracePeriod`). Pasado
// ese minuto, el update se agenda en un punto aleatorio de la ventana.
//
// Ese default es correcto para una flota grande —evita que miles de nodos se
// actualicen a la vez— y es inservible acá: el OTA en vivo es el pitch, y con
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
console.log(`  runtime  : ${isDev ? 'bare (dev)' : 'pear (installed)'}`)
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
  console.log('CLI listo. Ctrl+C para salir.\n')
} catch (err) {
  console.error('[app:error]', err)
  await app.close().finally(() => Bare.exit(1))
}
