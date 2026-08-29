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
