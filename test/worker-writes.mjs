// End-to-end test of the worker WITHOUT a node running: a fake gateway speaking
// the OpenAI protocol returns ```file blocks, and we check the files land both
// on disk AND in the Hyperdrive.
//
// The fake gateway exists to test the worker, not the model: what is being
// verified is that the ask → parse → validate → write cycle works, and that a
// block falling outside the ticket is rejected even when the "model" sends it.
//
//   node test/worker-writes.mjs

import assert from 'assert'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { Worker } from '../worker/run.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-worker-'))
const WS = path.join(TMP, 'workspace')
const STORE = path.join(TMP, 'worker')

// The "model" returns three blocks: two the ticket allows and one it does not.
const RESPONSE = [
  'Here is the code.',
  '',
  '```file path=src/greet.js',
  'export function greet (name) {',
  '  return `hello ${name}`',
  '}',
  '```',
  '',
  '```file path=tests/greet.test.js',
  "import { greet } from '../src/greet.js'",
  "console.log(greet('world'))",
  '```',
  '',
  '```file path=src/NOT-ALLOWED.js',
  '// this block is outside the ticket and has to be rejected',
  '```'
].join('\n')

function startFakeGateway() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: 'fake-model', object: 'model' }] }))
      }
      if (req.url === '/v1/chat/completions') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const request = JSON.parse(body)
          // The system prompt has to tell the model which files it may write.
          assert.ok(
            request.messages[0].content.includes('src/greet.js'),
            'the system prompt must list the ticket files'
          )
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: RESPONSE } }],
              usage: { total_tokens: 120 }
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

const server = await startFakeGateway()
const port = server.address().port
console.log(`fake gateway on 127.0.0.1:${port}`)

const worker = new Worker({
  gateway: `http://127.0.0.1:${port}`,
  ticket: 'greet',
  spec: 'Implement a function that greets someone',
  allowedFiles: 'src/greet.js,tests/greet.test.js',
  workspace: WS,
  storage: STORE
})

// `close: false` because the drive is inspected below: if the worker closed it
// on the way out, the drive assertions would have nothing to look at.
const r = await worker.start({ close: false })
server.close()

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
    console.log(`  NO  ${name}\n      ${err.message}`)
  }
}

check('the worker reports what it wrote', () => {
  assert.equal(r.ok, true)
  assert.equal(r.written, 2)
})

check('src/greet.js exists on disk with the right contents', () => {
  const p = path.join(WS, 'src', 'greet.js')
  assert.ok(fs.existsSync(p), `missing ${p}`)
  assert.ok(fs.readFileSync(p, 'utf8').includes('export function greet'))
})

check('tests/greet.test.js exists on disk', () => {
  assert.ok(fs.existsSync(path.join(WS, 'tests', 'greet.test.js')))
})

check('the block outside the ticket was NOT written', () => {
  assert.ok(!fs.existsSync(path.join(WS, 'src', 'NOT-ALLOWED.js')))
})

check('the rejection was recorded as a violation', () => {
  assert.equal(worker.violations.length, 1)
  assert.equal(worker.violations[0].path, 'src/NOT-ALLOWED.js')
  assert.equal(worker.violations[0].reason, 'path outside the ticket')
})

check('the worker drive is writable (it is ITS drive, not a borrowed one)', () => {
  assert.equal(worker.drive.core.writable, true)
})

// What makes other machines see the change: the file has to be in the
// Hyperdrive, not only on local disk.
const inDrive = await worker.drive.get('/src/greet.js')
check('src/greet.js is in the Hyperdrive, not only on disk', () => {
  assert.ok(inDrive, 'the drive does not have /src/greet.js')
  assert.ok(inDrive.toString('utf8').includes('export function greet'))
})

// Resolved BEFORE checking: an `async` handed to a synchronous `check` returns
// a promise nobody awaits, the assertion inside never runs, and the test passes
// for the wrong reason.
const rejectedInDrive = await worker.drive.get('/src/NOT-ALLOWED.js')
check('the rejected file is not in the drive either', () => {
  assert.equal(rejectedInDrive, null)
})

check('the drive key was left on disk for the orchestrator', () => {
  const p = path.join(STORE, 'drive-key')
  assert.ok(fs.existsSync(p))
  assert.equal(fs.readFileSync(p, 'utf8'), worker.driveKey)
})

check('the harness counted the spend', () => {
  const s = worker.harness.summary()
  assert.equal(s.steps, 1)
  assert.equal(s.tokensUsed, 120)
  assert.deepEqual(s.tokenSources, ['provider'], 'this gateway does send usage')
})

check('the worker JSONL log was written', () => {
  const log = path.join(STORE, 'greet.jsonl')
  assert.ok(fs.existsSync(log))
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(lines.some((l) => l.type === 'write'))
  assert.ok(lines.some((l) => l.type === 'violation'))
})

console.log(`\n${ok} ok, ${bad} failed`)
console.log(`workspace left at: ${WS}`)

// Exit via `exitCode` rather than `process.exit()`: on Windows, tearing the
// process down with RocksDB handles still open makes libuv abort with an assert
// — after the test passed, so it reads as a failure when it is not.
await worker.close()

process.exitCode = bad === 0 ? 0 : 1
