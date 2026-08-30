// `Depends on:` across machines: a ticket in wave 2 must not be assigned
// before the wave-1 ticket it depends on has been mirrored, and once it is
// assigned it has to be able to actually READ the file wave 1 just wrote —
// which means the context drive has to be re-published between waves, not
// just published once at the top of the run.
//
//   node test/coordinator-dependency-test.mjs

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-coord-dep-'))
const WS = path.join(TMP, 'workspace')
const REQ = path.join(TMP, 'requirements.md')
fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(
  REQ,
  `# Demo

## Ticket: base
Export a constant.
Depends on: none
Files: src/base.js

## Ticket: derived
Export a constant that reads the base module. Only assignable once base is done.
Depends on: base
Files: src/derived.js
`
)
fs.writeFileSync(
  path.join(WS, 'package.json'),
  JSON.stringify({ name: 'demo-dep', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
)
fs.writeFileSync(
  path.join(WS, 'verify.mjs'),
  `import fs from 'fs'\nif (!fs.existsSync('src/base.js')) process.exit(1)\nconsole.log('ok')\n`
)

// Whichever ticket the "model" is answering for, it reports back what IT saw
// in the context drive under src/base.js — the derived worker's context read
// is what proves wave-2 saw wave-1's actual output, not just its timing.
let sawInContext = null
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
          const isDerived = request.messages[0].content.includes('src/derived.js')
          if (isDerived) {
            // Only one context file is sent here, so it runs to the end of the
            // message — no closing "---" to anchor on.
            const m = request.messages[1].content.match(/--- src\/base\.js ---\n([\s\S]*)/)
            sawInContext = m ? m[1].trim() : null
          }
          const content = isDerived
            ? '```file path=src/derived.js\nexport const derived = 2\n```'
            : '```file path=src/base.js\nexport const base = 1\n```'
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content } }],
              usage: { total_tokens: 50 }
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
const workerSwarm = new FakeSwarm('worker-key', { security: { acceptsTasks: true, maxConcurrentTasks: 2 } })
FakeSwarm.connect(coordSwarm, workerSwarm)

const detachWorker = attachTaskAccept({
  swarm: workerSwarm,
  store: storeWorker,
  gateway,
  allowlist: ['coord-key'],
  maxConcurrentTasks: 2,
  log: () => {}
})

const coord = new Coordinator({
  swarm: coordSwarm,
  store: storeCoord,
  workspace: WS,
  storageDir: path.join(TMP, 'coord'),
  requirementFile: REQ,
  acceptTimeoutMs: 5000
})

// No manual contextPaths here on purpose: `derived` declares `Depends on:
// base`, and Coordinator.init() derives contextPaths for a ticket from its
// declared dependencies' allowedFiles by default — this is what proves that
// default actually works, not a hand-fed hint standing in for it.
const summary = await coord.run()
await coord.close()
detachWorker()
link.a.destroy()
link.b.destroy()
await storeCoord.close()
await storeWorker.close()
server.close()

console.log('summary:', summary)

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

check('both tickets closed', () => {
  assert.equal(summary.done, 2, `done=${summary.done}`)
})

check('the run log shows base assigned strictly before derived', () => {
  const s = new State(path.join(TMP, 'coord', 'runs.jsonl'))
  const assigns = s.events.filter((e) => e.type === EVENTS.TICKET_ASSIGNED)
  const baseIdx = assigns.findIndex((e) => e.ticketId === 'base')
  const derivedIdx = assigns.findIndex((e) => e.ticketId === 'derived')
  assert.ok(baseIdx !== -1 && derivedIdx !== -1, 'both tickets must have been assigned')
  assert.ok(baseIdx < derivedIdx, `expected base (${baseIdx}) before derived (${derivedIdx})`)
})

check('the run log shows two separate waves', () => {
  // Not a log event by itself — inferred from the ordering check above plus
  // the fact that derived's assignment could only follow a mirror of base,
  // which requires base's own result to already be logged.
  const s = new State(path.join(TMP, 'coord', 'runs.jsonl'))
  const results = s.events.filter((e) => e.type === EVENTS.RESULT_RECEIVED)
  const baseResultIdx = results.findIndex((e) => e.ticketId === 'base')
  const derivedAssignIdx = s.events.findIndex(
    (e) => e.type === EVENTS.TICKET_ASSIGNED && e.ticketId === 'derived'
  )
  const baseResultEventIdx = s.events.indexOf(results[baseResultIdx])
  assert.ok(
    baseResultEventIdx < derivedAssignIdx,
    'derived must be assigned only after base delivered a result'
  )
})

check("derived's worker actually read base's file THROUGH THE CONTEXT DRIVE, post-wave-1 content", () => {
  assert.equal(sawInContext, 'export const base = 1')
})

check('both files exist with the right contents', () => {
  assert.equal(fs.readFileSync(path.join(WS, 'src', 'base.js'), 'utf8').trim(), 'export const base = 1')
  assert.equal(
    fs.readFileSync(path.join(WS, 'src', 'derived.js'), 'utf8').trim(),
    'export const derived = 2'
  )
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
