// Parser de requirements.md → tickets con DAG.
// Formato esperado:
//
// # App Title
//
// ## Ticket: src/index.js
// spec del ticket
// Depende de: ninguno
//
// ## Ticket: src/db.js
// spec del ticket
// Depende de: src/index.js
//

export function parseRequirements(mdContent) {
  if (typeof mdContent !== 'string') {
    throw new Error('parseRequirements: expects string, got ' + typeof mdContent)
  }

  const tickets = []
  const sections = mdContent.split(/\n##\s+Ticket:\s+/)

  // Skip el primer elemento (título principal)
  sections.slice(1).forEach((section, idx) => {
    const lines = section.split('\n')
    const titleLine = lines[0] || ''
    const id = titleLine.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')

    // Busca "Depende de:" o "Files:"
    let spec = ''
    let deps = []
    let allowedFiles = []
    let inSpec = true

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]

      if (line.toLowerCase().startsWith('depende de:') || line.toLowerCase().startsWith('depends on:')) {
        inSpec = false
        const depList = line.split(':')[1] || ''
        deps = depList
          .split(',')
          .map((d) => d.trim())
          .filter((d) => d && d !== 'ninguno')
      } else if (
        line.toLowerCase().startsWith('files:') ||
        line.toLowerCase().startsWith('allowed files:')
      ) {
        const fileList = line.split(':')[1] || ''
        allowedFiles = fileList
          .split(',')
          .map((f) => f.trim())
          .filter((f) => f)
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
    throw new Error('buildDAG: expects array of tickets')
  }

  // Valida que todas las dependencies existan
  const ids = new Set(tickets.map((t) => t.id))
  for (const ticket of tickets) {
    for (const dep of ticket.deps) {
      if (!ids.has(dep)) {
        throw new Error(`ticket ${ticket.id} depends on unknown ticket ${dep}`)
      }
    }
  }

  // Topological sort
  const visited = new Set()
  const ready = []
  const waiting = {}

  function visit(ticketId) {
    if (visited.has(ticketId)) return

    const ticket = tickets.find((t) => t.id === ticketId)
    if (!ticket) return

    for (const dep of ticket.deps) {
      visit(dep)
    }

    visited.add(ticketId)
    ready.push(ticket)
  }

  // Visita en orden del array (determinístico)
  for (const ticket of tickets) {
    visit(ticket.id)
  }

  // Separa en ready (no tiene deps sin resolver) vs waiting
  const readySet = new Set(ready.map((t) => t.id))
  for (const ticket of tickets) {
    const hasUnresolvedDeps = ticket.deps.some((dep) => !readySet.has(dep))
    if (hasUnresolvedDeps) {
      waiting[ticket.id] = ticket
    }
  }

  return { ready, waiting }
}

export function assignTickets(dag, numWorkers) {
  if (numWorkers < 1) throw new Error('numWorkers must be >= 1')

  const assignments = {}
  const ticketsPerWorker = []

  for (let i = 0; i < numWorkers; i++) {
    ticketsPerWorker[i] = []
  }

  // Asigna round-robin
  dag.ready.forEach((ticket, idx) => {
    const workerIdx = idx % numWorkers
    ticketsPerWorker[workerIdx].push(ticket)
    assignments[ticket.id] = workerIdx
  })

  return {
    assignments, // { ticketId: workerIdx }
    ticketsPerWorker // Array de arrays
  }
}
