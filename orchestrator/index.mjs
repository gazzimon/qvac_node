// The orchestrator: owner of requirements.md, of the ticket queue, and of the
// CI gate. Workers never see the whole document — each one gets a ticket with
// the exact list of files it may touch.
//
// -----------------------------------------------------------------------------
// ONE DRIVE PER WORKER, NOT A SHARED ONE
//
// Hypercore is SINGLE-WRITER. A Hyperdrive opened by key is read-only, and
// `put()` on it does not fail — it HANGS. Measured. So there is no "one
// workspace everybody writes to": each worker creates ITS drive, is its writer,
// and announces the key. The orchestrator mounts them read-only and joins them.
//
// The union has no conflicts by construction: `detectOverlap` aborts before
// assigning anything if two tickets declare the same file, so two drives never
// carry the same path. That is what replaces the branch merge — conflicts are
// not resolved, they are made impossible.
// -----------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import Corestore from 'corestore'
import { parseRequirements, buildDAG, assignTickets } from './split.mjs'
import { runCI } from './ci.mjs'
import { State, EVENTS } from './state.mjs'

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
)

// Two tickets declaring the same file is a merge conflict waiting to happen.
// It is cut here, before anything is assigned: fixing requirements.md is
// cheaper than resolving the conflict afterwards.
export function detectOverlap(tickets) {
  const owner = new Map()
  const clashes = []

  for (const t of tickets) {
    for (const f of t.allowedFiles) {
      if (owner.has(f)) {
        clashes.push({ file: f, tickets: [owner.get(f), t.id] })
      } else {
        owner.set(f, t.id)
      }
    }
  }

  return clashes
}

export class Orchestrator {
  constructor(opts = {}) {
    this.gateway = opts.gateway || 'http://localhost:8787'
    this.apiKey = opts.apiKey || null
    this.model = opts.model || null
    this.workspace = path.resolve(opts.workspace || './build')
    this.numWorkers = parseInt(opts.workers) || 2
    this.maxSteps = parseInt(opts.maxSteps) || 10
    this.maxTokens = parseInt(opts.maxTokens) || 8000
    this.toolTimeout = opts.toolTimeout || null
    this.storageDir = path.resolve(opts.storage || path.join('.qvac', 'orchestrator'))
    this.requirementFile = opts.requirement || './requirements.md'
    this.dryRun = opts.dryRun === true

    this.store = null
    this.tickets = []
    this.state = null
    this.workerDrives = {} // ticketId -> hex key of that worker's drive
  }

  log(msg) {
    console.log(`[orch] ${msg}`)
  }

  async init() {
    for (const dir of [this.storageDir, this.workspace]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }

    this.state = new State(path.join(this.storageDir, 'runs.jsonl'))

    // The corestore gets its OWN subdirectory, and this is not tidiness.
    // `new Corestore(dir).ready()` WIPES a directory whose contents it does not
    // recognise as a corestore — measured: a `requirements.md` written into
    // that directory a moment earlier was gone after `ready()`, replaced by
    // CORESTORE and db. Anything else we keep under --storage (the run log, the
    // per-worker directories, a requirements file someone put there) would be
    // destroyed the first time the orchestrator opened it.
    this.store = new Corestore(path.join(this.storageDir, 'corestore'))
    await this.store.ready()

    this.log(`workspace: ${this.workspace}`)

    if (!fs.existsSync(this.requirementFile)) {
      throw new Error(`requirements file not found: ${this.requirementFile}`)
    }

    this.tickets = parseRequirements(fs.readFileSync(this.requirementFile, 'utf8'))
    if (this.tickets.length === 0) throw new Error('requirements declares no tickets')

    const clashes = detectOverlap(this.tickets)
    if (clashes.length > 0) {
      const detail = clashes.map((c) => `${c.file} (${c.tickets.join(' and ')})`).join('; ')
      throw new Error(`two tickets declare the same file: ${detail}`)
    }

    this.log(`${this.tickets.length} tickets, no overlapping files`)
  }

  // Whatever closed in an earlier run is not done again. This is what stops the
  // day-4 cron from redoing day 3.
  pending() {
    const done = new Set(this.state.done())
    return this.tickets.filter((t) => !done.has(t.id))
  }

  workerStorage(ticketId) {
    return path.join(this.storageDir, 'workers', ticketId)
  }

  spawnWorker(ticket) {
    const args = [
      path.join(ROOT, 'worker', 'run.mjs'),
      '--gateway', this.gateway,
      '--ticket', ticket.id,
      '--spec', ticket.spec,
      '--allowed-files', ticket.allowedFiles.join(','),
      '--workspace', this.workspace,
      '--max-steps', String(this.maxSteps),
      '--max-tokens', String(this.maxTokens),
      '--storage', this.workerStorage(ticket.id)
    ]
    if (this.apiKey) args.push('--api-key', this.apiKey)
    if (this.model) args.push('--model', this.model)
    if (this.toolTimeout) args.push('--tool-timeout', String(this.toolTimeout))

    return new Promise((resolve) => {
      const proc = spawn(process.execPath, args, { stdio: 'inherit' })
      proc.on('exit', (code) => {
        // The worker drops its key on disk at startup. That is what lets the
        // orchestrator mount its drive afterwards — and what will travel over
        // the swarm once workers run on other machines.
        const p = path.join(this.workerStorage(ticket.id), 'drive-key')
        if (fs.existsSync(p)) {
          this.workerDrives[ticket.id] = fs.readFileSync(p, 'utf8').trim()
        }
        resolve({ ticketId: ticket.id, ok: code === 0, code })
      })
      proc.on('error', (err) => resolve({ ticketId: ticket.id, ok: false, error: err.message }))
    })
  }

  // Tickets in one batch run in parallel because their files are disjoint —
  // `detectOverlap` already guaranteed that. Batches run in series because one
  // may depend on the previous.
  async runBatch(tickets) {
    const groups = []
    for (let i = 0; i < tickets.length; i += this.numWorkers) {
      groups.push(tickets.slice(i, i + this.numWorkers))
    }

    for (const group of groups) {
      for (const t of group) {
        this.state.append(EVENTS.TICKET_ASSIGNED, {
          ticketId: t.id,
          attempt: this.state.attemptsFor(t.id) + 1
        })
      }

      this.log(`batch: ${group.map((t) => t.id).join(', ')}`)
      const results = await Promise.all(group.map((t) => this.spawnWorker(t)))

      for (const r of results) {
        if (!r.ok) {
          this.state.append(EVENTS.TICKET_FAILED, { ticketId: r.ticketId, code: r.code })
          this.log(`${r.ticketId}: worker failed`)
          continue
        }
        await this.verify(group.find((t) => t.id === r.ticketId))
      }
    }
  }

  // The gate: a ticket does not close because the worker says it finished, it
  // closes because CI went green.
  async verify(ticket) {
    const r = await runCI(this.workspace, ticket)

    if (r.passed) {
      this.state.append(EVENTS.CI_PASS, { ticketId: ticket.id, ms: r.duration })
      this.state.append(EVENTS.TICKET_DONE, { ticketId: ticket.id })
      this.log(`${ticket.id}: CI green`)
    } else {
      this.state.append(EVENTS.CI_FAIL, {
        ticketId: ticket.id,
        status: r.status,
        stderr: (r.stderr || '').slice(0, 500)
      })
      this.log(`${ticket.id}: CI red (${r.status})`)
    }

    return r
  }

  // The `finally` is not tidiness: if a run exits through an exception without
  // closing the corestore, the next run over the same --storage cannot open it.
  // With the cron, that is day 2 dead because of a day-1 error.
  async start() {
    try {
      return await this.run()
    } finally {
      await this.close()
    }
  }

  async run() {
    await this.init()
    this.state.append(EVENTS.RUN_START, { tickets: this.tickets.length })

    const pending = this.pending()
    this.log(`${pending.length} pending out of ${this.tickets.length}`)

    if (pending.length === 0) {
      this.log('nothing left to do')
      this.state.append(EVENTS.RUN_END, { done: 0 })
      return this.summary()
    }

    const dag = buildDAG(pending)
    const { ticketsPerWorker } = assignTickets(dag, this.numWorkers)
    for (let i = 0; i < this.numWorkers; i++) {
      this.log(`worker-${i}: ${ticketsPerWorker[i].map((t) => t.id).join(', ') || '—'}`)
    }

    if (this.dryRun) {
      this.log('dry run: no worker is launched')
      this.state.append(EVENTS.RUN_END, { dryRun: true })
      return this.summary()
    }

    await this.runBatch(dag.ready)

    this.state.append(EVENTS.RUN_END, { done: this.state.done().length })

    if (this.state.isStalled()) {
      this.log('WARNING: two runs in a row closed no ticket — look before spending more')
    }

    return this.summary()
  }

  // The corestore holds a RocksDB lock on its directory. Without closing it,
  // the next run over the same --storage dies with "File descriptor could not
  // be locked". With the cron, that means day 2 never starts.
  async close() {
    if (this.store) {
      await this.store.close()
      this.store = null
    }
  }

  summary() {
    const done = this.state.done()
    const r = {
      drives: { ...this.workerDrives },
      total: this.tickets.length,
      done: done.length,
      pending: this.tickets.length - done.length,
      stalled: this.state.isStalled()
    }
    this.log(`summary: ${r.done}/${r.total} closed`)
    return r
  }
}

function parseArgv(argv) {
  const alias = {
    '--gateway': 'gateway',
    '--api-key': 'apiKey',
    '--model': 'model',
    '--requirement': 'requirement',
    '--workspace': 'workspace',
    '--workers': 'workers',
    '--max-steps': 'maxSteps',
    '--max-tokens': 'maxTokens',
    '--tool-timeout': 'toolTimeout',
    '--storage': 'storage'
  }
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      opts.dryRun = true
      continue
    }
    const key = alias[argv[i]]
    if (key) opts[key] = argv[++i]
  }
  return opts
}

async function main() {
  const orch = new Orchestrator(parseArgv(process.argv.slice(2)))
  await orch.start()
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
