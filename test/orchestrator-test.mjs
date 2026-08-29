// Test simple del orquestador: split + DAG

import { parseRequirements, buildDAG, assignTickets } from '../orchestrator/split.mjs'

const mdSimple = `# App

## Ticket: index
Implementar entry point
Depende de: ninguno
Files: src/index.js,tests/index.test.js

## Ticket: db
Implementar database layer
Depende de: index
Files: src/db.js,tests/db.test.js

## Ticket: api
Implementar API router
Depende de: index
Files: src/api.js,tests/api.test.js
`

console.log('[test] parsing requirements...')
const tickets = parseRequirements(mdSimple)
console.log(`✓ parsed ${tickets.length} tickets`)

tickets.forEach((t) => {
  console.log(`  - ${t.id}: ${t.allowedFiles.join(', ')} (deps: ${t.deps.join(',') || 'none'})`)
})

console.log('\n[test] building DAG...')
const dag = buildDAG(tickets)
console.log(`✓ ready: ${dag.ready.length}, waiting: ${Object.keys(dag.waiting).length}`)

console.log('\n[test] assigning to 2 workers...')
const { ticketsPerWorker } = assignTickets(dag, 2)
for (let i = 0; i < 2; i++) {
  const tids = ticketsPerWorker[i].map((t) => t.id).join(', ')
  console.log(`  worker-${i}: ${tids}`)
}

console.log('\n✅ all tests passed')
