// Orquestador: crea Hyperdrive compartido, asigna tickets, monitorea cambios.

import fs from 'fs'
import path from 'path'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { parseRequirements, buildDAG, assignTickets } from './split.mjs'
import { runCI } from './ci.mjs'

export class Orchestrator {
  constructor(opts = {}) {
    this.gateway = opts.gateway || 'http://localhost:8787'
    this.workspace = opts.workspace || './build'
    this.numWorkers = parseInt(opts.workers) || 2
    this.maxIter = parseInt(opts.maxIter) || 6
    this.storageDir = opts.storage || path.join(process.cwd(), '.qvac', 'orchestrator')
    this.requirementFile = opts.requirement

    this.drive = null
    this.tickets = []
    this.taskLog = []
  }

  async init() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true })
    }

    const store = new Corestore(this.storageDir)
    await store.ready()

    this.drive = new Hyperdrive(store)
    await this.drive.ready()

    console.log(`[init] Hyperdrive key: ${this.drive.key.toString('hex')}`)
    console.log(`[init] Storage: ${this.storageDir}`)

    if (!fs.existsSync(this.requirementFile)) {
      throw new Error(`requirement file not found: ${this.requirementFile}`)
    }

    const mdContent = fs.readFileSync(this.requirementFile, 'utf8')
    this.tickets = parseRequirements(mdContent)

    if (this.tickets.length === 0) {
      console.warn('[init] no tickets found')
      return
    }

    console.log(`[init] parsed ${this.tickets.length} tickets`)

    const dag = buildDAG(this.tickets)
    console.log(`[init] ready: ${dag.ready.length}, waiting: ${Object.keys(dag.waiting).length}`)

    const { assignments, ticketsPerWorker } = assignTickets(dag, this.numWorkers)
    this.assignments = assignments
    this.ticketsPerWorker = ticketsPerWorker

    for (let i = 0; i < this.numWorkers; i++) {
      const tids = this.ticketsPerWorker[i].map((t) => t.id).join(', ')
      console.log(`[init] worker-${i}: ${tids}`)
    }

    this.taskLog.push({
      ts: new Date().toISOString(),
      event: 'init',
      ticketCount: this.tickets.length,
      driveKey: this.drive.key.toString('hex')
    })
  }

  async start() {
    console.log(`[start] orchestrator with ${this.numWorkers} workers`)
    try {
      await this.init()
      console.log('[start] ready to accept workers')
      this.logStatus()
    } catch (err) {
      console.error('[error]', err.message)
      throw err
    }
  }

  logStatus() {
    const logFile = path.join(this.storageDir, 'orchestrator.jsonl')
    const logContent = this.taskLog.map((e) => JSON.stringify(e)).join('\n')
    fs.writeFileSync(logFile, logContent + '\n')
    console.log(`[log] saved to ${logFile}`)
  }

  getDriveKey() {
    return this.drive ? this.drive.key.toString('hex') : null
  }

  getTickets() {
    return this.tickets
  }

  getAssignments() {
    return this.assignments || {}
  }
}

async function main() {
  const opts = {}
  const argv = process.argv.slice(2)

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gateway') opts.gateway = argv[++i]
    if (argv[i] === '--requirement') opts.requirement = argv[++i]
    if (argv[i] === '--workspace') opts.workspace = argv[++i]
    if (argv[i] === '--workers') opts.workers = argv[++i]
    if (argv[i] === '--max-iter') opts.maxIter = argv[++i]
    if (argv[i] === '--storage') opts.storage = argv[++i]
  }

  const orch = new Orchestrator(opts)
  await orch.start()
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
