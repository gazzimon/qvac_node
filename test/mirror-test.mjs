// The coordinator side of the trust boundary: applying a `task:result` into the
// workspace. No swarm, no drive — inline files and an injected fetch.
//
//   node test/mirror-test.mjs

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyResult, clearDeclaredPaths, INLINE_CEILING } from '../orchestrator/mirror.mjs'
import { hashContent } from '../orchestrator/hash.mjs'
import { buildResult } from '../orchestrator/task-protocol.mjs'

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
async function acheck(name, fn) {
  try {
    await fn()
    ok++
    console.log(`  ok  ${name}`)
  } catch (err) {
    bad++
    console.log(`  NO  ${name}\n      ${err.message}`)
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-mirror-'))
function ws() {
  const d = path.join(TMP, 'ws-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(d, { recursive: true })
  return d
}

const ticket = { id: 'db', allowedFiles: ['src/db.js', 'tests/db.test.js'] }

await acheck('inline files land on disk, out-of-scope files are rejected not written', async () => {
  const workspace = ws()
  const a = 'export const db = () => 1\n'
  const b = "import { db } from '../src/db.js'\n"
  const result = buildResult({
    attemptId: 'db#1',
    ok: true,
    files: [
      { path: 'src/db.js', hash: hashContent(a), bytes: a.length, content: a },
      { path: 'tests/db.test.js', hash: hashContent(b), bytes: b.length, content: b },
      { path: 'src/EVIL.js', hash: hashContent('x'), bytes: 1, content: 'x' }
    ]
  })
  const r = await applyResult(workspace, ticket, result)
  assert.equal(r.ok, true)
  assert.equal(r.written.length, 2)
  assert.equal(r.rejected.length, 1)
  assert.equal(r.rejected[0].path, 'src/EVIL.js')
  assert.ok(fs.existsSync(path.join(workspace, 'src/db.js')))
  assert.ok(!fs.existsSync(path.join(workspace, 'src/EVIL.js')))
})

await acheck('one bad hash rejects the WHOLE result and writes nothing', async () => {
  const workspace = ws()
  const a = 'good\n'
  const result = buildResult({
    attemptId: 'db#2',
    ok: true,
    files: [
      { path: 'src/db.js', hash: hashContent(a), bytes: a.length, content: a },
      { path: 'tests/db.test.js', hash: 'sha256:0000', bytes: 4, content: 'liar' }
    ]
  })
  const r = await applyResult(workspace, ticket, result)
  assert.equal(r.ok, false)
  assert.equal(r.mismatched.length, 1)
  assert.equal(r.written.length, 0)
  assert.ok(!fs.existsSync(path.join(workspace, 'src/db.js')), 'the good file must not slip through')
})

await acheck('a stale declared file the new attempt omits is cleared', async () => {
  const workspace = ws()
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'src/db.js'), '// attempt A1 wrote this\n')
  fs.writeFileSync(path.join(workspace, 'tests/db.test.js'), '// A1 test\n')

  const only = 'export const db = () => 2\n'
  const result = buildResult({
    attemptId: 'db#3',
    ok: true,
    files: [{ path: 'src/db.js', hash: hashContent(only), bytes: only.length, content: only }]
  })
  const r = await applyResult(workspace, ticket, result)
  assert.equal(r.ok, true)
  assert.deepEqual(r.cleared.sort(), ['src/db.js', 'tests/db.test.js'])
  assert.equal(fs.readFileSync(path.join(workspace, 'src/db.js'), 'utf8'), only)
  assert.ok(
    !fs.existsSync(path.join(workspace, 'tests/db.test.js')),
    'the file A2 did not reproduce must be gone'
  )
})

await acheck('clearDeclaredPaths leaves a directory grant alone', () => {
  const workspace = ws()
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'src/keep.js'), 'keep\n')
  const cleared = clearDeclaredPaths(workspace, { id: 't', allowedFiles: ['src/'] })
  assert.deepEqual(cleared, [])
  assert.ok(fs.existsSync(path.join(workspace, 'src/keep.js')))
})

await acheck('a drive-backed file is pulled through the injected fetch and hash-checked', async () => {
  const workspace = ws()
  const big = 'B'.repeat(2048)
  let asked = null
  const result = buildResult({
    attemptId: 'db#4',
    ok: true,
    driveKey: 'c'.repeat(64),
    files: [{ path: 'src/db.js', hash: hashContent(big), bytes: big.length, drive: true }]
  })
  const r = await applyResult(workspace, ticket, result, {
    fetchFromDrive: async (p) => {
      asked = p
      return Buffer.from(big, 'utf8')
    }
  })
  assert.equal(asked, 'src/db.js')
  assert.equal(r.ok, true)
  assert.equal(fs.readFileSync(path.join(workspace, 'src/db.js'), 'utf8'), big)
})

await acheck('a drive-backed file with no fetch given fails cleanly', async () => {
  const workspace = ws()
  const result = buildResult({
    attemptId: 'db#5',
    ok: true,
    driveKey: 'c'.repeat(64),
    files: [{ path: 'src/db.js', hash: 'sha256:x', bytes: 10, drive: true }]
  })
  const r = await applyResult(workspace, ticket, result)
  assert.equal(r.ok, false)
  assert.equal(r.written.length, 0)
})

check('the inline ceiling is the documented 1 MiB', () => {
  assert.equal(INLINE_CEILING, 1024 * 1024)
})

console.log(`\n${ok} ok, ${bad} failed`)
console.log(`tmp left at: ${TMP}`)
process.exitCode = bad === 0 ? 0 : 1
