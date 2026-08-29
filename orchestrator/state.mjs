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
  TICKET_DONE: 'ticket:done',
  TICKET_FAILED: 'ticket:failed',
  CI_PASS: 'ci:pass',
  CI_FAIL: 'ci:fail',
  VIOLATION: 'violation'
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
      if (e.type === EVENTS.CI_FAIL) state[e.ticketId] = 'ci-failed'
      if (e.type === EVENTS.TICKET_FAILED) state[e.ticketId] = 'failed'
      if (e.type === EVENTS.TICKET_DONE) state[e.ticketId] = 'done'
    }
    return state
  }

  done() {
    const state = this.ticketStates()
    return Object.keys(state).filter((id) => state[id] === 'done')
  }

  // What was left half-finished: assigned and never closed. This is what the
  // next day's cron picks up instead of redoing everything from scratch.
  pending() {
    const state = this.ticketStates()
    return Object.keys(state).filter((id) => state[id] !== 'done')
  }

  attemptsFor(ticketId) {
    return this.events.filter((e) => e.ticketId === ticketId && e.type === EVENTS.TICKET_ASSIGNED)
      .length
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
        current = { start: e.ts, done: 0, failed: 0, violations: 0 }
        runs.push(current)
      }
      if (!current) continue
      if (e.type === EVENTS.TICKET_DONE) current.done++
      if (e.type === EVENTS.TICKET_FAILED) current.failed++
      if (e.type === EVENTS.VIOLATION) current.violations++
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
