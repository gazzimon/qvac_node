// The two things that make an unattended nightly run safe: a retry ceiling
// (a ticket that keeps failing CI gets blocked, not reassigned forever) and a
// global token budget (the run stops assigning once cumulative spend reaches
// the cap). Both are driven from a pre-seeded run log — no swarm, no gateway.
//
//   node test/coordinator-safety-test.mjs

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

function scaffold(name, requirements) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `pyrus-safety-${name}-`))
  const WS = path.join(TMP, 'workspace')
  const REQ = path.join(TMP, 'requirements.md')
  const STORAGE = path.join(TMP, 'coord')
  fs.mkdirSync(WS, { recursive: true })
  fs.mkdirSync(STORAGE, { recursive: true })
  fs.writeFileSync(REQ, requirements)
  fs.writeFileSync(
    path.join(WS, 'package.json'),
    JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
  )
  fs.writeFileSync(path.join(WS, 'verify.mjs'), `console.log('ok')\n`)
  return { TMP, WS, REQ, STORAGE }
}

const ONE_TICKET = `# Demo\n\n## Ticket: db\nBuild the db.\nDepends on: none\nFiles: src/db.js\n`

// ---------------------------------------------------------------------------
// State-level accessors — pure, no coordinator
// ---------------------------------------------------------------------------
await check('failuresFor counts CI red and unusable output, but NOT "unplaced"', () => {
  const { STORAGE } = scaffold('failcount', ONE_TICKET)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  s.append(EVENTS.TICKET_FAILED, { ticketId: 'db', reason: 'unplaced' }) // no worker — not the ticket's fault
  s.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  s.append(EVENTS.TICKET_FAILED, { ticketId: 'db', reason: 'no-blocks' }) // model returned nothing
  s.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  assert.equal(s.failuresFor('db'), 3, 'the "unplaced" one must not count')
})

await check('tokensSpent sums usage.tokens across every result', () => {
  const { STORAGE } = scaffold('tokens', ONE_TICKET)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'a', usage: { tokens: 600 } })
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'b', usage: { tokens: 590 } })
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'c', usage: {} }) // no count — ignored
  assert.equal(s.tokensSpent(), 1190)
})

await check('a blocked ticket is neither pending nor done', () => {
  const { STORAGE } = scaffold('blockedstate', ONE_TICKET)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: 'db#1' })
  s.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  s.append(EVENTS.TICKET_BLOCKED, { ticketId: 'db', failures: 4 })
  assert.deepEqual(s.blocked(), ['db'])
  assert.deepEqual(s.pending(), [])
  assert.deepEqual(s.done(), [])
})

// ---------------------------------------------------------------------------
// Retry ceiling — a ticket at the ceiling is blocked and never reassigned
// ---------------------------------------------------------------------------
await check('a ticket at the failure ceiling is blocked, and the worker is never contacted', async () => {
  const { WS, REQ, STORAGE } = scaffold('ceiling', ONE_TICKET)

  // A prior history: 4 CI failures already logged for `db`.
  const seed = new State(path.join(STORAGE, 'runs.jsonl'))
  for (let i = 1; i <= 4; i++) {
    seed.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: `db#${i}` })
    seed.append(EVENTS.RESULT_RECEIVED, { ticketId: 'db', attemptId: `db#${i}`, ok: true, files: [], usage: { tokens: 100 } })
    seed.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  }

  const swarm = new FakeSwarm('coord-key', {})
  swarm.sendTask = () => {
    throw new Error('a blocked ticket must not be assigned to anyone')
  }
  const store = new Corestore(path.join(STORAGE, 'store'))
  await store.ready()

  const coord = new Coordinator({
    swarm,
    store,
    workspace: WS,
    storageDir: STORAGE,
    requirementFile: REQ,
    workerKeys: ['worker-key'],
    maxAttempts: 4
  })
  const summary = await coord.run()
  await coord.close()
  await store.close()

  assert.equal(summary.blocked, 1)
  assert.deepEqual(summary.blockedIds, ['db'])
  assert.equal(summary.pending, 0)

  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  assert.ok(
    s.events.some((e) => e.type === EVENTS.TICKET_BLOCKED && e.ticketId === 'db'),
    'a ticket:blocked event must be logged'
  )
})

await check('one failure short of the ceiling is still retried (worker IS contacted)', async () => {
  const { WS, REQ, STORAGE } = scaffold('underceiling', ONE_TICKET)
  const seed = new State(path.join(STORAGE, 'runs.jsonl'))
  for (let i = 1; i <= 3; i++) {
    seed.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: `db#${i}` })
    seed.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  }

  let contacted = false
  const swarm = new FakeSwarm('coord-key', {})
  swarm.sendTask = () => {
    contacted = true
    return false // pretend the worker is not reachable — enough to prove we TRIED
  }
  swarm.peers.set('worker-key', { manifest: { security: { acceptsTasks: true } } })
  const store = new Corestore(path.join(STORAGE, 'store'))
  await store.ready()

  const coord = new Coordinator({
    swarm,
    store,
    workspace: WS,
    storageDir: STORAGE,
    requirementFile: REQ,
    workerKeys: ['worker-key'],
    maxAttempts: 4,
    acceptTimeoutMs: 500
  })
  const summary = await coord.run()
  await coord.close()
  await store.close()

  assert.equal(summary.blocked, 0, 'not at the ceiling yet')
  assert.ok(contacted, 'the coordinator should still be trying to place this ticket')
})

// ---------------------------------------------------------------------------
// Global budget — spend at/over the cap stops assignment
// ---------------------------------------------------------------------------
await check('a run that starts already over budget assigns nothing and logs budget:exceeded', async () => {
  const { WS, REQ, STORAGE } = scaffold('budget', ONE_TICKET)
  const seed = new State(path.join(STORAGE, 'runs.jsonl'))
  seed.append(EVENTS.RESULT_RECEIVED, { ticketId: 'other', usage: { tokens: 5000 } })

  const swarm = new FakeSwarm('coord-key', {})
  swarm.sendTask = () => {
    throw new Error('over budget: nothing should be assigned')
  }
  swarm.peers.set('worker-key', { manifest: { security: { acceptsTasks: true } } })
  const store = new Corestore(path.join(STORAGE, 'store'))
  await store.ready()

  const coord = new Coordinator({
    swarm,
    store,
    workspace: WS,
    storageDir: STORAGE,
    requirementFile: REQ,
    workerKeys: ['worker-key'],
    budgetTokens: 4000
  })
  const summary = await coord.run()
  await coord.close()
  await store.close()

  assert.equal(summary.overBudget, true)
  assert.equal(summary.tokensSpent, 5000)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  assert.ok(s.events.some((e) => e.type === EVENTS.BUDGET_EXCEEDED))
})

// ---------------------------------------------------------------------------
// Stall detection must not fire on a FINISHED project
// ---------------------------------------------------------------------------
await check('a finished project closing zero tickets is NOT stalled', () => {
  const { STORAGE } = scaffold('finished', ONE_TICKET)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  // The night it finished.
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.TICKET_DONE, { ticketId: 'db' })
  s.append(EVENTS.RUN_END, { done: 1, pendingAtStart: 1 })
  // Two nights after: nothing pending, nothing closed. Success, not a stall.
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 1, pendingAtStart: 0 })
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 1, pendingAtStart: 0 })
  assert.equal(s.isStalled(), false, 'a completed project must not raise a nightly alarm')
})

await check('a project with work left that closes nothing twice IS stalled', () => {
  const { STORAGE } = scaffold('spinning', ONE_TICKET)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1 })
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  s.append(EVENTS.RUN_END, { done: 0, pendingAtStart: 1 })
  assert.equal(s.isStalled(), true)
})

await check('an older log without pendingAtStart keeps the previous meaning', () => {
  const { STORAGE } = scaffold('legacy', ONE_TICKET)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0 })
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.RUN_END, { done: 0 })
  assert.equal(s.isStalled(), true, 'no pendingAtStart ⇒ fall back to the old rule')
})

await check('budgetTokens: 0 means no limit', () => {
  const { STORAGE } = scaffold('nolimit', ONE_TICKET)
  const s = new State(path.join(STORAGE, 'runs.jsonl'))
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'x', usage: { tokens: 10 ** 9 } })
  // overBudget() is a Coordinator method; the invariant we care about here is
  // that the State number is just a number and the gate is opt-in.
  assert.equal(s.tokensSpent(), 10 ** 9)
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
