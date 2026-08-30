// A project that GROWS: a ticket in a later wave editing a file an earlier
// ticket created. This is what turns the factory from "accumulate new files"
// into "build a system over a week".
//
// No diffs anywhere — the repo already measured that whole files beat diffs
// (see parseBlocks in worker/run.mjs). What changed is that a ticket may now
// declare a file a DEPENDENCY owns, receive its current content, and return
// the whole updated file. Two tickets sharing a file with no dependency
// between them is still an abort.
//
//   node test/coordinator-edit-test.mjs

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
import { detectConcurrentOverlap, inheritedFiles, dependsOn } from '../orchestrator/split.mjs'
import { clearDeclaredPaths } from '../orchestrator/mirror.mjs'
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

const t = (id, deps, files) => ({ id, deps, allowedFiles: files, spec: `build ${id}` })

// ---------------------------------------------------------------------------
// The overlap rule, pure
// ---------------------------------------------------------------------------
await check('a shared file is ALLOWED when one ticket depends on the other', () => {
  const tickets = [t('db', [], ['src/db.js']), t('api', ['db'], ['src/db.js', 'src/api.js'])]
  assert.deepEqual(detectConcurrentOverlap(tickets), [])
})

await check('a shared file is REJECTED when the two could run at the same time', () => {
  const tickets = [t('a', [], ['src/shared.js']), t('b', [], ['src/shared.js'])]
  const clashes = detectConcurrentOverlap(tickets)
  assert.equal(clashes.length, 1)
  assert.equal(clashes[0].file, 'src/shared.js')
})

await check('a shared file is allowed across a TRANSITIVE dependency', () => {
  const tickets = [
    t('a', [], ['src/x.js']),
    t('b', ['a'], ['src/b.js']),
    t('c', ['b'], ['src/x.js'])
  ]
  assert.deepEqual(detectConcurrentOverlap(tickets), [])
  assert.equal(dependsOn(tickets, 'c', 'a'), true)
  assert.equal(dependsOn(tickets, 'a', 'c'), false)
})

await check('inheritedFiles returns only what a dependency actually owns', () => {
  const tickets = [
    t('db', [], ['src/db.js']),
    t('api', ['db'], ['src/db.js', 'src/api.js']),
    t('solo', [], ['src/solo.js'])
  ]
  assert.deepEqual(inheritedFiles(tickets, tickets[1]), ['src/db.js'])
  assert.deepEqual(inheritedFiles(tickets, tickets[0]), [])
  assert.deepEqual(inheritedFiles(tickets, tickets[2]), [])
})

await check('clearDeclaredPaths never deletes an inherited file', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-keep-'))
  fs.mkdirSync(path.join(TMP, 'src'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'src', 'db.js'), 'from the dependency\n')
  fs.writeFileSync(path.join(TMP, 'src', 'api.js'), 'mine, from a past attempt\n')

  const ticket = { id: 'api', allowedFiles: ['src/db.js', 'src/api.js'] }
  const cleared = clearDeclaredPaths(TMP, ticket, { keep: ['src/db.js'] })

  assert.deepEqual(cleared, ['src/api.js'], 'only the ticket´s own file is cleared')
  assert.ok(fs.existsSync(path.join(TMP, 'src', 'db.js')), "the dependency's file must survive")
  assert.ok(!fs.existsSync(path.join(TMP, 'src', 'api.js')))
})

// ---------------------------------------------------------------------------
// End to end: wave 2 edits wave 1's file, over the real protocol
// ---------------------------------------------------------------------------
async function replicatedPair(storeA, storeB) {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const client = net.connect(port, '127.0.0.1')
  const serverSide = await new Promise((r) => server.once('connection', r))
  await new Promise((r) => client.once('connect', r))
  server.close()
  const a = new NoiseSecretStream(false, serverSide)
  const b = new NoiseSecretStream(true, client)
  await Promise.all([
    new Promise((r) => a.once('connect', r)),
    new Promise((r) => b.once('connect', r))
  ])
  storeA.replicate(a)
  storeB.replicate(b)
  return { a, b }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-edit-e2e-'))
const WS = path.join(TMP, 'workspace')
const REQ = path.join(TMP, 'requirements.md')
fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(
  REQ,
  `# Growing project

## Ticket: db
Create the db module with a connect function.
Depends on: none
Files: src/db.js

## Ticket: api
Add a query function to the EXISTING db module, keeping connect.
Depends on: db
Files: src/db.js
`
)
fs.writeFileSync(
  path.join(WS, 'package.json'),
  JSON.stringify({ name: 'grow', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
)
fs.writeFileSync(
  path.join(WS, 'verify.mjs'),
  `import fs from 'fs'\nif (!fs.existsSync('src/db.js')) process.exit(1)\nconsole.log('ok')\n`
)

const V1 = 'export function connect() { return 1 }\n'
const V2 = 'export function connect() { return 1 }\nexport function query() { return 2 }\n'

// What the `api` worker was shown as an editable file — the whole point.
let apiSawEditBlock = null
let apiSawContent = null

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'fake', object: 'model' }] }))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const request = JSON.parse(body)
    const userTurn = request.messages[1].content
    const isApi = userTurn.includes('Add a query function')
    if (isApi) {
      apiSawEditBlock = userTurn.includes('ALREADY EXIST and you are updating them')
      const m = userTurn.match(/--- src\/db\.js ---\n([\s\S]*?)(?:\n---|\n\nExisting files|$)/)
      apiSawContent = m ? m[1].trim() : null
    }
    const content = '```file path=src/db.js\n' + (isApi ? V2 : V1) + '```'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
    )
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const gateway = `http://127.0.0.1:${server.address().port}`

const storeCoord = new Corestore(path.join(TMP, 'sc'))
const storeWorker = new Corestore(path.join(TMP, 'sw'))
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
const summary = await coord.run()
await coord.close()
detachWorker()
link.a.destroy()
link.b.destroy()
await storeCoord.close()
await storeWorker.close()
server.close()

console.log('summary:', summary)

await check('a requirements.md where two tickets share a file (with a dep) is accepted', () => {
  assert.equal(summary.total, 2)
})

await check('both tickets closed', () => {
  assert.equal(summary.done, 2, `done=${summary.done}`)
})

await check("the editing worker was told the file already exists (not 'reference only')", () => {
  assert.equal(apiSawEditBlock, true, 'the edit-block wording must be in the prompt')
})

await check("the editing worker received the DEPENDENCY's actual content", () => {
  assert.equal(apiSawContent, V1.trim())
})

await check('the workspace ends with the UPDATED file, not the original', () => {
  const onDisk = fs.readFileSync(path.join(WS, 'src', 'db.js'), 'utf8')
  assert.equal(onDisk, V2)
  assert.ok(onDisk.includes('connect'), 'the edit must not have dropped what came before')
  assert.ok(onDisk.includes('query'), 'the edit must have added the new function')
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1

// ---------------------------------------------------------------------------
// Found on the K16, not by reasoning: an earlier-wave ticket whose CI verdict
// went stale was reassigned and OVERWROTE the later ticket that had edited the
// same file — silent loss of work that had already passed the gate.
// ---------------------------------------------------------------------------
{
  const { State, EVENTS } = await import('../orchestrator/state.mjs')

  const sc = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-stale-'))
  const ws = path.join(sc, 'workspace')
  const storage = path.join(sc, 'coord')
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
  fs.mkdirSync(storage, { recursive: true })
  const req = path.join(sc, 'requirements.md')
  fs.writeFileSync(
    req,
    `# G\n\n## Ticket: base\nCreate add.\nDepends on: none\nFiles: src/calc.js\n\n` +
      `## Ticket: extend\nAdd mul, keep add.\nDepends on: base\nFiles: src/calc.js\n`
  )
  fs.writeFileSync(
    path.join(ws, 'package.json'),
    JSON.stringify({ name: 'g', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
  )
  // The gate wants BOTH — exactly the shape that makes `base` fail on its own.
  fs.writeFileSync(
    path.join(ws, 'verify.mjs'),
    `import fs from 'fs'\nconst s = fs.readFileSync('src/calc.js','utf8')\n` +
      `if (!s.includes('add') || !s.includes('mul')) process.exit(1)\nconsole.log('ok')\n`
  )
  // The state the K16 run reached: extend done, base still ci-failed, and the
  // file on disk already correct because extend fixed it.
  fs.writeFileSync(path.join(ws, 'src', 'calc.js'), 'export const add=1\nexport const mul=2\n')
  const seed = new State(path.join(storage, 'runs.jsonl'))
  seed.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'base', attemptId: 'base#1' })
  seed.append(EVENTS.RESULT_RECEIVED, { ticketId: 'base', attemptId: 'base#1', ok: true, files: [] })
  seed.append(EVENTS.CI_FAIL, { ticketId: 'base', status: 'failed' })
  seed.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'extend', attemptId: 'extend#1' })
  seed.append(EVENTS.RESULT_RECEIVED, { ticketId: 'extend', attemptId: 'extend#1', ok: true, files: [] })
  seed.append(EVENTS.CI_PASS, { ticketId: 'extend', ms: 1 })
  seed.append(EVENTS.TICKET_DONE, { ticketId: 'extend' })

  const swarm = new FakeSwarm('coord-key', {})
  swarm.sendTask = () => {
    throw new Error('base must NOT be reassigned: its output would overwrite extend')
  }
  swarm.peers.set('worker-key', { manifest: { security: { acceptsTasks: true } } })
  const store = new Corestore(path.join(sc, 'store'))
  await store.ready()
  const coord = new Coordinator({
    swarm,
    store,
    workspace: ws,
    storageDir: storage,
    requirementFile: req,
    workerKeys: ['worker-key'],
    waitForWorkersMs: 500,
    workerPollMs: 20
  })
  const summary = await coord.run()
  await coord.close()
  await store.close()

  await check('a stale CI failure closes on re-check instead of destructively retrying', () => {
    assert.equal(summary.done, 2, `both should be closed, got ${summary.done}`)
    assert.equal(summary.blocked, 0)
  })

  await check("the workspace still holds the later ticket's work", () => {
    const s = fs.readFileSync(path.join(ws, 'src', 'calc.js'), 'utf8')
    assert.ok(s.includes('mul'), 'mul must survive — this is the bug that was found live')
  })
}

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
