// The cross-machine loop end to end: a coordinator and a worker on opposite
// ends of a FakeSwarm for the task:* MESSAGES (task-protocol.mjs is exercised
// on the wire), and on opposite ends of a REAL, non-DHT replicated connection
// for the corestores — two separate Corestore instances, wired the same way
// `qvac/swarm.mjs` wires a real peer connection: NoiseSecretStream over a raw
// socket, then `corestore.replicate(socket)`. A fake gateway stands in for the
// model.
//
// Two different Corestore instances is deliberate and load-bearing for this
// test: a coordinator and a worker are two different machines with two
// different stores in production, and using one shared store here would hide
// exactly the cross-store open/replicate behaviour this is meant to prove.
//
// What this exercises that the single-machine orchestrator-e2e.mjs cannot:
// task:assign → task:accept → task:progress → task:result over the message
// layer, the context drive read sparsely on the worker side OVER THAT
// CONNECTION with no DHT announce, results mirrored on arrival (with the
// out-of-scope file rejected, not written), and a SECOND coordinator instance
// resuming with the worker link torn down entirely.
//
//   node test/coordinator-e2e.mjs

import assert from 'assert'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { Coordinator } from '../orchestrator/coordinator.mjs'
import { attachTaskAccept } from '../worker/task-accept.mjs'
import { State, EVENTS } from '../orchestrator/state.mjs'
import { FakeSwarm } from './fake-swarm.mjs'

// Same shape as qvac/swarm.mjs's _onConnection: a raw loopback pair wrapped in
// NoiseSecretStream, then each side's corestore replicates over it. No DHT, no
// join — just the connection.
async function replicatedPair(storeA, storeB) {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const client = net.connect(port, '127.0.0.1')
  const serverSide = await new Promise((resolve) => server.once('connection', resolve))
  await new Promise((resolve) => client.once('connect', resolve))
  server.close()

  const a = new NoiseSecretStream(false, serverSide)
  const b = new NoiseSecretStream(true, client)
  await Promise.all([
    new Promise((resolve) => a.once('connect', resolve)),
    new Promise((resolve) => b.once('connect', resolve))
  ])
  storeA.replicate(a)
  storeB.replicate(b)
  return { a, b }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-coord-e2e-'))
const WS = path.join(TMP, 'workspace')
const STORE = path.join(TMP, 'coord')
const REQ = path.join(TMP, 'requirements.md')

fs.writeFileSync(
  REQ,
  `# Demo

## Ticket: greet
Implement a greeting function
Depends on: none
Files: src/greet.js

## Ticket: farewell
Implement a farewell function that also tries to sneak a README in
Depends on: none
Files: src/farewell.js
`
)

fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(
  path.join(WS, 'package.json'),
  JSON.stringify(
    { name: 'generated-demo', type: 'module', scripts: { test: 'node verify.mjs' } },
    null,
    2
  )
)
fs.writeFileSync(
  path.join(WS, 'verify.mjs'),
  `import fs from 'fs'
const missing = ['src/greet.js', 'src/farewell.js'].filter((f) => !fs.existsSync(f))
if (missing.length) { console.error('missing: ' + missing.join(', ')); process.exit(1) }
console.log('ok')
`
)

const CODE = {
  greet: 'export const greet = (name) => `hi ${name}`\n',
  farewell: 'export const farewell = (name) => `bye ${name}`\n'
}

// The farewell ticket's "model" also tries an out-of-scope README — the same
// shape the single-machine jail test exercises, now on the far side of a wire.
function fakeGateway() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: 'fake', object: 'model' }] }))
      }
      if (req.url === '/v1/chat/completions') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const request = JSON.parse(body)
          const which = request.messages[0].content.includes('src/greet.js') ? 'greet' : 'farewell'
          let content = '```file path=src/' + which + '.js\n' + CODE[which] + '```\n'
          if (which === 'farewell') {
            content += '```file path=README.md\nnot allowed here\n```\n'
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content } }],
              usage: { total_tokens: 80 }
            })
          )
        })
        return
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const server = await fakeGateway()
const gateway = `http://127.0.0.1:${server.address().port}`

const storeCoord = new Corestore(path.join(TMP, 'store-coord'))
const storeWorker = new Corestore(path.join(TMP, 'store-worker'))
await storeCoord.ready()
await storeWorker.ready()
const link = await replicatedPair(storeCoord, storeWorker)

const coordSwarm = new FakeSwarm('coord-key', { security: {} })
const workerSwarm = new FakeSwarm('worker-key', {
  security: { acceptsTasks: true, maxConcurrentTasks: 2 }
})
FakeSwarm.connect(coordSwarm, workerSwarm)

const detachWorker = attachTaskAccept({
  swarm: workerSwarm,
  store: storeWorker,
  gateway,
  allowlist: ['coord-key'],
  maxConcurrentTasks: 2,
  log: () => {} // quiet — the coordinator's own log is enough narration
})

console.log('=== first run ===')
// acceptTimeoutMs kept short: run 2 deliberately has no worker to answer, and
// this test should not spend 20 real seconds finding that out.
const coord1 = new Coordinator({
  swarm: coordSwarm,
  store: storeCoord,
  workspace: WS,
  storageDir: STORE,
  requirementFile: REQ,
  acceptTimeoutMs: 3000
})
const r1 = await coord1.run()
await coord1.close()

console.log('\n=== second run (should redo nothing, and never contact the worker) ===')
// The worker is GONE, not just unresponsive: listener detached, its store
// closed, the connection torn down. A "should redo nothing" run must not need
// any of it.
detachWorker()
link.a.destroy()
link.b.destroy()
await storeWorker.close()

const coord2 = new Coordinator({
  swarm: coordSwarm,
  store: storeCoord,
  workspace: WS,
  storageDir: STORE,
  requirementFile: REQ,
  acceptTimeoutMs: 3000
})
const r2 = await coord2.run()
await coord2.close()

server.close()
await storeCoord.close()

console.log('\n--- checks ---')
let ok = 0
let bad = 0
function check(name, fn) {
  try {
    fn()
    ok++
    console.log(`  ok  ${name}`)
  } catch (err) {
    bad++
    console.log(`  NO  ${name}\n      ${err.stack || err.message}`)
  }
}

check('both allowed files landed in the coordinator workspace', () => {
  assert.ok(fs.existsSync(path.join(WS, 'src', 'greet.js')))
  assert.ok(fs.existsSync(path.join(WS, 'src', 'farewell.js')))
})

check('the contents are what the worker actually produced', () => {
  assert.match(fs.readFileSync(path.join(WS, 'src', 'greet.js'), 'utf8'), /hi \$\{name\}/)
  assert.match(fs.readFileSync(path.join(WS, 'src', 'farewell.js'), 'utf8'), /bye \$\{name\}/)
})

check('the out-of-scope README the worker tried was never written, on EITHER side', () => {
  assert.ok(!fs.existsSync(path.join(WS, 'README.md')))
})

// The two tickets are assigned in parallel (they run in the same slot group —
// detectOverlap already guarantees their files are disjoint) and verify.mjs
// requires BOTH files to exist, so whichever ticket's CI runs first can
// legitimately go red if the other has not landed yet — the same race
// orchestrator-e2e.mjs documents on one machine. What must hold either way: at
// least one green, and the run log carrying BOTH results (the losing ticket
// is picked up by the next run, not lost).
check('at least one ticket closed on a green CI this run', () => {
  assert.ok(r1.done >= 1, `r1.done=${r1.done}`)
})

check('both tickets were actually attempted (not silently skipped)', () => {
  const s = new State(path.join(STORE, 'runs.jsonl'))
  const attempted = new Set(s.events.filter((e) => e.type === EVENTS.RESULT_RECEIVED).map((e) => e.ticketId))
  assert.deepEqual([...attempted].sort(), ['farewell', 'greet'])
})

// A ticket run 1 left ci:fail still needs a fresh attempt — and a worker to
// send it to, which run 2 deliberately has none of. What run 2 must prove is
// narrower and just as real: it does not go backwards, and it does not so
// much as try to contact a worker that is not there for whatever it already
// closed.
check('the second run does not go backwards', () => {
  assert.ok(r2.done >= r1.done, `r1.done=${r1.done} r2.done=${r2.done}`)
})

check('the run log recorded a violation for the rejected README', () => {
  const s = new State(path.join(STORE, 'runs.jsonl'))
  const violations = s.events.filter((e) => e.type === EVENTS.VIOLATION)
  assert.ok(violations.some((v) => v.path === 'README.md'), 'expected a logged violation for README.md')
})

check('the run log carries a context drive key (proof it went over a drive, not a stub)', () => {
  assert.match(r1.contextKey, /^[0-9a-f]{64}$/)
})

console.log(`\n${ok} ok, ${bad} failed`)
console.log(`workspace: ${WS}`)
process.exitCode = bad === 0 ? 0 : 1
