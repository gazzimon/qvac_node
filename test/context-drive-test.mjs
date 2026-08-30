// Proves the F1 claim directly: a Hyperdrive replicates over a connection two
// nodes already hold, with NO DHT announce and NO swarm.join. This test never
// touches Hyperswarm — it wires two corestores over a plain TCP loopback pair,
// the same shape a real Protomux/NoiseSecretStream connection has once the
// handshake is done, and lets `corestore.replicate()` do what it already does
// for chat + directory replication in qvac/swarm.mjs.
//
//   node test/context-drive-test.mjs

import assert from 'assert'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
// The encryption layer Hyperswarm hands `_onConnection` a socket of, with none
// of Hyperswarm's DHT bootstrapping. Wrapping the raw TCP pair in it is what
// makes `corestore.replicate()` accept the socket (it looks for
// `socket.noiseStream`) — and it is what makes this test honest: the two sides
// go through a real Noise handshake, same as a real peer connection, and
// still never touch the DHT.
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { publishContext, openContext, updateContext } from '../orchestrator/context-drive.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-ctxdrive-'))

// Two sides of ONE already-established connection — no discovery involved,
// exactly the state the coordinator and worker are in once they are peers.
async function connectedPair() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const client = net.connect(port, '127.0.0.1')
  const serverSide = await new Promise((resolve) => server.once('connection', resolve))
  await new Promise((resolve) => client.once('connect', resolve))
  server.close() // no more listening needed once the one pair exists

  const a = new NoiseSecretStream(false, serverSide)
  const b = new NoiseSecretStream(true, client)
  await Promise.all([
    new Promise((resolve) => a.once('connect', resolve)),
    new Promise((resolve) => b.once('connect', resolve))
  ])
  return { a, b }
}

const { a: socketCoordinator, b: socketWorker } = await connectedPair()

const storeCoordinator = new Corestore(path.join(TMP, 'coordinator'))
const storeWorker = new Corestore(path.join(TMP, 'worker'))
await storeCoordinator.ready()
await storeWorker.ready()

// The replication corestore.mjs's header describes: one call per socket, and
// everything in that store's namespace is servable to whoever asks by
// discovery-key. No topic, no join — this IS what makes F1 true.
storeCoordinator.replicate(socketCoordinator)
storeWorker.replicate(socketWorker)

let ok = 0
let bad = 0
async function check(name, fn) {
  try {
    await fn()
    ok++
    console.log(`  ok  ${name}`)
  } catch (err) {
    bad++
    console.log(`  NO  ${name}\n      ${err.stack || err.message}`)
  }
}

const workspace = path.join(TMP, 'workspace')
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'src', 'db.js'), 'export const db = 1\n')
fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n')

const { drive, key } = await publishContext(storeCoordinator, workspace)

let ctx
await check('a freshly-published drive opens on the OTHER side with no swarm at all', async () => {
  ctx = await openContext(storeWorker, key, { timeoutMs: 10000 })
  assert.equal(ctx.key, key)
})

await check('a sparse read pulls exactly the requested file, correct bytes', async () => {
  const buf = await ctx.readFile('src/db.js')
  assert.equal(buf.toString('utf8'), 'export const db = 1\n')
})

await check('list() sees the whole published tree', async () => {
  const entries = await ctx.list('/')
  const paths = entries.map((e) => e.path).sort()
  assert.deepEqual(paths, ['/README.md', '/src/db.js'])
})

await check('a path never published fails cleanly, not silently', async () => {
  await assert.rejects(() => ctx.readFile('src/missing.js'), /has no/)
})

// Regression for the deadlock this module used to have: two overlapping
// `openContext` calls for the SAME key on the SAME store — a worker running
// two tickets that share one context drive — used to hang forever inside
// Hyperdrive's own open path with `ctx` still open. It never threw, so a naive
// `assert.rejects` would hang too; racing a short timer is what actually
// proves it resolved instead of stalling.
await check('opening the same key twice while the first is still open does not deadlock', async () => {
  const stall = new Promise((resolve) => {
    const t = setTimeout(() => resolve('STALLED'), 5000)
    if (t.unref) t.unref()
  })
  const second = openContext(storeWorker, key, { timeoutMs: 10000 }).then((r) => ({ reader: r }))
  const outcome = await Promise.race([second, stall])
  assert.notEqual(outcome, 'STALLED', 'the second open must resolve, not hang')
  await outcome.reader.close()
})

// Closed, then reopened — the realistic path: a worker mounts once per
// assignment (task-accept.mjs) and closes when it is done; a LATER assignment
// against a republished context opens fresh. `openContext` shares one
// underlying reader across CONCURRENT callers of the same key (the fix for the
// deadlock below), so this only sees the new bytes once the first caller has
// actually released it.
await check('a later change to the workspace is visible after the old reader closes', async () => {
  await ctx.close()

  fs.writeFileSync(path.join(workspace, 'src', 'db.js'), 'export const db = 2\n')
  const changed = await updateContext(drive, workspace)
  assert.equal(changed, 1, 'only the one changed file should be re-put')

  const ctx2 = await openContext(storeWorker, key, { timeoutMs: 10000 })
  const buf = await ctx2.readFile('src/db.js')
  assert.equal(buf.toString('utf8'), 'export const db = 2\n')
  await ctx2.close()
})

await ctx.close()
await drive.close()
await storeCoordinator.close()
await storeWorker.close()
socketCoordinator.destroy()
socketWorker.destroy()

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
