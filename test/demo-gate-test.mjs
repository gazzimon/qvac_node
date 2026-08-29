// The demo's CI gate has to actually judge. A gate that passes on wrong code —
// or that cannot even parse — would make a green orchestrator run meaningless.
//
//   node test/demo-gate-test.mjs

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { VERIFY } from '../scripts/demo-orchestrator.mjs'

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

// Runs the gate over a workspace holding the given files. Returns the exit code
// the orchestrator's CI would see.
function runGate(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'g', type: 'module', scripts: { test: 'node verify.mjs' } })
  )
  fs.writeFileSync(path.join(dir, 'verify.mjs'), VERIFY)
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
  try {
    execFileSync(process.execPath, ['verify.mjs'], { cwd: dir, stdio: 'pipe' })
    return 0
  } catch (err) {
    return err.status === undefined ? 1 : err.status
  }
}

const GOOD = {
  'src/sum.js': 'export const sum = (a, b) => a + b\n',
  'src/mul.js': 'export const mul = (a, b) => a * b\n'
}

console.log('\ndemo CI gate')

test('the generated gate is valid JavaScript and passes on correct code', () => {
  assert.equal(runGate(GOOD), 0)
})

test('it fails when a file is missing', () => {
  assert.notEqual(runGate({ 'src/sum.js': GOOD['src/sum.js'] }), 0)
})

// The export name is part of the ticket. A module that works but exports
// something else is not what was asked for.
test('it fails when the export is named differently', () => {
  assert.notEqual(
    runGate({ ...GOOD, 'src/sum.js': 'export const add = (a, b) => a + b\n' }),
    0
  )
})

test('it fails when the maths is wrong', () => {
  assert.notEqual(runGate({ ...GOOD, 'src/mul.js': 'export const mul = (a, b) => a + b\n' }), 0)
})

// The negative cases exist because `2 + 3` and `2 * 3` are not the only way to
// get 5 and 6 — a model that hardcodes a return would pass a single case.
test('it fails on a hardcoded answer that satisfies the first case', () => {
  assert.notEqual(runGate({ ...GOOD, 'src/sum.js': 'export const sum = () => 5\n' }), 0)
})

test('it fails when the module does not parse', () => {
  assert.notEqual(runGate({ ...GOOD, 'src/sum.js': 'export const sum = (a, b) => {{{\n' }), 0)
})

console.log(`\n${passed} ok, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
