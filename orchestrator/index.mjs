// El orquestador: dueño de requirements.md, de la cola de tickets y del gate
// de CI. Los workers no ven el documento entero — cada uno recibe un ticket con
// la lista exacta de archivos que puede tocar.
//
// El workspace es un Hyperdrive compartido: los cambios de cada worker se ven
// en las otras máquinas mientras suceden, así que no hay branches que mergear
// al final. Lo que evita que se pisen no es el merge, es que dos tickets nunca
// declaran el mismo archivo.

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { parseRequirements, buildDAG, assignTickets } from './split.mjs'
import { runCI } from './ci.mjs'
import { Estado, EVENTOS } from './state.mjs'

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

// Dos tickets que declaran el mismo archivo es un conflicto de merge esperando
// a pasar. Se corta acá, antes de asignar nada: es más barato arreglar el
// requirements.md que resolver el conflicto después.
export function detectarSolapamiento(tickets) {
  const dueno = new Map()
  const choques = []

  for (const t of tickets) {
    for (const f of t.allowedFiles) {
      if (dueno.has(f)) {
        choques.push({ file: f, tickets: [dueno.get(f), t.id] })
      } else {
        dueno.set(f, t.id)
      }
    }
  }

  return choques
}

export class Orchestrator {
  constructor(opts = {}) {
    this.gateway = opts.gateway || 'http://localhost:8787'
    this.apiKey = opts.apiKey || null
    this.workspace = path.resolve(opts.workspace || './build')
    this.numWorkers = parseInt(opts.workers) || 2
    this.maxSteps = parseInt(opts.maxSteps) || 10
    this.maxTokens = parseInt(opts.maxTokens) || 8000
    this.storageDir = path.resolve(opts.storage || path.join('.qvac', 'orchestrator'))
    this.requirementFile = opts.requirement || './requirements.md'
    this.dryRun = opts.dryRun === true

    this.drive = null
    this.tickets = []
    this.estado = null
  }

  log(msg) {
    console.log(`[orq] ${msg}`)
  }

  async init() {
    for (const dir of [this.storageDir, this.workspace]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }

    this.estado = new Estado(path.join(this.storageDir, 'corridas.jsonl'))

    const store = new Corestore(this.storageDir)
    await store.ready()
    this.drive = new Hyperdrive(store)
    await this.drive.ready()

    this.log(`Hyperdrive key: ${this.drive.key.toString('hex')}`)
    this.log(`workspace: ${this.workspace}`)

    if (!fs.existsSync(this.requirementFile)) {
      throw new Error(`no existe el requirements: ${this.requirementFile}`)
    }

    this.tickets = parseRequirements(fs.readFileSync(this.requirementFile, 'utf8'))
    if (this.tickets.length === 0) throw new Error('el requirements no declara ningún ticket')

    const choques = detectarSolapamiento(this.tickets)
    if (choques.length > 0) {
      const detalle = choques.map((c) => `${c.file} (${c.tickets.join(' y ')})`).join('; ')
      throw new Error(`dos tickets declaran el mismo archivo: ${detalle}`)
    }

    this.log(`${this.tickets.length} tickets, sin archivos solapados`)
  }

  // Lo que ya cerró en una corrida anterior no se vuelve a hacer. Es lo que
  // hace que el cron del día 4 no rehaga lo del día 3.
  pendientes() {
    const hechos = new Set(this.estado.hechos())
    return this.tickets.filter((t) => !hechos.has(t.id))
  }

  lanzarWorker(ticket) {
    const args = [
      path.join(RAIZ, 'worker', 'run.mjs'),
      '--gateway', this.gateway,
      '--drive-key', this.drive.key.toString('hex'),
      '--ticket', ticket.id,
      '--spec', ticket.spec,
      '--allowed-files', ticket.allowedFiles.join(','),
      '--workspace', this.workspace,
      '--max-steps', String(this.maxSteps),
      '--max-tokens', String(this.maxTokens),
      '--storage', path.join(this.storageDir, 'workers', ticket.id)
    ]
    if (this.apiKey) args.push('--api-key', this.apiKey)

    return new Promise((resolve) => {
      const proc = spawn(process.execPath, args, { stdio: 'inherit' })
      proc.on('exit', (code) => resolve({ ticketId: ticket.id, ok: code === 0, code }))
      proc.on('error', (err) => resolve({ ticketId: ticket.id, ok: false, error: err.message }))
    })
  }

  // Los tickets de una tanda corren en paralelo porque sus archivos son
  // disjuntos — eso ya lo garantizó `detectarSolapamiento`. Las tandas van en
  // serie porque una depende de la anterior.
  async correrTanda(tickets) {
    const grupos = []
    for (let i = 0; i < tickets.length; i += this.numWorkers) {
      grupos.push(tickets.slice(i, i + this.numWorkers))
    }

    for (const grupo of grupos) {
      for (const t of grupo) {
        this.estado.agregar(EVENTOS.TICKET_ASIGNADO, {
          ticketId: t.id,
          intento: this.estado.intentosDe(t.id) + 1
        })
      }

      this.log(`tanda: ${grupo.map((t) => t.id).join(', ')}`)
      const resultados = await Promise.all(grupo.map((t) => this.lanzarWorker(t)))

      for (const r of resultados) {
        if (!r.ok) {
          this.estado.agregar(EVENTOS.TICKET_FALLIDO, { ticketId: r.ticketId, code: r.code })
          this.log(`${r.ticketId}: el worker falló`)
          continue
        }
        await this.verificar(grupo.find((t) => t.id === r.ticketId))
      }
    }
  }

  // El gate: el ticket no cierra porque el worker diga que terminó, cierra
  // porque CI pasó. Es la única señal que no la produce el modelo.
  async verificar(ticket) {
    const r = await runCI(this.workspace, ticket)

    if (r.passed) {
      this.estado.agregar(EVENTOS.CI_VERDE, { ticketId: ticket.id, ms: r.duration })
      this.estado.agregar(EVENTOS.TICKET_HECHO, { ticketId: ticket.id })
      this.log(`${ticket.id}: CI verde`)
    } else {
      this.estado.agregar(EVENTOS.CI_ROJO, {
        ticketId: ticket.id,
        status: r.status,
        stderr: (r.stderr || '').slice(0, 500)
      })
      this.log(`${ticket.id}: CI rojo (${r.status})`)
    }

    return r
  }

  async start() {
    await this.init()
    this.estado.agregar(EVENTOS.CORRIDA_INICIO, { tickets: this.tickets.length })

    const pendientes = this.pendientes()
    this.log(`${pendientes.length} pendientes de ${this.tickets.length}`)

    if (pendientes.length === 0) {
      this.log('no queda nada por hacer')
      this.estado.agregar(EVENTOS.CORRIDA_FIN, { hechos: 0 })
      return this.resumen()
    }

    const dag = buildDAG(pendientes)
    const { ticketsPerWorker } = assignTickets(dag, this.numWorkers)
    for (let i = 0; i < this.numWorkers; i++) {
      this.log(`worker-${i}: ${ticketsPerWorker[i].map((t) => t.id).join(', ') || '—'}`)
    }

    if (this.dryRun) {
      this.log('dry-run: no se lanza ningún worker')
      this.estado.agregar(EVENTOS.CORRIDA_FIN, { dryRun: true })
      return this.resumen()
    }

    await this.correrTanda(dag.ready)

    this.estado.agregar(EVENTOS.CORRIDA_FIN, { hechos: this.estado.hechos().length })

    if (this.estado.estancado()) {
      this.log('AVISO: dos corridas seguidas sin cerrar un solo ticket — mirar antes de seguir')
    }

    return this.resumen()
  }

  resumen() {
    const hechos = this.estado.hechos()
    const r = {
      driveKey: this.drive.key.toString('hex'),
      total: this.tickets.length,
      hechos: hechos.length,
      pendientes: this.tickets.length - hechos.length,
      estancado: this.estado.estancado()
    }
    this.log(`resumen: ${r.hechos}/${r.total} cerrados`)
    return r
  }
}

function parsearArgv(argv) {
  const alias = {
    '--gateway': 'gateway',
    '--api-key': 'apiKey',
    '--requirement': 'requirement',
    '--workspace': 'workspace',
    '--workers': 'workers',
    '--max-steps': 'maxSteps',
    '--max-tokens': 'maxTokens',
    '--storage': 'storage'
  }
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      opts.dryRun = true
      continue
    }
    const clave = alias[argv[i]]
    if (clave) opts[clave] = argv[++i]
  }
  return opts
}

async function main() {
  const orq = new Orchestrator(parsearArgv(process.argv.slice(2)))
  await orq.start()
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
