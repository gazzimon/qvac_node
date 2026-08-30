// The `qvac/task/v0` message layer, tested with no transport at all — the whole
// point of keeping it in its own import-free module.
//
//   node test/task-protocol-test.mjs

import assert from 'assert'
import {
  TASK_PROTOCOL,
  TYPES,
  mintAttemptId,
  ticketIdOf,
  buildAssign,
  buildAccept,
  buildReject,
  buildProgress,
  buildResult,
  validateInbound,
  timeoutsForAssignment
} from '../orchestrator/task-protocol.mjs'
import { hashContent } from '../orchestrator/hash.mjs'
import { Harness } from '../orchestrator/harness.mjs'

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

check('attemptId is unique per call and carries the ticketId', () => {
  const a = mintAttemptId('db')
  const b = mintAttemptId('db')
  assert.notEqual(a, b)
  assert.equal(ticketIdOf(a), 'db')
  assert.equal(ticketIdOf('db#abc123'), 'db')
  assert.equal(ticketIdOf('no-hash'), 'no-hash')
})

check('mintAttemptId rejects a missing ticketId', () => {
  assert.throws(() => mintAttemptId())
})

check('buildAssign produces a well-formed, versioned message', () => {
  const m = buildAssign({
    attemptId: 'db#x',
    ticketId: 'db',
    spec: 'build the db',
    allowedFiles: ['src/db.js', 'tests/db.test.js'],
    contextDrive: 'a'.repeat(64),
    contextPaths: ['src/schema.js'],
    limits: { maxSteps: 8 },
    deadline: 123
  })
  assert.equal(m.type, TYPES.ASSIGN)
  assert.equal(m.protocol, TASK_PROTOCOL)
  assert.deepEqual(m.allowedFiles, ['src/db.js', 'tests/db.test.js'])
  assert.equal(m.limits.maxSteps, 8)
  assert.equal(m.limits.maxTokens, null)
  assert.equal(validateInbound(m).ok, true)
})

check('buildAssign refuses spec / allowedFiles that cannot work', () => {
  assert.throws(() => buildAssign({ attemptId: 'a', ticketId: 't', spec: '  ', allowedFiles: ['x'] }))
  assert.throws(() => buildAssign({ attemptId: 'a', ticketId: 't', spec: 'do', allowedFiles: [] }))
})

check('accept / reject round-trip through validateInbound', () => {
  const a = buildAccept({ attemptId: 'db#x', etaMs: 90000 })
  assert.equal(a.accepted, true)
  assert.equal(a.etaMs, 90000)
  assert.equal(validateInbound(a).ok, true)

  const r = buildReject({ attemptId: 'db#x', reason: 'at-capacity' })
  assert.equal(r.accepted, false)
  assert.equal(validateInbound(r).ok, true)

  assert.throws(() => buildReject({ attemptId: 'db#x', reason: 'made-up' }))
})

check('progress carries measurable numbers only', () => {
  const p = buildProgress({ attemptId: 'db#x', bytes: 1200, chunks: 5, ttftMs: 800 })
  assert.equal(p.bytes, 1200)
  assert.equal(p.ttftMs, 800)
  assert.equal(validateInbound(p).ok, true)
})

check('buildResult accepts inline files and computes nothing itself', () => {
  const content = 'export const x = 1\n'
  const m = buildResult({
    attemptId: 'db#x',
    ok: true,
    files: [{ path: 'src/db.js', hash: hashContent(content), bytes: content.length, content }],
    usage: { steps: 1, tokens: 120, tokenSource: 'provider' }
  })
  assert.equal(m.ok, true)
  assert.equal(m.files[0].content, content)
  assert.equal(m.files[0].drive, undefined)
  assert.equal(validateInbound(m).ok, true)
})

check('buildResult accepts a drive-backed file only with a driveKey', () => {
  const f = { path: 'out/plan.pdf', hash: 'sha256:deadbeef', bytes: 9_000_000, drive: true }
  assert.throws(() => buildResult({ attemptId: 'a', ok: true, files: [f] }))
  const m = buildResult({ attemptId: 'a', ok: true, files: [f], driveKey: 'b'.repeat(64) })
  assert.equal(m.driveKey, 'b'.repeat(64))
  assert.equal(m.files[0].drive, true)
  assert.equal(m.files[0].content, undefined)
  assert.equal(validateInbound(m).ok, true)
})

check('buildResult rejects a failure reason it does not know', () => {
  assert.throws(() => buildResult({ attemptId: 'a', ok: false, reason: 'vibes' }))
  const m = buildResult({ attemptId: 'a', ok: false, reason: 'limit-reached' })
  assert.equal(m.reason, 'limit-reached')
})

check('validateInbound rejects a wrong or missing protocol version', () => {
  const m = buildAssign({ attemptId: 'a', ticketId: 't', spec: 'x', allowedFiles: ['f'] })
  assert.equal(validateInbound({ ...m, protocol: 'qvac/task/v1' }).reason, 'unsupported-protocol')
  assert.equal(validateInbound({ ...m, protocol: undefined }).reason, 'unsupported-protocol')
})

check('validateInbound rejects a task message missing its shape', () => {
  assert.equal(validateInbound({ type: 'task:assign', protocol: TASK_PROTOCOL }).ok, false)
  assert.equal(
    validateInbound({
      type: 'task:result',
      protocol: TASK_PROTOCOL,
      attemptId: 'a',
      ok: true,
      files: [{ path: 'x', hash: 'h' }]
    }).reason,
    'file-without-bytes'
  )
})

check('validateInbound ignores an unknown task type without throwing', () => {
  const v = validateInbound({ type: 'task:teleport', protocol: TASK_PROTOCOL, attemptId: 'a' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'unknown-task-type')
})

check('timeoutsForAssignment falls back to limits when there is no deadline', () => {
  const t = timeoutsForAssignment({ limits: { taskTimeoutMs: 90000, toolTimeoutMs: 30000 } })
  assert.deepEqual(t, { taskTimeoutMs: 90000, toolTimeoutMs: 30000 })
})

check('timeoutsForAssignment does not tighten anything when the deadline is generous', () => {
  const now = 1000
  const t = timeoutsForAssignment(
    { limits: { taskTimeoutMs: 90000, toolTimeoutMs: 30000 }, deadline: now + 10 * 90000 },
    { now }
  )
  assert.deepEqual(t, { taskTimeoutMs: 90000, toolTimeoutMs: 30000 })
})

check('timeoutsForAssignment clamps taskTimeoutMs to whatever is actually left', () => {
  const now = 1000
  const t = timeoutsForAssignment(
    { limits: { taskTimeoutMs: 90000, toolTimeoutMs: 30000 }, deadline: now + 20000 },
    { now }
  )
  assert.equal(t.taskTimeoutMs, 20000)
  // toolTimeoutMs must stay strictly under the clamped taskTimeoutMs, or a
  // Harness built from this would refuse to construct at all.
  assert.ok(t.toolTimeoutMs < t.taskTimeoutMs)
})

check('timeoutsForAssignment returns null once the deadline has already passed', () => {
  const now = 5000
  assert.equal(timeoutsForAssignment({ limits: {}, deadline: now - 1 }, { now }), null)
  assert.equal(timeoutsForAssignment({ limits: {}, deadline: now }, { now }), null)
})

check('timeoutsForAssignment keeps toolTimeoutMs strictly below a razor-thin taskTimeoutMs', () => {
  // Only ~500ms of real budget left — small enough that a naive fixed floor
  // for toolTimeoutMs (e.g. 1000ms) would land AT OR OVER taskTimeoutMs and
  // make the Harness this feeds refuse to construct at all.
  const t = timeoutsForAssignment({ limits: {}, deadline: 1500 }, { now: 1000 })
  assert.equal(t.taskTimeoutMs, 500)
  assert.ok(t.toolTimeoutMs < t.taskTimeoutMs, `${t.toolTimeoutMs} must be < ${t.taskTimeoutMs}`)
  assert.ok(t.toolTimeoutMs >= 1)
})

check('a sub-2ms remaining budget is treated as already expired, not as a degenerate schedule', () => {
  assert.equal(timeoutsForAssignment({ limits: {}, deadline: 1 }, { now: 0 }), null)
})

check('deadline: 0 is the documented sentinel for "no deadline", not "already expired"', () => {
  // buildAssign() defaults to 0 for exactly this reason — 0 must mean unset,
  // never a real Unix-ms timestamp in the past.
  const t = timeoutsForAssignment({ limits: {}, deadline: 0 }, { now: 0 })
  assert.notEqual(t, null)
})

check('every timeoutsForAssignment output actually builds a Harness, across a sweep of tight deadlines', () => {
  for (let remaining = 2; remaining <= 5000; remaining += 137) {
    const t = timeoutsForAssignment({ limits: {}, deadline: remaining }, { now: 0 })
    assert.ok(t, `remaining=${remaining} should still be schedulable`)
    // Must not throw — this IS the check.
    new Harness({ ...t, maxSteps: 1, maxTokens: 1 })
  }
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
