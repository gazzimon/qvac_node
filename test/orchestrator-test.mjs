// Orchestrator unit tests. Runs under Node (not Bare): the orchestrator and the
// worker are HTTP clients of the gateway, not part of the distributed binary.
//
//   node test/orchestrator-test.mjs

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseRequirements, buildDAG, assignTickets } from '../orchestrator/split.mjs'
import { Harness, LimitReached, isTransient, isTimeout } from '../orchestrator/harness.mjs'
import {
  validateWrite,
  validateTool,
  isPathAllowed,
  ScopeViolation
} from '../orchestrator/security.mjs'
import { State, EVENTS } from '../orchestrator/state.mjs'
import { detectOverlap } from '../orchestrator/index.mjs'
import {
  parseBlocks,
  systemPrompt,
  stripReasoning,
  describeFetchFailure
} from '../worker/run.mjs'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`  NO  ${name}\n      ${err.message}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`  NO  ${name}\n      ${err.message}`)
  }
}

const MD = `# App

## Ticket: index
Implement the entry point
Depends on: none
Files: src/index.js,tests/index.test.js

## Ticket: db
Implement the database layer
Depends on: index
Files: src/db.js,tests/db.test.js
`

console.log('\nsplit')

test('parses tickets with specs, deps and files', () => {
  const t = parseRequirements(MD)
  assert.equal(t.length, 2)
  assert.equal(t[0].id, 'index')
  assert.deepEqual(t[0].allowedFiles, ['src/index.js', 'tests/index.test.js'])
  assert.deepEqual(t[1].deps, ['index'])
  assert.ok(t[0].spec.includes('entry point'))
})

// The first requirements files were written in Spanish; breaking them buys
// nothing, so both headings are accepted.
test('also accepts Spanish headings', () => {
  const t = parseRequirements(`# App

## Ticket: db
Hacer la base
Depende de: ninguno
Archivos: src/db.js
`)
  assert.equal(t.length, 1)
  assert.deepEqual(t[0].deps, [])
  assert.deepEqual(t[0].allowedFiles, ['src/db.js'])
})

test('the DAG respects dependency order', () => {
  const dag = buildDAG(parseRequirements(MD))
  const order = dag.ready.map((t) => t.id)
  assert.ok(order.indexOf('index') < order.indexOf('db'))
})

test('a dependency that does not exist aborts instead of being ignored', () => {
  const t = [{ id: 'a', deps: ['ghost'], allowedFiles: ['a.js'] }]
  assert.throws(() => buildDAG(t), /unknown ticket/)
})

test('spreads the tickets across the workers', () => {
  const dag = buildDAG(parseRequirements(MD))
  const { ticketsPerWorker } = assignTickets(dag, 2)
  assert.equal(ticketsPerWorker[0].length + ticketsPerWorker[1].length, 2)
})

console.log('\noverlap')

test('two tickets claiming the same file are detected', () => {
  const clashes = detectOverlap([
    { id: 'a', allowedFiles: ['src/x.js'] },
    { id: 'b', allowedFiles: ['src/x.js'] }
  ])
  assert.equal(clashes.length, 1)
  assert.equal(clashes[0].file, 'src/x.js')
})

test('disjoint files do not clash', () => {
  const clashes = detectOverlap([
    { id: 'a', allowedFiles: ['src/a.js'] },
    { id: 'b', allowedFiles: ['src/b.js'] }
  ])
  assert.equal(clashes.length, 0)
})

console.log('\nsecurity')

const WS = path.join(os.tmpdir(), 'orch-test-ws')

test('writing a file the ticket declares is allowed', () => {
  const abs = validateWrite(WS, 'src/db.js', ['src/db.js'])
  assert.ok(abs.endsWith(path.join('orch-test-ws', 'src', 'db.js')))
})

test('writing outside the ticket is rejected', () => {
  assert.throws(
    () => validateWrite(WS, 'src/other.js', ['src/db.js']),
    (e) => e instanceof ScopeViolation && e.reason === 'path outside the ticket'
  )
})

test('escaping the workspace with .. is rejected', () => {
  assert.throws(
    () => validateWrite(WS, '../../etc/passwd', ['../../etc/passwd']),
    (e) => e instanceof ScopeViolation && e.reason === 'escaped the workspace'
  )
})

test('a directory prefix grants what is inside it', () => {
  assert.ok(isPathAllowed('src/lib/x.js', ['src/']))
  assert.ok(!isPathAllowed('srcx/lib.js', ['src/']))
})

test('a lookalike name does NOT count as the allowed file', () => {
  assert.ok(!isPathAllowed('src/db.js.bak', ['src/db.js']))
})

test('a forbidden tool is rejected even if it is in the allowlist', () => {
  assert.throws(
    () => validateTool('sudo', ['sudo', 'read_file']),
    (e) => e.reason === 'forbidden tool'
  )
})

test('a tool outside the allowlist is rejected', () => {
  assert.throws(() => validateTool('git_push', ['read_file']), /allowlist/)
})

console.log('\nharness')

test('cuts on steps before spending', () => {
  const h = new Harness({ maxSteps: 2 })
  h.spend({ tokens: 1 })
  h.spend({ tokens: 1 })
  assert.throws(() => h.checkBudget(), (e) => e instanceof LimitReached && e.kind === 'steps')
})

test('cuts on tokens before spending', () => {
  const h = new Harness({ maxSteps: 100, maxTokens: 50 })
  h.spend({ tokens: 60 })
  assert.throws(() => h.checkBudget(), (e) => e.kind === 'tokens')
})

test('the per-tool timeout must be smaller than the per-task one', () => {
  assert.throws(() => new Harness({ toolTimeoutMs: 999, taskTimeoutMs: 999 }), /smaller/)
})

test('a 500 is transient; a 400 is not', () => {
  assert.ok(isTransient(Object.assign(new Error('x'), { status: 500 })))
  assert.ok(!isTransient(Object.assign(new Error('x'), { status: 400 })))
})

// Measured: with the gateway down, the worker died with a bare "fetch failed".
// `fetch` hides the real code in `.cause`, so checking only the top level
// missed every connection failure — a gateway restarting mid-run was reported
// as a hard error instead of being retried.
test('a refused connection is transient even though fetch hides the code', () => {
  const refused = new TypeError('fetch failed')
  refused.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
    code: 'ECONNREFUSED'
  })
  assert.ok(isTransient(refused))
})

test('an unreachable gateway is described with its target and a hint', () => {
  const refused = new TypeError('fetch failed')
  refused.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
    code: 'ECONNREFUSED'
  })
  const described = describeFetchFailure(refused, 'http://localhost:8787/v1/chat/completions')
  assert.match(described.message, /localhost:8787/, 'it has to name what it could not reach')
  assert.match(described.message, /serve/, 'and say what to check')
  assert.equal(described.code, 'ECONNREFUSED')
  assert.ok(isTransient(described), 'the wrapper must stay classifiable')
})

await testAsync('a hung tool fails on timeout without hanging the task', async () => {
  const h = new Harness({ toolTimeoutMs: 50, taskTimeoutMs: 5000 })
  await assert.rejects(() => h.runTool('slow', () => new Promise(() => {})), /timed out/)
})

await testAsync('a deterministic error is not retried', async () => {
  const h = new Harness({ maxRetries: 3 })
  let attempts = 0
  await assert.rejects(() =>
    h.withRetry('x', () => {
      attempts++
      throw Object.assign(new Error('bad request'), { status: 400 })
    })
  )
  assert.equal(attempts, 1, 'a 400 is not retried')
})

// Measured four times, across two models: this project's gateway does NOT emit
// `usage` — that is documented and decided in the header of gateway.mjs. With
// no fallback the budget counted zero and never cut; a budget that does not
// measure is not a budget. So it estimates, and the summary says it estimated.
test('estimated spend still counts, but stays labelled as estimated', () => {
  const h = new Harness({})
  h.spend({ tokens: 100, tokenSource: 'gateway' })
  h.spend({ tokens: 50, tokenSource: 'provider' })
  const s = h.summary()
  assert.equal(s.tokensUsed, 150, 'the budget counts both sources')
  assert.equal(s.tokensEstimated, 100, 'and knows how much of it was estimated')
  assert.deepEqual(s.tokenSources.sort(), ['gateway', 'provider'])
})

test('a budget fed on estimates still cuts', () => {
  const h = new Harness({ maxTokens: 100 })
  h.spend({ tokens: 120, tokenSource: 'gateway' })
  assert.throws(() => h.checkBudget(), (e) => e.kind === 'tokens')
})

// Measured: the first request against qwen4b downloads 2.3 GB and loads the
// model, all inside the same request. A 30s ceiling there does not measure
// "it hung", it measures "it was downloading". And retrying that three times
// asks the node for triple the work.
test('the timeout default is an inference default, not a filesystem one', () => {
  const h = new Harness({})
  assert.ok(h.toolTimeoutMs >= 300000, `toolTimeout=${h.toolTimeoutMs}, too short for a cold load`)
  assert.ok(h.taskTimeoutMs > h.toolTimeoutMs)
})

test('a timeout is told apart from other transient failures', () => {
  assert.ok(isTimeout(new Error('tool x timed out after 600000ms')))
  assert.ok(!isTimeout(Object.assign(new Error('boom'), { status: 503 })))
})

await testAsync('a timeout is retried ONCE, not three times', async () => {
  const h = new Harness({ maxRetries: 3, maxRetriesTimeout: 1 })
  let attempts = 0
  await assert.rejects(() =>
    h.withRetry('x', () => {
      attempts++
      throw new Error('tool chat timed out after 600000ms')
    })
  )
  assert.equal(attempts, 2, 'one attempt plus one retry: two, not four')
})

await testAsync('a 503 does exhaust all three attempts', async () => {
  const h = new Harness({ maxRetries: 3, maxRetriesTimeout: 1 })
  let attempts = 0
  await assert.rejects(() =>
    h.withRetry('x', () => {
      attempts++
      throw Object.assign(new Error('boom'), { status: 503 })
    })
  )
  assert.equal(attempts, 3)
})

await testAsync('a transient failure is retried, and then succeeds', async () => {
  const h = new Harness({ maxRetries: 3 })
  let attempts = 0
  const r = await h.withRetry('x', () => {
    attempts++
    if (attempts < 2) throw Object.assign(new Error('boom'), { status: 503 })
    return 'ok'
  })
  assert.equal(r, 'ok')
  assert.equal(attempts, 2)
})

console.log('\nworker: system prompt')

// Measured: the prompt showed `path=src/example.js` as the format sample while
// asking for `src/sum.js`. The model copied the example's path and the jail
// rejected everything — 0 written, 1 rejected. With two paths in the prompt, a
// small model picks the one sitting in the example slot.
test('the prompt mentions no path other than the ticket ones', () => {
  const p = systemPrompt({ id: 'x', spec: 'y', allowedFiles: ['src/sum.js'] })
  const paths = [...p.matchAll(/path=([^\n`]+)/g)].map((m) => m[1].trim())
  assert.ok(paths.length > 0, 'the prompt has to show the format')
  assert.deepEqual([...new Set(paths)], ['src/sum.js'])
})

test('with several files, it lists them all', () => {
  const files = ['src/a.js', 'tests/a.test.js']
  const p = systemPrompt({ id: 'x', spec: 'y', allowedFiles: files })
  for (const f of files) assert.ok(p.includes(f), `${f} missing from the prompt`)
  const paths = [...p.matchAll(/path=([^\n`]+)/g)].map((m) => m[1].trim())
  assert.ok(files.includes(paths[0]), 'the example uses one of the ticket paths')
})

// Measured: with no real code in the example, llama1b returned 0 blocks. A
// filler comment is not a mould, and a mould is what guides a small model.
test('the example carries code, not a filler comment', () => {
  const p = systemPrompt({ id: 'x', spec: 'y', allowedFiles: ['src/sum.js'] })
  const blocks = parseBlocks(p)
  assert.equal(blocks.length, 1, 'the prompt has to show one example block')
  assert.match(blocks[0].content, /export function/, 'the example has to carry code')
  assert.ok(
    !/^\s*\/\/[^\n]*\n?\s*$/.test(blocks[0].content),
    'an example that is only a comment is no mould'
  )
})

// Measured: the example was `(a, b) => a + b` and the test task was "add two
// numbers". qwen4b copied it and the result looked correct — copying and
// understanding stopped being distinguishable, which was the only thing being
// measured.
test('the example solves no plausible task', () => {
  const p = systemPrompt({ id: 'x', spec: 'y', allowedFiles: ['src/sum.js'] })
  const [example] = parseBlocks(p)
  assert.ok(
    !/[a-z]\s*[+\-*/]\s*[a-z]/i.test(example.content),
    'the example performs an operation: a model copying it would look like it solved the task'
  )
})

// Measured: two lines explaining the mould ("do NOT copy it" / "copy the first
// line exactly" — which also contradict each other) made qwen4b return broken
// text with Chinese characters, talking about someone who cannot follow
// instructions. The same model, without those lines, had written correct code.
// The prompt says WHAT to deliver; it never talks about the prompt.
test('the prompt does not discuss the prompt', () => {
  const p = systemPrompt({ id: 'x', spec: 'y', allowedFiles: ['src/sum.js'] })
  for (const meta of [/do not copy/i, /don't copy/i, /mould|mold/i, /this example/i]) {
    assert.ok(!meta.test(p), `the prompt contains a meta-instruction: ${meta}`)
  }
})

console.log('\nworker: block parsing')

test('parses several file blocks', () => {
  const b = parseBlocks(
    'bla\n```file path=src/a.js\nconst a = 1\n```\nand\n```file path=src/b.js\nconst b = 2\n```'
  )
  assert.equal(b.length, 2)
  assert.equal(b[0].path, 'src/a.js')
  assert.equal(b[0].content, 'const a = 1\n')
  assert.equal(b[1].path, 'src/b.js')
})

test('a response with no blocks gives an empty list, not an error', () => {
  assert.equal(parseBlocks('here is the code, mate').length, 0)
})

// The LITERAL output of qwen4b on the K16, 2026-08-29. The prompt asked for
// `path=src/sum.js` and the model wrote `file:` with the path in backticks,
// plus an extra fence right after opening. The strict parser returned 0 blocks;
// the model had understood and written the code all the same.
const QWEN4B_REAL = [
  '<think>',
  '',
  '</think>',
  '',
  '',
  '```file: `src/sum.js`',
  '```;',
  'export function sum (a, b) {',
  '  return a + b',
  '}',
  '```'
].join('\n')

test('accepts the syntax qwen4b actually writes', () => {
  const b = parseBlocks(QWEN4B_REAL)
  assert.equal(b.length, 1, 'the real output has to yield 1 block')
  assert.equal(b[0].path, 'src/sum.js')
  assert.match(b[0].content, /export function sum/)
  assert.ok(!b[0].content.includes('```'), 'the noise fence does not enter the file')
})

test('accepts the opening-line variants', () => {
  for (const opening of [
    '```file path=src/x.js',
    '```file: `src/x.js`',
    '```file src/x.js',
    '```file:src/x.js',
    '```file "src/x.js"'
  ]) {
    const b = parseBlocks(opening + '\nconst a = 1\n```')
    assert.equal(b.length, 1, `did not parse: ${opening}`)
    assert.equal(b[0].path, 'src/x.js', `path wrongly extracted from: ${opening}`)
  }
})

test('a fence without a path is not a file block', () => {
  assert.equal(parseBlocks('```js\nconst a = 1\n```').length, 0)
  assert.equal(parseBlocks('```\nconst a = 1\n```').length, 0)
})

// Writing an empty file is worse than writing none: CI takes it as done.
test('an empty block produces no file', () => {
  assert.equal(parseBlocks('```file path=src/x.js\n```').length, 0)
})

console.log('\nworker: reasoning models')

// Measured on the K16: given a spec asking for three deliverables while the
// ticket allowed one file, qwen4b looped on the contradiction for 253s and the
// answer was cut mid-sentence, never closing </think>. 2048 tokens of context
// hold the prompt, the reasoning AND the answer.
test('an unclosed <think> is reported, not silently treated as empty', () => {
  const r = stripReasoning('<think>\nI keep going back and forth and never fin')
  assert.equal(r.unclosedThink, true)
  assert.equal(r.text, '')
})

// A file drafted inside the reasoning is not a file the model chose to deliver.
test('a block drafted inside the reasoning is not delivered', () => {
  const answer = [
    '<think>',
    'Maybe something like this:',
    '```file path=src/draft.js',
    'export const draft = 1',
    '```',
    'no, better:',
    '</think>',
    '```file path=src/final.js',
    'export const final = 2',
    '```'
  ].join('\n')

  const { text, unclosedThink } = stripReasoning(answer)
  assert.equal(unclosedThink, false)
  const blocks = parseBlocks(text)
  assert.equal(blocks.length, 1, 'only the block outside the reasoning counts')
  assert.equal(blocks[0].path, 'src/final.js')
})

test('a response without reasoning passes through untouched', () => {
  const plain = '```file path=src/x.js\nconst a = 1\n```'
  const { text, unclosedThink } = stripReasoning(plain)
  assert.equal(unclosedThink, false)
  assert.equal(parseBlocks(text).length, 1)
})

console.log('\nhyperdrive: single writer')

// This does not test our code, it tests an assumption the whole architecture
// rests on. It broke once: the orchestrator handed the worker ITS key and
// `put()` hung forever, with no error. The test stays so that the day someone
// writes `new Hyperdrive(store, someoneElsesKey)` expecting to write, they find
// out here and not hung.
await testAsync('a drive opened with someone else’s key is NOT writable', async () => {
  const Corestore = (await import('corestore')).default
  const Hyperdrive = (await import('hyperdrive')).default
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-writable-'))

  const storeA = new Corestore(path.join(tmp, 'a'))
  await storeA.ready()
  const driveA = new Hyperdrive(storeA)
  await driveA.ready()

  const storeB = new Corestore(path.join(tmp, 'b'))
  await storeB.ready()
  const driveB = new Hyperdrive(storeB, driveA.key)
  await driveB.ready()

  assert.equal(driveA.core.writable, true, 'the creator DOES write')
  assert.equal(driveB.core.writable, false, 'the one opening by key does NOT')

  // And what makes the bug treacherous: it does not fail, it hangs.
  const r = await Promise.race([
    driveB.put('/x', Buffer.from('a')).then(() => 'wrote'),
    new Promise((res) => setTimeout(() => res('hung'), 1500))
  ]).catch(() => 'error')
  assert.equal(r, 'hung', 'put() on a read-only drive hangs, it does not throw')

  await driveA.close()
  await driveB.close()
  await storeA.close()
  await storeB.close()
})

console.log('\ncorestore: it wipes what it does not recognise')

// Measured, and it cost a broken demo: `new Corestore(dir).ready()` DELETES the
// contents of a directory it does not recognise as a corestore. A
// `requirements.md` written there a moment earlier was gone after `ready()`,
// replaced by CORESTORE and db.
//
// Anything the orchestrator keeps under --storage — the run log, the worker
// directories, a requirements file someone put there — would be destroyed the
// first time it opened. Hence the corestore lives in its own subdirectory, and
// this test states the hazard so nobody moves it back.
await testAsync('a file under --storage survives the orchestrator opening it', async () => {
  const Corestore = (await import('corestore')).default
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-hazard-'))
  const kept = path.join(dir, 'requirements.md')
  fs.writeFileSync(kept, '# do not eat me\n')

  // The wrong way: straight at the directory.
  const wrongDir = path.join(dir, 'wrong')
  fs.mkdirSync(wrongDir)
  fs.writeFileSync(path.join(wrongDir, 'data.txt'), 'x')
  const wrong = new Corestore(wrongDir)
  await wrong.ready()
  assert.ok(
    !fs.existsSync(path.join(wrongDir, 'data.txt')),
    'if this passes, Corestore stopped wiping and the subdirectory is no longer needed'
  )
  await wrong.close()

  // The way the orchestrator does it: a subdirectory of its own.
  const right = new Corestore(path.join(dir, 'corestore'))
  await right.ready()
  assert.ok(fs.existsSync(kept), 'the file next to the corestore has to survive')
  assert.equal(fs.readFileSync(kept, 'utf8'), '# do not eat me\n')
  await right.close()
})

console.log('\nstate')

const LOG = path.join(os.tmpdir(), `orch-test-${Date.now()}.jsonl`)

test('a closed ticket stays closed after re-reading the log', () => {
  const s = new State(LOG)
  s.append(EVENTS.RUN_START, {})
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'a' })
  s.append(EVENTS.TICKET_DONE, { ticketId: 'a' })
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'b' })

  const reread = new State(LOG)
  assert.deepEqual(reread.done(), ['a'])
  assert.deepEqual(reread.pending(), ['b'])
})

test('a truncated line is discarded and the rest survives', () => {
  fs.appendFileSync(LOG, '{"ts":"x","type":"run')
  const s = new State(LOG)
  assert.deepEqual(s.done(), ['a'])
})

test('two runs closing nothing are flagged as stalled', () => {
  const file = path.join(os.tmpdir(), `orch-stall-${Date.now()}.jsonl`)
  const s = new State(file)
  s.append(EVENTS.RUN_START, {})
  s.append(EVENTS.RUN_END, {})
  s.append(EVENTS.RUN_START, {})
  s.append(EVENTS.RUN_END, {})
  assert.ok(s.isStalled())
  fs.unlinkSync(file)
})

test('a run that closed something is not stalled', () => {
  const file = path.join(os.tmpdir(), `orch-ok-${Date.now()}.jsonl`)
  const s = new State(file)
  s.append(EVENTS.RUN_START, {})
  s.append(EVENTS.TICKET_DONE, { ticketId: 'z' })
  s.append(EVENTS.RUN_START, {})
  s.append(EVENTS.TICKET_DONE, { ticketId: 'y' })
  assert.ok(!s.isStalled())
  fs.unlinkSync(file)
})

fs.unlinkSync(LOG)

console.log(`\n${passed} ok, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
