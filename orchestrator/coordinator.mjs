// The cross-machine coordinator: what the single-machine Orchestrator becomes
// when a worker stops being a child process and starts being another node.
//
// It owns requirements.md, the ticket queue and the CI gate — exactly as
// before. What changes is the middle: instead of `spawn(worker/run.mjs)` it
// sends `task:assign` over the connection the swarm already holds, and instead
// of running CI on the worker's local workspace (same directory, on one
// machine) it mirrors the declared files out of the result and runs CI on its
// own copy.
//
// -----------------------------------------------------------------------------
// WHAT RIDES WHAT
//
//   assignment / progress / result-metadata  → the Protomux control channel
//     (swarm.sendTask / swarm.addTaskListener). Small JSON; no contention worth
//     measuring with live inference on the same stream.
//
//   context (the tree the worker edits against)  → a read-only Hyperdrive in
//     the node's corestore, read sparsely by path OVER THE EXISTING CONNECTION.
//     No DHT announce: the peer link already replicates this corestore.
//
//   result bytes  → inline in `task:result` under the ceiling; the worker's
//     own drive (again over the existing connection) only for a large artefact.
//
// IDEMPOTENCY. `attemptId` is minted per assignment. Only the attempt currently
// live for a ticket is honoured; a superseded worker's late delivery is
// discarded with a log line, never silently. And `result:received` is written
// to the run log BEFORE the mirror, so a coordinator that dies mid-close
// resumes from the log instead of paying the inference again.
// -----------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import {
  parseRequirements,
  buildDAG,
  dependencyWaves,
  detectConcurrentOverlap,
  inheritedFiles
} from './split.mjs'
import { runCI } from './ci.mjs'
import { applyResult } from './mirror.mjs'
import { openContext, publishContext, updateContext } from './context-drive.mjs'
import { State, EVENTS } from './state.mjs'
import {
  TYPES,
  validateInbound,
  mintAttemptId,
  ticketIdOf,
  buildAssign
} from './task-protocol.mjs'

const DEFAULTS = {
  acceptTimeoutMs: 20000, // how long to wait for task:accept before trying another worker
  progressGraceMs: 120000, // no task:progress for this long ⇒ the attempt is a ghost
  ciTimeoutMs: 30000,
  // A ticket that has failed CI (or produced nothing usable) this many times
  // stops being reassigned and is escalated as `ticket:blocked`. 4 is a
  // guess, not a measurement: enough for a transient bad generation to
  // recover, few enough that an impossible ticket does not burn a week of
  // nightly inference. Override with --max-attempts.
  maxAttempts: 4,
  // Cumulative token ceiling for the whole project. 0 = no limit. The
  // coordinator checks it before each wave and stops assigning once spend
  // reaches it, logging `budget:exceeded`. --budget on the CLI.
  budgetTokens: 0,

  // -------------------------------------------------------------------------
  // THE DISCOVERY GATE
  //
  // `workers()` reads `swarm.peers`, which is a SNAPSHOT. A coordinator that
  // has just joined the topic has not finished discovering anyone yet, so
  // that snapshot is empty for a while — and "a while" is not milliseconds:
  // NOTES.md measures 4–7s with a warm directory, a 38s tail on loopback, and
  // 109s for a cold node in the real cross-machine run. Reading the snapshot
  // immediately is why the fiui demo needed FOUR coordinator invocations
  // before one of them found a worker.
  //
  // So: wait for at least `waitForWorkers` of them to show up, and only then
  // start assigning. A run that assigns nothing because nobody was there yet
  // is not a failed run, it is a run that started too early.
  // -------------------------------------------------------------------------
  waitForWorkers: 1,
  // 120s covers the 109s cold-start measurement with a little headroom. It is
  // an upper bound, not a delay: the wait returns the instant enough workers
  // are present, which on a warm directory is a few seconds.
  waitForWorkersMs: 120000,
  workerPollMs: 250
}

export class Coordinator {
  // swarm — must expose addTaskListener(fn)=>detach, sendTask(peerKey,msg)=>bool,
  //         and `peers` (Map<hexKey, { manifest }>). A fake with those three is
  //         enough to test this without a real swarm.
  // store — the node's corestore (the one the peer connections replicate).
  constructor({
    swarm,
    store,
    workspace = './build',
    storageDir = path.join('.qvac', 'coordinator'),
    requirementFile = './requirements.md',
    model = null,
    limits = {},
    // Per-ticket override for which context-drive paths are worth reading
    // first: { [ticketId]: string[] }. Merged on top of the default derived
    // in init() — see the comment there. A hint, not a limit: the worker may
    // still open anything else in the drive.
    contextHints = {},
    // Hex keys of the workers this run is configured to use. This is node
    // config (--worker on the CLI), not the signed manifest: the manifest
    // schema is frozen (manifest-v0.json, additionalProperties:false,
    // generated from a zod schema in a package outside this repo) and
    // advertising `security.acceptsTasks` there is future work gated on a
    // schemaVersion bump coordinated with that source. Until then, being on
    // the topic is not enough on its own — the coordinator only offers work to
    // a key it was explicitly told about, matching the "being on the topic
    // must not be enough" rule the rest of the authorization story follows.
    workerKeys = [],
    now = Date.now,
    ...opts
  } = {}) {
    this.swarm = swarm
    this.store = store
    this.workspace = path.resolve(workspace)
    this.storageDir = path.resolve(storageDir)
    this.requirementFile = requirementFile
    this.model = model
    this.limits = limits
    this.contextHints = contextHints
    this.workerKeys = workerKeys.map((k) => String(k).toLowerCase())
    this.now = now
    this.cfg = { ...DEFAULTS, ...opts }

    this.state = null
    this.tickets = []
    this.context = null // { drive, key }
    this.live = new Map() // ticketId -> attemptId currently in flight
    this._waiters = new Map() // attemptId -> { onAccept, onReject, onProgress, onResult }
    this._detach = null
  }

  log(m) {
    console.log(`[coord] ${m}`)
  }

  // Idempotent: run() always calls this, and a caller that wants to inspect
  // or adjust `this.tickets` before run() (tests do; see contextHints) can
  // call it once themselves first without run() undoing that by re-parsing
  // and, worse, attaching a second task listener over the first.
  async init() {
    if (this._detach) return

    fs.mkdirSync(this.storageDir, { recursive: true })
    fs.mkdirSync(this.workspace, { recursive: true })

    this.state = new State(path.join(this.storageDir, 'runs.jsonl'))

    if (!fs.existsSync(this.requirementFile)) {
      throw new Error(`requirements file not found: ${this.requirementFile}`)
    }
    this.tickets = parseRequirements(fs.readFileSync(this.requirementFile, 'utf8'))
    if (this.tickets.length === 0) throw new Error('requirements declares no tickets')

    // Looser than the single-machine `detectOverlap` on purpose: two tickets
    // may share a file as long as one DEPENDS on the other, because waves
    // then guarantee they never run at once. Only a shared file between
    // tickets that could be in the same wave is a real clash. See
    // detectConcurrentOverlap in split.mjs for the full reasoning.
    const clashes = detectConcurrentOverlap(this.tickets)
    if (clashes.length > 0) {
      const detail = clashes.map((c) => `${c.file} (${c.tickets.join(' and ')})`).join('; ')
      throw new Error(
        `two tickets that can run at the same time declare the same file: ${detail}` +
          ` — add a "Depends on:" between them, or give them separate files`
      )
    }

    // Validates `Depends on:` against the WHOLE ticket graph, once, here —
    // not against whatever subset happens to be pending on a given run. A
    // typo in a dependency id is a mistake in requirements.md; it has to fail
    // loud on the run that introduces it, not resolve itself the day the
    // typo'd ticket happens to already be done. `dependencyWaves()` in run()
    // trusts this validation already ran and does not repeat it.
    buildDAG(this.tickets)

    // Two derived per-ticket fields, both free of any model or heuristic:
    //
    //   editPaths    — files this ticket owns that a dependency already
    //                  created. The worker is shown their current content and
    //                  told to return them updated; the mirror is told not to
    //                  clear them. This is what lets a project GROW instead of
    //                  only accumulating new files.
    //   contextPaths — everything a dependency produces, as reference. An
    //                  explicit `contextHints` entry replaces this outright.
    const byId = new Map(this.tickets.map((t) => [t.id, t]))
    for (const ticket of this.tickets) {
      ticket.editPaths = inheritedFiles(this.tickets, ticket)

      if (this.contextHints[ticket.id]) {
        ticket.contextPaths = this.contextHints[ticket.id]
        continue
      }
      const fromDeps = ticket.deps.flatMap((depId) => byId.get(depId)?.allowedFiles || [])
      if (fromDeps.length > 0) ticket.contextPaths = fromDeps
    }

    // One inbound path for every task: message from a worker. Branch by type,
    // route by attemptId, drop anything for a dead attempt.
    this._detach = this.swarm.addTaskListener((peer, msg) => this._onTaskMessage(peer, msg))

    const editing = this.tickets.filter((t) => t.editPaths.length > 0).length
    this.log(
      `${this.tickets.length} tickets, no concurrent file clashes` +
        (editing ? `, ${editing} of them editing a dependency's file` : '')
    )
  }

  _onTaskMessage(peer, msg) {
    if (msg.type === TYPES.ASSIGN) return // that is ours to send, not receive

    const v = validateInbound(msg)
    if (!v.ok) {
      this.log(`ignored a ${msg.type} from ${peer.key.slice(0, 8)}…: ${v.reason}`)
      return
    }

    const ticketId = ticketIdOf(msg.attemptId)
    const liveAttempt = this.live.get(ticketId)
    if (msg.attemptId !== liveAttempt) {
      // The ghost from a reassigned attempt. Layer 1 of idempotency: said out
      // loud, then dropped.
      this.log(`discarded ${msg.type} for stale attempt ${msg.attemptId} (live: ${liveAttempt || 'none'})`)
      return
    }

    const w = this._waiters.get(msg.attemptId)
    if (!w) return

    if (msg.type === TYPES.ACCEPT) w.onAccept(msg)
    else if (msg.type === TYPES.REJECT) w.onReject(msg)
    else if (msg.type === TYPES.PROGRESS) w.onProgress(msg)
    else if (msg.type === TYPES.RESULT) w.onResult(msg)
  }

  // Connected peers this coordinator will actually place work on.
  //
  //   - `workerKeys` (config) is the primary source: an explicit key the
  //     operator configured, connected right now. This is what closes the
  //     gap the manifest cannot today — see the constructor note.
  //   - A peer whose manifest DOES advertise `security.acceptsTasks` (once a
  //     future schema version carries that field) is picked up too, so this
  //     does not need to change again the day the manifest catches up.
  //
  // Either way the manifest is already verified against the connection key —
  // identity is settled before this runs, this only decides who gets asked.
  workers() {
    const out = []
    for (const [key, peer] of this.swarm.peers) {
      const configured = this.workerKeys.includes(key.toLowerCase())
      const advertised = peer?.manifest?.security?.acceptsTasks === true
      if (!configured && !advertised) continue
      out.push({
        key,
        maxConcurrentTasks: peer?.manifest?.security?.maxConcurrentTasks || 1
      })
    }
    return out
  }

  // Wait until at least `want` workers are visible, or `timeoutMs` passes.
  // Returns the pool as it stands when the wait ends — possibly short, possibly
  // empty; the caller decides what that means.
  //
  // Polling rather than an event: the Coordinator is handed an already-built
  // swarm and only requires three things of it (`peers`, `sendTask`,
  // `addTaskListener`), which is what lets a fake stand in for a real one in
  // the tests. Subscribing to a peer-change event would add a fourth
  // requirement to that contract for no gain — a 250ms poll against an
  // in-memory Map costs nothing next to a discovery measured in seconds.
  async awaitWorkers(want = this.cfg.waitForWorkers, timeoutMs = this.cfg.waitForWorkersMs) {
    let pool = this.workers()
    if (pool.length >= want) return pool

    this.log(
      `waiting up to ${Math.round(timeoutMs / 1000)}s for ${want} worker(s)` +
        ` — discovery takes seconds to a minute+, see NOTES.md`
    )

    const deadline = this.now() + timeoutMs
    let lastReport = 0
    while (this.now() < deadline) {
      // NOT unref'd, deliberately. Waiting for the fleet is real work, and an
      // unref'd timer here lets the process exit mid-wait whenever nothing
      // else happens to be holding the event loop open — which is exactly the
      // situation this gate exists for.
      await new Promise((r) => setTimeout(r, this.cfg.workerPollMs))

      pool = this.workers()
      if (pool.length >= want) {
        this.log(`${pool.length} worker(s) available, starting`)
        return pool
      }

      // A line every 15s: silence during a two-minute wait is exactly what
      // makes an operator think the process hung. Same reason progress.mjs
      // exists for a slow generation.
      const waited = timeoutMs - (deadline - this.now())
      if (waited - lastReport >= 15000) {
        lastReport = waited
        this.log(`still waiting… ${Math.round(waited / 1000)}s, ${pool.length}/${want} worker(s)`)
      }
    }

    return pool
  }

  // Assign one ticket, once, to one worker. Resolves with the `task:result`
  // message, or rejects (no worker took it / it went silent / it refused). The
  // caller decides whether to retry with a fresh attemptId.
  assignOnce(ticket, worker) {
    const attemptId = mintAttemptId(ticket.id)
    this.live.set(ticket.id, attemptId)
    this.state.append(EVENTS.TICKET_ASSIGNED, {
      ticketId: ticket.id,
      attemptId,
      worker: worker.key,
      attempt: this.state.attemptsFor(ticket.id) + 1
    })

    // Derived from the SAME taskTimeoutMs advertised in `limits`, not from the
    // progress watchdog: those are two different clocks. `progressGraceMs` is
    // about a missing HEARTBEAT and can renew indefinitely as long as
    // task:progress keeps arriving (armWatchdog() below); `deadline` is the
    // one absolute ceiling on the whole attempt, and the worker actually reads
    // it now (worker/task-accept.mjs, timeoutsForAssignment) to clamp its own
    // harness. The +30s is headroom for the worker's own timeout to fire and
    // its task:result to arrive BEFORE the coordinator's deadline lapses — in
    // the normal case this never clamps anything on the worker's side; it only
    // bites if the message sat in transit long enough to eat into the budget.
    const taskTimeoutMs = this.limits.taskTimeoutMs || 1800000
    const deadline = this.now() + taskTimeoutMs + 30000
    const assign = buildAssign({
      attemptId,
      ticketId: ticket.id,
      spec: ticket.spec,
      allowedFiles: ticket.allowedFiles,
      contextDrive: this.context?.key || null,
      contextPaths: ticket.contextPaths || [],
      editPaths: ticket.editPaths || [],
      limits: this.limits,
      deadline
    })

    return new Promise((resolve, reject) => {
      let settled = false
      let watchdog = null
      const done = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(acceptTimer)
        clearTimeout(watchdog)
        this._waiters.delete(attemptId)
        fn(arg)
      }

      const armWatchdog = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => {
          this.log(`${ticket.id}: no progress for ${Math.round(this.cfg.progressGraceMs / 1000)}s — abandoning ${attemptId}`)
          done(reject, new Error('worker went silent'))
        }, this.cfg.progressGraceMs)
        if (watchdog.unref) watchdog.unref()
      }

      const acceptTimer = setTimeout(() => {
        done(reject, new Error('no task:accept'))
      }, this.cfg.acceptTimeoutMs)
      if (acceptTimer.unref) acceptTimer.unref()

      this._waiters.set(attemptId, {
        onAccept: (m) => {
          this.log(`${ticket.id}: accepted by ${worker.key.slice(0, 8)}…${m.etaMs ? ` (eta ${Math.round(m.etaMs / 1000)}s)` : ''}`)
          clearTimeout(acceptTimer)
          armWatchdog()
        },
        onReject: (m) => {
          this.log(`${ticket.id}: refused (${m.reason}) by ${worker.key.slice(0, 8)}…`)
          done(reject, new Error(`refused: ${m.reason}`))
        },
        onProgress: () => armWatchdog(),
        onResult: (m) => done(resolve, m)
      })

      if (!this.swarm.sendTask(worker.key, assign)) {
        done(reject, new Error('worker is not connected'))
      }
    })
  }

  // Accept a `task:result`: verify + mirror + CI, all keyed on the run log so a
  // crash anywhere in here resumes rather than reassigns.
  async acceptResult(ticket, result) {
    // Written BEFORE the mirror. If the process dies now, `resume()` finds this
    // and re-applies from here — the inference is not paid twice.
    this.state.append(EVENTS.RESULT_RECEIVED, {
      ticketId: ticket.id,
      attemptId: result.attemptId,
      ok: result.ok,
      files: result.files,
      rejected: result.rejected || [],
      usage: result.usage || {},
      driveKey: result.driveKey || null,
      reason: result.reason || null
    })

    return this._applyAndVerify(ticket, result)
  }

  async _applyAndVerify(ticket, result) {
    // The worker's OWN jail already caught the honest mistake and left it out
    // of `files` entirely — this is that report arriving. Logged here, not
    // just on the worker's machine, because "how often did a worker try to
    // step outside its ticket" is a number about THAT worker, and the
    // coordinator is the one deciding who to route to next time.
    for (const r of result.rejected || []) {
      this.state.append(EVENTS.VIOLATION, {
        ticketId: ticket.id,
        path: r.path,
        reason: r.reason,
        side: 'worker'
      })
    }

    if (!result.ok) {
      this.state.append(EVENTS.TICKET_FAILED, { ticketId: ticket.id, reason: result.reason })
      this.log(`${ticket.id}: worker produced nothing (${result.reason})`)
      return { passed: false, status: 'no-result' }
    }

    let fetchFromDrive = null
    let resultDrive = null
    if (result.driveKey) {
      resultDrive = await openContext(this.store, result.driveKey, { timeoutMs: this.cfg.ciTimeoutMs })
      fetchFromDrive = (p) => resultDrive.readFile(p)
    }

    // `keepPaths`: a file this ticket inherited from a dependency is never
    // cleared before applying. If this ticket's model does not reproduce it,
    // the right outcome is "the edit did not happen", not "the dependency's
    // file is gone".
    const applied = await applyResult(this.workspace, ticket, result, {
      fetchFromDrive,
      keepPaths: ticket.editPaths || []
    })
    await resultDrive?.close().catch(() => {})

    // The coordinator's OWN re-check on arrival — the same allowedFiles jail,
    // run a second time, catching the dishonest worker rather than the honest
    // mistake. Should normally be empty: anything here is a file the worker
    // sent that its own jail should have already stopped.
    for (const r of applied.rejected) {
      this.state.append(EVENTS.VIOLATION, {
        ticketId: ticket.id,
        path: r.path,
        reason: r.reason,
        side: 'coordinator'
      })
    }

    if (!applied.ok) {
      this.state.append(EVENTS.CI_FAIL, {
        ticketId: ticket.id,
        status: 'mirror-rejected',
        stderr: JSON.stringify(applied.mismatched).slice(0, 500)
      })
      this.log(`${ticket.id}: result rejected on arrival (${applied.mismatched.map((m) => m.reason).join(', ')})`)
      return { passed: false, status: 'mirror-rejected' }
    }

    this.log(`${ticket.id}: mirrored ${applied.written.length} file(s)${applied.cleared.length ? `, cleared ${applied.cleared.length} stale` : ''}`)

    const ci = await runCI(this.workspace, ticket, { timeout: this.cfg.ciTimeoutMs })
    if (ci.passed) {
      this.state.append(EVENTS.CI_PASS, { ticketId: ticket.id, ms: ci.duration })
      this.state.append(EVENTS.TICKET_DONE, { ticketId: ticket.id })
      this.log(`${ticket.id}: CI green`)
    } else {
      this.state.append(EVENTS.CI_FAIL, {
        ticketId: ticket.id,
        status: ci.status,
        stderr: (ci.stderr || '').slice(0, 500)
      })
      this.log(`${ticket.id}: CI red (${ci.status})`)
    }
    return ci
  }

  // On startup: re-apply any result that was received but never closed. The
  // worker may be gone; the bytes are in the log (inline) or still seeded
  // (drive). Either way this does not reassign.
  async resume() {
    const pending = this.state.unfetchedResults()
    if (pending.length === 0) return 0

    this.log(`${pending.length} result(s) received last run but not closed — resuming`)
    let done = 0
    for (const ev of pending) {
      const ticket = this.tickets.find((t) => t.id === ev.ticketId)
      if (!ticket) continue
      try {
        const ci = await this._applyAndVerify(ticket, ev)
        if (ci.passed) done++
      } catch (err) {
        this.log(`resume of ${ev.ticketId} failed: ${(err && err.message) || err}`)
      }
    }
    return done
  }

  pending() {
    const settled = new Set([...this.state.done(), ...this.state.blocked()])
    return this.tickets.filter((t) => !settled.has(t.id))
  }

  async run() {
    await this.init()
    this.state.append(EVENTS.RUN_START, { tickets: this.tickets.length })

    await this.resume()

    let todo = this.pending()

    // Retry ceiling: a ticket that has failed CI (or produced nothing usable)
    // maxAttempts times stops being reassigned. Logged as `ticket:blocked`,
    // reported in the summary, and — the point — NOT retried tonight or any
    // night after. Without this an impossible ticket burns inference on every
    // wake-up forever.
    const overCeiling = todo.filter(
      (t) => this.state.failuresFor(t.id) >= this.cfg.maxAttempts
    )
    for (const t of overCeiling) {
      const failures = this.state.failuresFor(t.id)
      this.state.append(EVENTS.TICKET_BLOCKED, { ticketId: t.id, failures })
      this.log(`${t.id}: BLOCKED after ${failures} failed attempt(s) — needs a human`)
    }
    todo = todo.filter((t) => !overCeiling.includes(t))

    // Recorded before any placement so `run:end` can say whether this run had
    // anything to do at all — a finished project must not read as stalled.
    this._pendingAtStart = todo.length

    this.log(`${todo.length} pending out of ${this.tickets.length}`)
    if (todo.length === 0) {
      this.endRun()
      return this.summary()
    }

    // Global budget: stop before starting a run that is already over.
    if (this.overBudget()) {
      this.state.append(EVENTS.BUDGET_EXCEEDED, {
        tokensSpent: this.state.tokensSpent(),
        budgetTokens: this.cfg.budgetTokens
      })
      this.log(
        `budget exhausted: ${this.state.tokensSpent()} / ${this.cfg.budgetTokens} tokens — not assigning`
      )
      this.endRun()
      return this.summary()
    }

    // THE DISCOVERY GATE — before publishing anything or touching a ticket.
    // See the DEFAULTS block for why reading `workers()` immediately is wrong.
    const pool = await this.awaitWorkers()
    if (pool.length === 0) {
      // Deliberately NOT marked as failed tickets. Nobody was there to do the
      // work; the tickets are untouched and the next wake-up tries again. A
      // run that found no workers is an infrastructure fact, not a project
      // that is stuck, and the two must not look the same in the log.
      this._noWorkers = true
      this.log(
        `no workers appeared in ${Math.round(this.cfg.waitForWorkersMs / 1000)}s — ` +
          `nothing assigned, ${todo.length} ticket(s) left untouched for the next run`
      )
      this.endRun()
      return this.summary()
    }

    // Publish the workspace once for this run. A later run that changed the
    // tree re-publishes.
    this.context = await publishContext(this.store, this.workspace)
    this.log(`context drive ${this.context.key.slice(0, 12)}… (v${this.context.drive.version})`)

    // `Depends on:` IS respected here, by wave: nothing in wave N depends on
    // anything else in wave N (dependencyWaves() guarantees that), so a wave's
    // tickets run in parallel with no merge step — detectOverlap already
    // guarantees their files are disjoint too. Waves run in series, and only
    // a ticket already closed BEFORE this run (`doneIds`) counts as satisfied
    // going in; a dependency this same run has not gotten to yet holds its
    // dependents in a later wave.
    const doneIds = new Set(this.state.done())
    const waves = dependencyWaves(todo, { doneIds })
    this.log(`${waves.length} wave(s): ${waves.map((w) => w.length).join(', ')}`)

    // Chunked by total capacity across the connected pool (one slot per
    // `maxConcurrentTasks` a worker advertises, so a single worker willing to
    // hold two tasks gets two): one round of `Promise.all` per chunk, spread
    // round-robin, series across chunks — the same shape runBatch() uses on
    // one machine, now over the wire, nested one level inside the wave loop.
    // `pool` is what the discovery gate settled on above, not a fresh snapshot.
    const slots = pool.flatMap((w) => Array(Math.max(1, w.maxConcurrentTasks)).fill(w))

    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w]

      // A long run can cross the budget mid-way. Checked per wave (not per
      // ticket) so a wave already in flight finishes, but no new wave
      // starts — overshoot is bounded by one wave's worth of tokens.
      if (this.overBudget()) {
        this.state.append(EVENTS.BUDGET_EXCEEDED, {
          tokensSpent: this.state.tokensSpent(),
          budgetTokens: this.cfg.budgetTokens
        })
        this.log(
          `budget exhausted mid-run at wave ${w + 1}/${waves.length}` +
            ` (${this.state.tokensSpent()} / ${this.cfg.budgetTokens} tokens) — stopping`
        )
        break
      }

      // A later wave's tickets may need to read a file an earlier wave just
      // wrote. Re-publish before assigning anything in this wave; without
      // it, a worker here would still see the tree as it stood at the top
      // of the run, dependency or not.
      if (w > 0) {
        const changed = await updateContext(this.context.drive, this.workspace)
        this.log(
          `context drive updated for wave ${w + 1}/${waves.length}` +
            ` (${changed} file(s) changed, v${this.context.drive.version})`
        )
      }

      for (let i = 0; i < wave.length; i += slots.length) {
        const group = wave.slice(i, i + slots.length)
        await Promise.all(group.map((ticket, j) => this._placeTicket(ticket, slots, j)))
      }
    }

    this.endRun()
    return this.summary()
  }

  overBudget() {
    return this.cfg.budgetTokens > 0 && this.state.tokensSpent() >= this.cfg.budgetTokens
  }

  // `pendingAtStart` is what lets isStalled() tell "tried and got nowhere"
  // from "nothing left to do" — see its comment in state.mjs. Set once, at
  // the top of run(), before anything is placed.
  endRun() {
    this.state.append(EVENTS.RUN_END, {
      done: this.state.done().length,
      blocked: this.state.blocked().length,
      pendingAtStart: this._pendingAtStart ?? null,
      // A run that never found a worker attempted nothing. Recorded so stall
      // detection can skip it: two nights with the fleet down is not the
      // project spinning in place, and must not accuse the tickets.
      noWorkers: this._noWorkers === true,
      tokensSpent: this.state.tokensSpent()
    })
    if (this.state.isStalled()) {
      this.log('WARNING: two runs in a row closed no ticket — look before spending more')
    }
    if (this.state.blocked().length > 0) {
      this.log(`WARNING: ${this.state.blocked().length} ticket(s) blocked — see ${path.join(this.storageDir, 'runs.jsonl')}`)
    }
  }

  // Try each slot, starting at `startAt` (this ticket's round-robin position
  // within its group) and wrapping around, so two tickets in the same group
  // prefer different slots instead of piling onto the first one. `slots` may
  // repeat a worker (once per `maxConcurrentTasks` it advertises). Falls
  // through to the next slot on a refusal or a silent attempt.
  async _placeTicket(ticket, slots, startAt) {
    for (let k = 0; k < slots.length; k++) {
      const worker = slots[(startAt + k) % slots.length]
      try {
        const result = await this.assignOnce(ticket, worker)
        await this.acceptResult(ticket, result)
        return
      } catch (err) {
        this.log(`${ticket.id}: ${(err && err.message) || err} — next worker`)
      }
    }
    this.state.append(EVENTS.TICKET_FAILED, { ticketId: ticket.id, reason: 'unplaced' })
  }

  summary() {
    const done = this.state.done()
    const blocked = this.state.blocked()
    const r = {
      total: this.tickets.length,
      done: done.length,
      blocked: blocked.length,
      blockedIds: blocked,
      pending: this.tickets.length - done.length - blocked.length,
      stalled: this.state.isStalled(),
      // True when the discovery gate timed out with nobody there. Distinct
      // from `stalled`: nothing was attempted, so nothing failed.
      noWorkers: this._noWorkers === true,
      tokensSpent: this.state.tokensSpent(),
      budgetTokens: this.cfg.budgetTokens || null,
      overBudget: this.overBudget(),
      contextKey: this.context?.key || null
    }
    this.log(
      `summary: ${r.done}/${r.total} closed` +
        (r.blocked ? `, ${r.blocked} blocked` : '') +
        (r.noWorkers ? ', NO WORKERS FOUND' : '') +
        `, ${r.tokensSpent} tokens${r.budgetTokens ? ` / ${r.budgetTokens}` : ''}`
    )
    return r
  }

  async close() {
    if (this._detach) this._detach()
    this._detach = null
    if (this.context?.drive) await this.context.drive.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// CLI — `node orchestrator/coordinator.mjs --worker <hex-key[,hex-key...]> ...`
//
// Opens its OWN identity, corestore and marketplace connection — same pattern
// as worker/serve-tasks.mjs, on the other side of the wire. Plain Node
// throughout, same reasoning as that file's header: this never runs under
// Bare.
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCliArgv(process.argv.slice(2))
  if (!opts.worker) {
    console.error(
      '[coord] --worker <hex-key[,hex-key...]> is required: without it there is nobody to assign to.'
    )
    process.exit(1)
  }

  const os = await import('os')
  const Corestore = (await import('corestore')).default
  const { NodeSwarm } = await import('../qvac/swarm.mjs')
  const { loadOrCreateIdentity } = await import('./node-identity.mjs')

  const swarmDir = path.resolve(opts.swarmStorage || path.join('.qvac', 'coordinator-swarm'))
  fs.mkdirSync(swarmDir, { recursive: true })
  const identity = loadOrCreateIdentity(swarmDir)
  const store = new Corestore(path.join(swarmDir, 'corestore'))
  await store.ready()

  const swarm = new NodeSwarm({
    identity,
    // Same "advertises no chat capacity" shape as the worker side — this peer
    // exists on the topic to send task:assign, not to serve completions.
    models: [{ modelId: 'coordinator', displayName: 'Coordinator (no chat)', maxConcurrentRequests: 0 }],
    operator: opts.operator || `coordinator@${os.default.hostname()}`,
    tags: ['coordinator'],
    corestore: store
  })
  await swarm.join()
  console.log(`[coord] identity: ${identity.publicKey.toString('hex')}`)

  const coord = new Coordinator({
    swarm,
    store,
    workspace: opts.workspace,
    storageDir: opts.storage,
    requirementFile: opts.requirement,
    model: opts.model,
    workerKeys: opts.worker.split(',').map((k) => k.trim()).filter(Boolean),
    limits: {
      maxSteps: opts.maxSteps ? +opts.maxSteps : undefined,
      maxTokens: opts.maxTokens ? +opts.maxTokens : undefined
    },
    ...(opts.maxAttempts ? { maxAttempts: +opts.maxAttempts } : {}),
    ...(opts.budget ? { budgetTokens: +opts.budget } : {}),
    ...(opts.waitWorkers ? { waitForWorkers: +opts.waitWorkers } : {}),
    ...(opts.waitTimeout ? { waitForWorkersMs: +opts.waitTimeout * 1000 } : {})
  })

  try {
    const summary = await coord.run()
    // Exit code carries the state a nightly wrapper needs to branch on without
    // parsing the log: 0 = made progress or nothing to do, 2 = a ticket is
    // blocked and needs a human, 3 = the budget stopped the run, 4 = no worker
    // was reachable (an infrastructure problem, not a project problem).
    let code = 0
    if (summary.overBudget) code = 3
    else if (summary.blocked > 0) code = 2
    else if (summary.noWorkers) code = 4
    process.exitCode = code
  } finally {
    await coord.close()
    await swarm.destroy()
    await store.close()
  }
}

function parseCliArgv(argv) {
  const alias = {
    '--worker': 'worker',
    '--requirement': 'requirement',
    '--workspace': 'workspace',
    '--storage': 'storage',
    '--swarm-storage': 'swarmStorage',
    '--model': 'model',
    '--operator': 'operator',
    '--max-steps': 'maxSteps',
    '--max-tokens': 'maxTokens',
    '--max-attempts': 'maxAttempts',
    '--budget': 'budget',
    '--wait-workers': 'waitWorkers', // how many to wait for before assigning
    '--wait-timeout': 'waitTimeout' // seconds; discovery can take a minute+
  }
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const key = alias[argv[i]]
    if (key) opts[key] = argv[++i]
  }
  return opts
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
