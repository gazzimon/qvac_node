// The discovery gate: the coordinator must not read `swarm.peers` the instant
// it starts and conclude nobody is there.
//
// This is the measured failure, not a hypothetical: NOTES.md records 4–7s with
// a warm directory, a 38s tail on loopback, and 109s for a cold node — and the
// fiui demo needed FOUR coordinator invocations before one of them happened to
// look after a worker had appeared.
//
//   node test/coordinator-discovery-test.mjs

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
import { Coordinator } from '../orchestrator/coordinator.mjs'
import { State, EVENTS } from '../orchestrator/state.mjs'
import { FakeSwarm } from './fake-swarm.mjs'

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

function scaffold(name) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `pyrus-disc-${name}-`))
  const WS = path.join(TMP, 'workspace')
  const REQ = path.join(TMP, 'requirements.md')
  const STORAGE = path.join(TMP, 'coord')
  fs.mkdirSync(WS, { recursive: true })
  fs.mkdirSync(STORAGE, { recursive: true })
  fs.writeFileSync(REQ, `# D\n\n## Ticket: db\nBuild it.\nDepends on: none\nFiles: src/db.js\n`)
  fs.writeFileSync(
    path.join(WS, 'package.json'),
    JSON.stringify({ name: 'd', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
  )
  fs.writeFileSync(path.join(WS, 'verify.mjs'), `console.log('ok')\n`)
  return { TMP, WS, REQ, STORAGE }
}

async function makeCoord(sc, swarm, extra = {}) {
  const store = new Corestore(path.join(sc.STORAGE, 'store'))
  await store.ready()
  const coord = new Coordinator({
    swarm,
    store,
    workspace: sc.WS,
    storageDir: sc.STORAGE,
    requirementFile: sc.REQ,
    workerKeys: ['worker-key'],
    workerPollMs: 20,
    ...extra
  })
  return { coord, store }
}

// ---------------------------------------------------------------------------
await check('awaitWorkers returns immediately when a worker is already there', async () => {
  const sc = scaffold('present')
  const swarm = new FakeSwarm('coord-key', {})
  swarm.peers.set('worker-key', { manifest: { security: { acceptsTasks: true } } })
  const { coord, store } = await makeCoord(sc, swarm, { waitForWorkersMs: 5000 })
  await coord.init()

  const t0 = Date.now()
  const pool = await coord.awaitWorkers()
  const elapsed = Date.now() - t0

  assert.equal(pool.length, 1)
  assert.ok(elapsed < 200, `should not have waited at all, took ${elapsed}ms`)
  await coord.close()
  await store.close()
})

await check('awaitWorkers resolves as soon as a worker appears LATE', async () => {
  const sc = scaffold('late')
  const swarm = new FakeSwarm('coord-key', {})
  const { coord, store } = await makeCoord(sc, swarm, { waitForWorkersMs: 5000 })
  await coord.init()

  // The peer shows up 300ms in — the shape of real discovery, compressed.
  const t = setTimeout(() => {
    swarm.peers.set('worker-key', { manifest: { security: { acceptsTasks: true } } })
  }, 300)

  const t0 = Date.now()
  const pool = await coord.awaitWorkers()
  const elapsed = Date.now() - t0

  assert.equal(pool.length, 1, 'the late worker must be picked up')
  assert.ok(elapsed >= 250, `should have actually waited, took ${elapsed}ms`)
  assert.ok(elapsed < 3000, `should not have waited the whole timeout, took ${elapsed}ms`)
  await coord.close()
  await store.close()
})

await check('awaitWorkers gives up after the timeout and returns what it has', async () => {
  const sc = scaffold('timeout')
  const swarm = new FakeSwarm('coord-key', {})
  const { coord, store } = await makeCoord(sc, swarm, { waitForWorkersMs: 400 })
  await coord.init()

  const pool = await coord.awaitWorkers()
  assert.deepEqual(pool, [])
  await coord.close()
  await store.close()
})

// ---------------------------------------------------------------------------
// The behaviour that matters: what a whole run does when nobody shows up
// ---------------------------------------------------------------------------
await check('a run with no workers leaves the tickets UNTOUCHED — no failures logged', async () => {
  const sc = scaffold('untouched')
  const swarm = new FakeSwarm('coord-key', {})
  swarm.sendTask = () => {
    throw new Error('nothing may be assigned when no worker was found')
  }
  const { coord, store } = await makeCoord(sc, swarm, { waitForWorkersMs: 300 })

  const summary = await coord.run()
  await coord.close()
  await store.close()

  assert.equal(summary.noWorkers, true)
  assert.equal(summary.done, 0)
  assert.equal(summary.blocked, 0)
  assert.equal(summary.pending, 1, 'the ticket is still pending, not failed')

  const s = new State(path.join(sc.STORAGE, 'runs.jsonl'))
  assert.equal(
    s.events.filter((e) => e.type === EVENTS.TICKET_FAILED).length,
    0,
    'a night with no fleet must not mark the ticket as failed'
  )
  assert.equal(
    s.events.filter((e) => e.type === EVENTS.TICKET_ASSIGNED).length,
    0,
    'nothing should even have been assigned'
  )
})

await check('a no-worker run does NOT count toward the retry ceiling', async () => {
  const sc = scaffold('ceiling')
  const swarm = new FakeSwarm('coord-key', {})
  const { coord, store } = await makeCoord(sc, swarm, { waitForWorkersMs: 200 })
  await coord.run()
  await coord.close()
  await store.close()

  const s = new State(path.join(sc.STORAGE, 'runs.jsonl'))
  assert.equal(s.failuresFor('db'), 0, 'the fleet being down is not the ticket failing')
})

await check('two no-worker nights in a row do NOT read as stalled', () => {
  const sc = scaffold('notstalled')
  const s = new State(path.join(sc.STORAGE, 'runs.jsonl'))
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1, noWorkers: true })
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1, noWorkers: true })
  assert.equal(s.isStalled(), false, 'the fleet was down; the tickets are not stuck')
})

await check('two nights that DID try and closed nothing still read as stalled', () => {
  const sc = scaffold('stalled')
  const s = new State(path.join(sc.STORAGE, 'runs.jsonl'))
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1, noWorkers: false })
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1, noWorkers: false })
  assert.equal(s.isStalled(), true)
})

await check('a no-worker night between two real failures does not hide the stall', () => {
  const sc = scaffold('interleaved')
  const s = new State(path.join(sc.STORAGE, 'runs.jsonl'))
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1, noWorkers: false })
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1, noWorkers: true }) // fleet down
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1, noWorkers: false })
  assert.equal(s.isStalled(), true, 'the two runs that tried both closed nothing')
})

// ---------------------------------------------------------------------------
await check('the gate lets a run proceed normally once the worker arrives late', async () => {
  const sc = scaffold('proceeds')
  const swarm = new FakeSwarm('coord-key', {})
  let assigned = false
  swarm.sendTask = () => {
    assigned = true
    return false // enough to prove placement was attempted
  }
  const { coord, store } = await makeCoord(sc, swarm, {
    waitForWorkersMs: 5000,
    acceptTimeoutMs: 300
  })

  const t = setTimeout(() => {
    swarm.peers.set('worker-key', { manifest: { security: { acceptsTasks: true } } })
  }, 250)

  const summary = await coord.run()
  await coord.close()
  await store.close()

  assert.equal(summary.noWorkers, false, 'the worker did arrive')
  assert.ok(assigned, 'the run should have gone on to actually place the ticket')
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
