// Worker del updater OTA de QVAC-Node.
//
// Es un fork de `hello-pear-worker` (https://github.com/holepunchto/hello-pear-worker),
// que antes se usaba tal cual con un `require`. Se trajo al repo por tres
// cambios que no se pueden hacer desde afuera del paquete; estan marcados
// abajo con "CAMBIO".
//
// Corre en un worker thread propio, separado del hilo que atiende al usuario:
// el updater descarga decenas de MB y escribe un binario a disco, y eso no
// puede competir con el streaming de tokens de `serve`/`gateway`.

const PearRuntime = require('pear-runtime')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const { isBareKit } = require('which-runtime')

// En mobile el argv del worker no trae ni el ejecutable ni el entrypoint.
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

// CAMBIO 4 — ventana de jitter configurable.
//
// pear-runtime-updater agenda el update en un punto ALEATORIO de una ventana
// que por default es de una hora, y solo lo aplica al instante si la version
// nueva aparece dentro de los primeros 60s de vida del proceso. Pasado ese
// minuto, publicar una version no se ve. Ese default protege a una flota
// grande de actualizarse toda junta; acá el OTA en vivo es el pitch.
// `opts.delay` solo se respeta si es un entero: cualquier otra cosa cae al
// default de una hora en silencio, asi que se valida antes de pasarlo.
const delay = Number(argv(6))

const updaterConfig = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4) || dir.persistent(),
  app: argv(5),
  delay: Number.isInteger(delay) ? delay : 10000
}

const pipe = new FramedStream(Bare.IPC)
const store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime', 'corestore'))
const swarm = new Hyperswarm()
const pear = new PearRuntime({ ...updaterConfig, swarm, store })

// CAMBIO 1 — el nodo instalado tambien SIRVE, no solo descarga.
//
// El upstream une al swarm con `server: false`, que convierte a cada copia
// instalada en pura sanguijuela: baja updates y no le sirve a nadie. Con eso,
// la unica fuente del binario en toda la red es el `pear seed` de la maquina
// que publica — un punto unico de falla, y ademas la negacion del pitch del
// proyecto ("la red distribuye su propio cliente por la red": con server:false
// no distribuye la red, distribuye una sola maquina).
//
// Con server:true cada nodo reseedea los bloques que ya tiene. El default de
// Hyperswarm es justamente server:true; esto vuelve al default a proposito.
if (updaterConfig.updates !== false) {
  swarm.on('connection', (connection) => store.replicate(connection))
  swarm.join(pear.updater.drive.core.discoveryKey, {
    client: true,
    server: true
  })
}

console.log('Application storage:', pear.storage)

pear.updater.on('updating', () => pipe.write('updating'))
pear.updater.on('updated', () => pipe.write('updated'))
pear.on('minver-required', () => pipe.write('minver-required'))

// CAMBIO 2 — reenviar el progreso de descarga.
//
// `pear-runtime-updater` emite `updating-progress` con bytes, velocidad,
// porcentaje y cantidad de peers, pero el upstream nunca lo escribe al pipe,
// asi que el proceso principal no puede mostrar nada. Sin esto, entre
// "bajando" y "descarga completa" hay ~10 segundos de pantalla muerta, que
// son justo los que el jurado mira durante la demo del OTA.
pear.updater.on('updating-progress', (stats) => {
  if (!stats || !stats.download) return
  pipe.write(
    'progress:' +
      JSON.stringify({
        bytes: stats.download.bytes,
        speed: stats.download.speed,
        progress: stats.download.progress,
        peers: stats.peers
      })
  )
})

// CAMBIO 3 — los errores del updater llegan al proceso principal.
//
// El upstream hace `pear.updater.on('error', console.error)`: el error queda
// en el worker y el `app.on('error')` del proceso principal nunca se entera.
// Un OTA que falla termina viendose igual que un OTA que no arranco.
pear.updater.on('error', (err) => {
  pipe.write('updater-error:' + (err && err.message ? err.message : String(err)))
})

goodbye(async () => {
  await swarm.destroy()
  await pear.close()
  await store.close()
})

pipe.on('data', async (data) => {
  const message = data.toString()
  if (message === 'pear:applyUpdate') {
    await pear.ready()
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
  } else console.log(message)
})

pipe.write('Hello from worker')
