// Two properties the protocol document promises and coordinator-e2e.mjs does
// not exercise directly, because they need control the happy path does not
// give you:
//
//   1. A message for a SUPERSEDED attempt is discarded, never accepted —
//      the race in docs/factory-protocol.html "The case that forces it".
//   2. A coordinator that starts up with a result already logged from a prior
//      run resumes from the log — no reassignment, no worker contacted.
//
//   node test/coordinator-idempotency-test.mjs

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
import { Coordinator } from '../orchestrator/coordinator.mjs'
import { State, EVENTS } from '../orchestrator/state.mjs'
import { hashContent } from '../orchestrator/hash.mjs'
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
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `pyrus-idem-${name}-`))
  const WS = path.join(TMP, 'workspace')
  const REQ = path.join(TMP, 'requirements.md')
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(
    REQ,
    `# Demo\n\n## Ticket: greet\nImplement a greeting function\nDepends on: none\nFiles: src/greet.js\n`
  )
  fs.writeFileSync(
    path.join(WS, 'package.json'),
    JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
  )
  fs.writeFileSync(
    path.join(WS, 'verify.mjs'),
    `import fs from 'fs'\nif (!fs.existsSync('src/greet.js')) process.exit(1)\nconsole.log('ok')\n`
  )
  return { TMP, WS, REQ }
}

// -----------------------------------------------------------------------------
await check('a result for a superseded attempt is discarded, not accepted', async () => {
  const { TMP, WS, REQ } = scaffold('stale')
  const store = new Corestore(path.join(TMP, 'store'))
  await store.ready()
  const swarm = new FakeSwarm('coord-key', {})

  const coord = new Coordinator({
    swarm,
    store,
    workspace: WS,
    storageDir: path.join(TMP, 'coord'),
    requirementFile: REQ
  })
  await coord.init()

  const ticket = coord.tickets.find((t) => t.id === 'greet')

  // B was assigned, went silent, and the coordinator moved on to a fresh
  // attempt for C — exactly what assignOnce() does internally when a worker
  // times out. Simulated directly here instead of waiting out a real timeout.
  coord.live.set('greet', 'greet#current')

  let discardLogged = false
  const realLog = coord.log.bind(coord)
  coord.log = (m) => {
    if (m.includes('discarded')) discardLogged = true
    realLog(m)
  }

  // B's late delivery, carrying the DEAD attemptId.
  const content = 'export const greet = () => "late"\n'
  coord._onTaskMessage(
    { key: 'worker-B' },
    {
      type: 'task:result',
      protocol: 'qvac/task/v0',
      attemptId: 'greet#stale-from-B',
      ok: true,
      files: [{ path: 'src/greet.js', hash: hashContent(content), bytes: content.length, content }],
      rejected: [],
      usage: {}
    }
  )

  assert.ok(discardLogged, 'the stale delivery must be logged as discarded')
  assert.ok(
    !fs.existsSync(path.join(WS, 'src', 'greet.js')),
    'a discarded result must never reach the workspace'
  )

  await coord.close()
  await store.close()
})

// -----------------------------------------------------------------------------
await check('the live attempt IS accepted through the same path', async () => {
  const { TMP, WS, REQ } = scaffold('live')
  const store = new Corestore(path.join(TMP, 'store'))
  await store.ready()
  const swarm = new FakeSwarm('coord-key', {})

  const coord = new Coordinator({
    swarm,
    store,
    workspace: WS,
    storageDir: path.join(TMP, 'coord'),
    requirementFile: REQ
  })
  await coord.init()

  // Only the routing/idempotency logic is under test here — delivery itself
  // (a real FakeSwarm.connect pair) is what coordinator-e2e.mjs exercises.
  swarm.sendTask = () => true

  const ticket = coord.tickets.find((t) => t.id === 'greet')
  const pending = coord.assignOnce(ticket, { key: 'worker-C' })
  const attemptId = coord.live.get('greet') // minted synchronously inside assignOnce

  coord._onTaskMessage({ key: 'worker-C' }, { type: 'task:accept', protocol: 'qvac/task/v0', attemptId, accepted: true })

  const content = 'export const greet = () => "on time"\n'
  coord._onTaskMessage(
    { key: 'worker-C' },
    {
      type: 'task:result',
      protocol: 'qvac/task/v0',
      attemptId,
      ok: true,
      files: [{ path: 'src/greet.js', hash: hashContent(content), bytes: content.length, content }],
      rejected: [],
      usage: {}
    }
  )

  const result = await pending
  assert.equal(result.attemptId, attemptId)

  await coord.close()
  await store.close()
})

// -----------------------------------------------------------------------------
await check('a coordinator restarted with an unclosed result resumes without any worker', async () => {
  const { TMP, WS, REQ } = scaffold('resume')
  const storageDir = path.join(TMP, 'coord')
  fs.mkdirSync(storageDir, { recursive: true })

  // A prior "process": logs RESULT_RECEIVED and then dies before the mirror.
  const priorLog = new State(path.join(storageDir, 'runs.jsonl'))
  const content = 'export const greet = () => "resumed"\n'
  priorLog.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'greet', attemptId: 'greet#1' })
  priorLog.append(EVENTS.RESULT_RECEIVED, {
    ticketId: 'greet',
    attemptId: 'greet#1',
    ok: true,
    files: [{ path: 'src/greet.js', hash: hashContent(content), bytes: content.length, content }],
    rejected: [],
    usage: {}
  })
  assert.deepEqual(priorLog.done(), [], 'sanity: the prior run really did not close the ticket')

  // A swarm that throws if the coordinator so much as tries to use it — the
  // hard version of "never contacts the worker".
  const swarm = new FakeSwarm('coord-key', {})
  swarm.sendTask = () => {
    throw new Error('resume() must not need a worker at all')
  }
  const store = new Corestore(path.join(TMP, 'store'))
  await store.ready()

  const coord = new Coordinator({ swarm, store, workspace: WS, storageDir, requirementFile: REQ })
  const summary = await coord.run()

  assert.equal(summary.done, 1, 'the ticket should have closed from the resumed result alone')
  assert.equal(
    fs.readFileSync(path.join(WS, 'src', 'greet.js'), 'utf8'),
    content,
    'the bytes came from the LOGGED result, not a fresh inference'
  )

  await coord.close()
  await store.close()
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
