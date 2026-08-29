// Test básico: orchestrator puede parsear requirements y crear DAG

import { test } from 'brittle'
import { parseRequirements, buildDAG } from '../orchestrator/split.mjs'

const mdSimple = `# App

## Ticket: index
Implementar index
Depende de: ninguno
Files: src/index.js

## Ticket: db
Implementar db
Depende de: index
Files: src/db.js
`

test('parse simple requirements', (t) => {
  const tickets = parseRequirements(mdSimple)
  t.is(tickets.length, 2)
  t.is(tickets[0].id, 'index')
  t.is(tickets[1].id, 'db')
})

test('build DAG', (t) => {
  const tickets = parseRequirements(mdSimple)
  const dag = buildDAG(tickets)

  t.is(dag.ready.length, 1)
  t.is(dag.ready[0].id, 'index')
  t.ok('db' in dag.waiting)
})

test('tickets have specs', (t) => {
  const tickets = parseRequirements(mdSimple)
  t.ok(tickets[0].spec.includes('Implementar'))
  t.is(tickets[0].allowedFiles.length, 1)
  t.is(tickets[0].allowedFiles[0], 'src/index.js')
})
