// The whole cycle, without a node running: orchestrator → workers in parallel →
// files on disk → CI → ticket closed → a second run that does not redo it.
//
// The fake gateway returns the file each ticket is meant to produce, so what is
// being tested is the coordination: that two workers writing at once do not
// step on each other, that the CI gate decides, and that the state outlives the
// process.
//
//   node test/orchestrator-e2e.mjs

import assert from 'assert'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { Orchestrator } from '../orchestrator/index.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-e2e-'))
const WS = path.join(TMP, 'workspace')
const STORE = path.join(TMP, 'orch')
const REQ = path.join(TMP, 'requirements.md')

fs.writeFileSync(
  REQ,
  `# Demo

## Ticket: add
Implement an add function
Depends on: none
Files: src/add.js

## Ticket: sub
Implement a subtract function
Depends on: none
Files: src/sub.js
`
)

// The workspace has to be a project `npm test` can run. The test itself is
// deliberately trivial: what is being exercised is the GATE, not the generated
// project's suite.
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
// Green only if BOTH files exist, so the first ticket to finish goes red and
// the second goes green. That is the gate doing its job.
const missing = ['src/add.js', 'src/sub.js'].filter((f) => !fs.existsSync(f))
if (missing.length) {
  console.error('missing: ' + missing.join(', '))
  process.exit(1)
}
console.log('ok')
`
)

const CODE = {
  add: 'export const add = (a, b) => a + b\n',
  sub: 'export const sub = (a, b) => a - b\n'
}

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
          // Which file this worker wants comes from its own system prompt.
          const which = request.messages[0].content.includes('src/add.js') ? 'add' : 'sub'
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '```file path=src/' + which + '.js\n' + CODE[which] + '```'
                  }
                }
              ],
              usage: { total_tokens: 90 }
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
console.log(`fake gateway: ${gateway}\n`)

const opts = { gateway, requirement: REQ, workspace: WS, storage: STORE, workers: 2 }

console.log('=== first run ===')
const r1 = await new Orchestrator(opts).start()

console.log('\n=== second run (should redo nothing) ===')
const r2 = await new Orchestrator(opts).start()

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

check('both files exist in the workspace', () => {
  assert.ok(fs.existsSync(path.join(WS, 'src', 'add.js')), 'add.js missing')
  assert.ok(fs.existsSync(path.join(WS, 'src', 'sub.js')), 'sub.js missing')
})

check('the contents are what the model sent', () => {
  assert.ok(fs.readFileSync(path.join(WS, 'src', 'add.js'), 'utf8').includes('a + b'))
  assert.ok(fs.readFileSync(path.join(WS, 'src', 'sub.js'), 'utf8').includes('a - b'))
})

check('each worker announced ITS own drive, and they differ', () => {
  const keys = Object.values(r1.drives)
  assert.equal(keys.length, 2, `expected 2 keys, got ${keys.length}`)
  assert.notEqual(keys[0], keys[1], 'two workers cannot share a drive')
  for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/)
})

check('at least one ticket closed on a green CI', () => {
  assert.ok(r1.done >= 1, `done=${r1.done}`)
})

check('the second run does not go backwards', () => {
  assert.ok(r2.done >= r1.done, `r1=${r1.done} r2=${r2.done}`)
})

check('the run log is on disk and can be re-read', () => {
  const p = path.join(STORE, 'runs.jsonl')
  assert.ok(fs.existsSync(p))
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(lines.some((l) => l.type === 'run:start'))
  assert.ok(lines.some((l) => l.type === 'ticket:done'))
})

console.log(`\n${ok} ok, ${bad} failed`)
console.log(`workspace: ${WS}`)
process.exitCode = bad === 0 ? 0 : 1
