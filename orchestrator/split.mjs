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

// Can `fromId` reach `toId` by following `Depends on:` edges? Used to decide
// whether two tickets that declare the same file are STRICTLY ORDERED (safe)
// or could run at the same time (a silent last-writer-wins race).
export function dependsOn(tickets, fromId, toId) {
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const seen = new Set()
  const stack = [fromId]
  while (stack.length) {
    const id = stack.pop()
    if (id === toId && id !== fromId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const t = byId.get(id)
    if (!t) continue
    for (const dep of t.deps) {
      if (dep === toId) return true
      stack.push(dep)
    }
  }
  return false
}

// Two tickets declaring the same file, WITHOUT a dependency between them.
//
// WHY THIS IS LOOSER THAN index.mjs's detectOverlap, AND WHY THAT IS SAFE
//
// The single-machine orchestrator forbids ANY two tickets from declaring the
// same file, because it runs `dag.ready` in fixed-size batches: two tickets
// that share a file can land in the same batch and race, and it has no wave
// structure to prevent it. That check has to stay strict there.
//
// The coordinator DOES have waves (`dependencyWaves`), and a wave is exactly
// the set of tickets that can run at once. So the invariant that actually
// matters is narrower: two tickets may share a file as long as one depends on
// the other, because then they can never be in the same wave — the dependent
// runs strictly after the dependency's file has been mirrored and the context
// drive republished.
//
// That is what lets a project GROW: ticket `api` (wave 2) can declare
// `src/db.js` that ticket `db` (wave 1) created, receive its current content,
// and return the whole updated file. No diffs — the repo already measured
// that whole files beat diffs (see parseBlocks in worker/run.mjs), and this
// keeps that property while removing the reason it was limiting.
export function detectConcurrentOverlap(tickets) {
  const owners = new Map() // file -> [ticketId, ...]
  for (const t of tickets) {
    for (const f of t.allowedFiles) {
      if (!owners.has(f)) owners.set(f, [])
      owners.get(f).push(t.id)
    }
  }

  const clashes = []
  for (const [file, ids] of owners) {
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const ordered =
          dependsOn(tickets, ids[i], ids[j]) || dependsOn(tickets, ids[j], ids[i])
        if (!ordered) clashes.push({ file, tickets: [ids[i], ids[j]] })
      }
    }
  }
  return clashes
}

// Which of a ticket's declared files were ALREADY declared by something it
// depends on — i.e. files it is editing rather than creating. Two consequences
// for the caller, both load-bearing:
//
//   - the worker must be shown the file's current content, or it will "modify"
//     a file it has never seen and produce a replacement from nothing;
//   - the mirror must NOT clear these before applying an attempt. Clearing a
//     path the ticket itself created is right (it stops a stale file from a
//     superseded attempt lingering); clearing one a DEPENDENCY created would
//     destroy that dependency's work the moment this ticket's model fails to
//     reproduce it.
export function inheritedFiles(tickets, ticket) {
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const fromDeps = new Set()
  const seen = new Set()
  const stack = [...ticket.deps]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const t = byId.get(id)
    if (!t) continue
    for (const f of t.allowedFiles) fromDeps.add(f)
    for (const d of t.deps) stack.push(d)
  }
  return ticket.allowedFiles.filter((f) => fromDeps.has(f))
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
