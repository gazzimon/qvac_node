// The `result:received` event and the resume path it exists for: a coordinator
// that dies between accepting a result and closing the ticket must not reassign
// and pay the inference again.
//
//   node test/state-resume-test.mjs

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { State, EVENTS } from '../orchestrator/state.mjs'

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-state-'))
function freshLog() {
  return path.join(TMP, 'runs-' + Math.random().toString(36).slice(2) + '.jsonl')
}

check('a received-but-unclosed result shows up in unfetchedResults()', () => {
  const s = new State(freshLog())
  s.append(EVENTS.RUN_START, { tickets: 1 })
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: 'db#1' })
  s.append(EVENTS.RESULT_RECEIVED, {
    ticketId: 'db',
    attemptId: 'db#1',
    ok: true,
    files: [{ path: 'src/db.js', hash: 'sha256:aa', bytes: 3, content: 'x\n' }]
  })
  // ...and then the process dies here, before mirror + CI.

  const pending = s.unfetchedResults()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].ticketId, 'db')
  assert.equal(pending[0].attemptId, 'db#1')
  assert.equal(pending[0].files[0].content, 'x\n')
  assert.deepEqual(s.done(), [])
})

check('the same log reloaded from disk still resumes (append-only survives a restart)', () => {
  const log = freshLog()
  const a = new State(log)
  a.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'api', attemptId: 'api#1' })
  a.append(EVENTS.RESULT_RECEIVED, { ticketId: 'api', attemptId: 'api#1', ok: true, files: [] })

  const b = new State(log) // a "new process" reading the same file
  assert.equal(b.unfetchedResults().length, 1)
  assert.equal(b.resultFor('api').attemptId, 'api#1')
})

check('once CI closes the ticket it is no longer unfetched', () => {
  const s = new State(freshLog())
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: 'db#1' })
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'db', attemptId: 'db#1', ok: true, files: [] })
  s.append(EVENTS.CI_PASS, { ticketId: 'db', ms: 10 })
  s.append(EVENTS.TICKET_DONE, { ticketId: 'db' })

  assert.deepEqual(s.unfetchedResults(), [])
  assert.deepEqual(s.done(), ['db'])
})

check('a CI failure leaves the ticket open but not "unfetched" — it needs a new attempt', () => {
  const s = new State(freshLog())
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: 'db#1' })
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'db', attemptId: 'db#1', ok: true, files: [] })
  s.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })

  assert.deepEqual(s.unfetchedResults(), [])
  assert.ok(s.pending().includes('db'))
})

check('resultFor returns the LAST result when a ticket was attempted twice', () => {
  const s = new State(freshLog())
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: 'db#1' })
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'db', attemptId: 'db#1', ok: false, files: [] })
  s.append(EVENTS.CI_FAIL, { ticketId: 'db', status: 'failed' })
  s.append(EVENTS.TICKET_ASSIGNED, { ticketId: 'db', attemptId: 'db#2' })
  s.append(EVENTS.RESULT_RECEIVED, { ticketId: 'db', attemptId: 'db#2', ok: true, files: [] })

  assert.equal(s.resultFor('db').attemptId, 'db#2')
  assert.equal(s.attemptsFor('db'), 2)
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
