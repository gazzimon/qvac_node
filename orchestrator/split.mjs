// Parser for requirements.md → tickets with a DAG.
//
// Expected shape:
//
//   # App Title
//
//   ## Ticket: db
//   what this ticket has to build
//   Depends on: none
//   Files: src/db.js, tests/db.test.js
//
// `Depende de:` and `Archivos:` are accepted as well — the first requirements
// files were written in Spanish and breaking them buys nothing.

export function parseRequirements(mdContent) {
  if (typeof mdContent !== 'string') {
    throw new Error('parseRequirements: expects a string, got ' + typeof mdContent)
  }

  const tickets = []
  const sections = mdContent.split(/\n##\s+Ticket:\s+/)

  // Skip the first chunk: it is whatever came before the first ticket heading.
  sections.slice(1).forEach((section) => {
    const lines = section.split('\n')
    const titleLine = lines[0] || ''
    const id = titleLine.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')

    let spec = ''
    let deps = []
    let allowedFiles = []
    let inSpec = true

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const lower = line.toLowerCase()

      if (lower.startsWith('depends on:') || lower.startsWith('depende de:')) {
        inSpec = false
        const list = line.slice(line.indexOf(':') + 1)
        deps = list
          .split(',')
          .map((d) => d.trim())
          .filter((d) => d && d !== 'none' && d !== 'ninguno')
      } else if (
        lower.startsWith('files:') ||
        lower.startsWith('allowed files:') ||
        lower.startsWith('archivos:')
      ) {
        const list = line.slice(line.indexOf(':') + 1)
        allowedFiles = list
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
      } else if (inSpec && line.trim()) {
        spec += line + '\n'
      }
    }

    if (titleLine.trim()) {
      tickets.push({
        id,
        title: titleLine.trim(),
        spec: spec.trim(),
        deps,
        allowedFiles,
        status: 'pending'
      })
    }
  })

  return tickets
}

export function buildDAG(tickets) {
  if (!Array.isArray(tickets)) {
    throw new Error('buildDAG: expects an array of tickets')
  }

  // A dependency on a ticket that does not exist is a typo in requirements.md.
  // It fails here rather than being silently ignored, because ignoring it means
  // running a ticket before the thing it needs.
  const ids = new Set(tickets.map((t) => t.id))
  for (const ticket of tickets) {
    for (const dep of ticket.deps) {
      if (!ids.has(dep)) {
        throw new Error(`ticket ${ticket.id} depends on unknown ticket ${dep}`)
      }
    }
  }

  const visited = new Set()
  const ready = []
  const waiting = {}

  function visit(ticketId) {
    if (visited.has(ticketId)) return

    const ticket = tickets.find((t) => t.id === ticketId)
    if (!ticket) return

    for (const dep of ticket.deps) visit(dep)

    visited.add(ticketId)
    ready.push(ticket)
  }

  // Visited in array order, so the result is deterministic.
  for (const ticket of tickets) visit(ticket.id)

  const readySet = new Set(ready.map((t) => t.id))
  for (const ticket of tickets) {
    const hasUnresolvedDeps = ticket.deps.some((dep) => !readySet.has(dep))
    if (hasUnresolvedDeps) waiting[ticket.id] = ticket
  }

  return { ready, waiting }
}

// A dependency-safe schedule: an array of WAVES, each wave an array of
// tickets whose dependencies are all satisfied by an EARLIER wave. Every
// ticket in one wave can run in parallel with every other ticket in that same
// wave; the caller must not start wave N+1 until wave N's tickets are done.
//
// WHY THIS IS NOT JUST buildDAG(tickets).ready CHUNKED BY WINDOW SIZE
//
// `buildDAG().ready` is a flat topological ORDER, not a level structure: it
// guarantees a dependency appears somewhere earlier in the array than its
// dependent, nothing more. Slicing that flat array into fixed-size windows (as
// `assignTickets` does, for the single-machine case) can put a ticket in the
// SAME window as its own dependency if they happen to land on the same side of
// a window boundary — the window is picked by position count, not by whether
// everything in it is actually independent. On one machine the two tickets
// still run as separate child processes and the race is at least contained to
// one disk; across machines it means a worker reading the coordinator's
// context drive before the file it depends on was ever written to it. Real
// levels close that: nothing in wave N can depend on anything in wave N, by
// construction.
//
// `doneIds` lets the caller pass a SUBSET of tickets (the still-pending ones —
// a cron's second run, say) without every already-closed dependency being
// mistaken for a typo: a dep missing from `tickets` is either in `doneIds`
// (fine, it already happened) or was never a valid id (buildDAG already
// throws on that, against the FULL ticket list, before this is ever called).
export function dependencyWaves(tickets, { doneIds = new Set() } = {}) {
  if (!Array.isArray(tickets)) {
    throw new Error('dependencyWaves: expects an array of tickets')
  }

  const byId = new Map(tickets.map((t) => [t.id, t]))
  const level = new Map()
  const visiting = new Set()

  function levelOf(id) {
    if (doneIds.has(id)) return -1 // closed in an earlier run — contributes nothing to a wave
    if (level.has(id)) return level.get(id)
    const ticket = byId.get(id)
    if (!ticket) return -1 // not in this batch and not marked done: already closed, same as above
    if (visiting.has(id)) {
      throw new Error(`circular dependency involving ticket ${id}`)
    }

    visiting.add(id)
    const lv = ticket.deps.length === 0 ? 0 : 1 + Math.max(...ticket.deps.map(levelOf))
    visiting.delete(id)

    level.set(id, lv)
    return lv
  }

  for (const ticket of tickets) levelOf(ticket.id)

  const maxLevel = tickets.length === 0 ? -1 : Math.max(...tickets.map((t) => level.get(t.id)))
  const waves = []
  for (let l = 0; l <= maxLevel; l++) {
    waves.push(tickets.filter((t) => level.get(t.id) === l))
  }
  return waves
}

export function assignTickets(dag, numWorkers) {
  if (numWorkers < 1) throw new Error('numWorkers must be >= 1')

  const assignments = {}
  const ticketsPerWorker = []

  for (let i = 0; i < numWorkers; i++) ticketsPerWorker[i] = []

  // Round-robin. Fairness is not the point: the tickets in one batch have
  // disjoint file sets, so who runs which one changes nothing.
  dag.ready.forEach((ticket, idx) => {
    const workerIdx = idx % numWorkers
    ticketsPerWorker[workerIdx].push(ticket)
    assignments[ticket.id] = workerIdx
  })

  return { assignments, ticketsPerWorker }
}
