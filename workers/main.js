// QVAC-Node's OTA updater worker.
//
// A fork of `hello-pear-worker` (https://github.com/holepunchto/hello-pear-worker),
// which used to be pulled in as-is via a `require`. It was brought into the
// repo for three changes that can't be made from outside the package; they
// are marked below with "CHANGE".
//
// Runs in its own worker thread, separate from the thread serving the user:
// the updater downloads tens of MB and writes a binary to disk, and that
// can't compete with `serve`/`gateway`'s token streaming.

const PearRuntime = require('pear-runtime')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const { isBareKit } = require('which-runtime')

// On mobile the worker's argv carries neither the executable nor the entrypoint.
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

// CHANGE 4 — configurable jitter window.
//
// pear-runtime-updater schedules the update at a RANDOM point within a
// window that defaults to one hour, and only applies it instantly if the new
// version shows up within the process's first 60s of life. Past that minute,
// publishing a version isn't visible. That default protects a large fleet
// from updating all at once; here, live OTA is the whole pitch.
// `opts.delay` is only honored if it's an integer: anything else silently
// falls back to the one-hour default, so it's validated before being passed
// along.
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

// CHANGE 1 — the installed node also SERVES, not just downloads.
//
// Upstream joins the swarm with `server: false`, which turns every installed
// copy into a pure leecher: it pulls updates and serves nobody. That leaves
// the machine's own `pear seed` as the only source of the binary on the
// whole network — a single point of failure, and also the negation of the
// project's own pitch ("the network distributes its own client across the
// network": with server:false the network doesn't distribute it, one single
// machine does).
//
// With server:true every node reseeds the blocks it already has.
// Hyperswarm's default is precisely server:true; this restores that default
// on purpose.
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

// CHANGE 2 — forward the download progress.
//
// `pear-runtime-updater` emits `updating-progress` with bytes, speed,
// percentage and peer count, but upstream never writes it to the pipe, so
// the main process has nothing to show. Without this, there are ~10 seconds
// of dead screen between "downloading" and "download complete" — exactly
// the moment the judges are watching during the OTA demo.
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

// CHANGE 3 — updater errors reach the main process.
//
// Upstream does `pear.updater.on('error', console.error)`: the error stays
// in the worker and the main process's `app.on('error')` never finds out.
// A failed OTA ends up looking exactly like an OTA that never started.
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
