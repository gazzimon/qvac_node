// The state that outlives the process: an append-only JSONL, same shape as the
// phase-10 batch accumulator.
//
// Append-only rather than a rewritten JSON: a cron killed mid-write leaves a
// truncated file, and with a whole-JSON document that means losing the entire
// history. With lines, one broken line is discarded and the rest survives.

import fs from 'fs'
import path from 'path'

export const EVENTS = {
  RUN_START: 'run:start',
  RUN_END: 'run:end',
  TICKET_ASSIGNED: 'ticket:assigned',
  // Logged the moment a `task:result` arrives and is validated, BEFORE the
  // mirror and CI. It carries the whole result payload (inline file bytes
  // included) so a coordinator that dies between receiving the result and
  // closing the ticket resumes from the log on restart instead of reassigning
  // and paying the inference again. Drive-backed overflow files are re-fetched
  // on resume — the worker is the 24/7 node and is still seeding.
  RESULT_RECEIVED: 'result:received',
  TICKET_DONE: 'ticket:done',
  TICKET_FAILED: 'ticket:failed',
  // A ticket that has failed (CI red, or the model produced nothing usable)
  // as many times as the retry ceiling allows. It stops being reassigned and
  // is reported for a human to look at — without this, an unattended nightly
  // run reassigns a stuck ticket every night forever.
  TICKET_BLOCKED: 'ticket:blocked',
  CI_PASS: 'ci:pass',
  CI_FAIL: 'ci:fail',
  VIOLATION: 'violation',
  // Logged when cumulative token spend across the whole project reaches the
  // configured budget. The coordinator stops assigning and reports.
  BUDGET_EXCEEDED: 'budget:exceeded'
}

export class State {
  constructor(logPath) {
    this.path = logPath
    this.events = []
    this.load()
  }

  load() {
    if (!fs.existsSync(this.path)) return 0

    const contents = fs.readFileSync(this.path, 'utf8')
    let discarded = 0

    for (const line of contents.split('\n')) {
      if (!line.trim()) continue
      try {
        this.events.push(JSON.parse(line))
      } catch {
        discarded++ // truncated line from a run that died mid-write
      }
    }

    return discarded
  }

  append(type, data = {}) {
    const event = { ts: new Date().toISOString(), type, ...data }
    this.events.push(event)

    const dir = path.dirname(this.path)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(this.path, JSON.stringify(event) + '\n')

    return event
  }

  // A ticket is done if its last event says so. The whole history is replayed
  // rather than kept in a counter, because a counter dies with the process and
  // the history does not.
  ticketStates() {
    const state = {}
    for (const e of this.events) {
      if (!e.ticketId) continue
      if (e.type === EVENTS.TICKET_ASSIGNED) state[e.ticketId] = 'assigned'
      // Received but not yet mirrored + CI'd. A later ci:* or ticket:done
      // event, processed after this one, moves it on; if the log ends here the
      // coordinator died mid-close and `unfetchedResults()` picks it up.
      if (e.type === EVENTS.RESULT_RECEIVED) state[e.ticketId] = 'result-pending'
      if (e.type === EVENTS.CI_FAIL) state[e.ticketId] = 'ci-failed'
      if (e.type === EVENTS.TICKET_FAILED) state[e.ticketId] = 'failed'
      if (e.type === EVENTS.TICKET_BLOCKED) state[e.ticketId] = 'blocked'
      if (e.type === EVENTS.TICKET_DONE) state[e.ticketId] = 'done'
    }
    return state
  }

  // The last result payload logged for a ticket, or null. Used both to resume a
  // half-closed ticket and to reject a stale attempt's late delivery: the
  // caller compares `attemptId`.
  resultFor(ticketId) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]
      if (e.ticketId === ticketId && e.type === EVENTS.RESULT_RECEIVED) return e
    }
    return null
  }

  // Tickets whose last state is a received-but-unclosed result: the coordinator
  // logged `result:received` and then did not reach `ci:*`/`ticket:done`. On
  // startup these are re-applied from the log instead of being reassigned.
  unfetchedResults() {
    const state = this.ticketStates()
    return Object.keys(state)
      .filter((id) => state[id] === 'result-pending')
      .map((id) => this.resultFor(id))
      .filter(Boolean)
  }

  done() {
    const state = this.ticketStates()
    return Object.keys(state).filter((id) => state[id] === 'done')
  }

  // Escalated: tried the ceiling number of times and never went green. Not
  // pending (the nightly run must not keep spending on it) and not done.
  blocked() {
    const state = this.ticketStates()
    return Object.keys(state).filter((id) => state[id] === 'blocked')
  }

  // What was left half-finished: assigned and never closed, and NOT blocked.
  // This is what the next day's cron picks up instead of redoing everything.
  pending() {
    const state = this.ticketStates()
    return Object.keys(state).filter((id) => state[id] !== 'done' && state[id] !== 'blocked')
  }

  attemptsFor(ticketId) {
    return this.events.filter((e) => e.ticketId === ticketId && e.type === EVENTS.TICKET_ASSIGNED)
      .length
  }

  // Productive failures only: CI went red, or the model produced nothing
  // usable (`ticket:failed` with a reason other than `unplaced`, which just
  // means no worker was free — not the ticket's fault). This is what the
  // retry ceiling counts against, so a ticket nobody could pick up does not
  // burn its budget on connectivity problems.
  failuresFor(ticketId) {
    return this.events.filter(
      (e) =>
        e.ticketId === ticketId &&
        (e.type === EVENTS.CI_FAIL ||
          (e.type === EVENTS.TICKET_FAILED && e.reason && e.reason !== 'unplaced'))
    ).length
  }

  // Cumulative token spend across every result ever logged for this project —
  // what the global budget is measured against. Uses the number the worker
  // reported (`usage.tokens`), provider-counted or gateway-estimated.
  tokensSpent() {
    let n = 0
    for (const e of this.events) {
      if (e.type === EVENTS.RESULT_RECEIVED && e.usage && Number.isFinite(e.usage.tokens)) {
        n += e.usage.tokens
      }
    }
    return n
  }

  lastRun() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === EVENTS.RUN_START) return this.events[i]
    }
    return null
  }

  // The convergence signal: how many tickets each run closes. Two runs in a row
  // closing zero is the system spinning in place, and the moment to tell a
  // human instead of spending more.
  runSummaries() {
    const runs = []
    let current = null

    for (const e of this.events) {
      if (e.type === EVENTS.RUN_START) {
        current = { start: e.ts, done: 0, failed: 0, blocked: 0, violations: 0, tokens: 0 }
        runs.push(current)
      }
      if (!current) continue
      if (e.type === EVENTS.TICKET_DONE) current.done++
      if (e.type === EVENTS.TICKET_FAILED) current.failed++
      if (e.type === EVENTS.TICKET_BLOCKED) current.blocked++
      if (e.type === EVENTS.VIOLATION) current.violations++
      if (e.type === EVENTS.RESULT_RECEIVED && e.usage && Number.isFinite(e.usage.tokens)) {
        current.tokens += e.usage.tokens
      }
      if (e.type === EVENTS.RUN_END) current.end = e.ts
    }

    return runs
  }

  isStalled(window = 2) {
    const runs = this.runSummaries()
    if (runs.length < window) return false
    return runs.slice(-window).every((r) => r.done === 0)
  }
}
