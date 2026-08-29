// Tests del orquestador. Corre bajo Node (no Bare): el orquestador y el worker
// son clientes HTTP del gateway, no parte del binario distribuido.
//
//   node test/orchestrator-test.mjs

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseRequirements, buildDAG, assignTickets } from '../orchestrator/split.mjs'
import { Harness, LimitReached, isTransient } from '../orchestrator/harness.mjs'
import {
  validarEscritura,
  validarHerramienta,
  rutaPermitida,
  ViolacionDeAlcance
} from '../orchestrator/security.mjs'
import { Estado, EVENTOS } from '../orchestrator/state.mjs'
import { detectarSolapamiento } from '../orchestrator/index.mjs'
import { parsearBloques, promptDeSistema } from '../worker/run.mjs'

let pasados = 0
let fallados = 0

function test(nombre, fn) {
  try {
    fn()
    pasados++
    console.log(`  ok  ${nombre}`)
  } catch (err) {
    fallados++
    console.log(`  NO  ${nombre}\n      ${err.message}`)
  }
}

async function testAsync(nombre, fn) {
  try {
    await fn()
    pasados++
    console.log(`  ok  ${nombre}`)
  } catch (err) {
    fallados++
    console.log(`  NO  ${nombre}\n      ${err.message}`)
  }
}

const MD = `# App

## Ticket: index
Implementar entry point
Depende de: ninguno
Files: src/index.js,tests/index.test.js

## Ticket: db
Implementar database layer
Depende de: index
Files: src/db.js,tests/db.test.js
`

console.log('\nsplit')

test('parsea tickets con specs, deps y archivos', () => {
  const t = parseRequirements(MD)
  assert.equal(t.length, 2)
  assert.equal(t[0].id, 'index')
  assert.deepEqual(t[0].allowedFiles, ['src/index.js', 'tests/index.test.js'])
  assert.deepEqual(t[1].deps, ['index'])
  assert.ok(t[0].spec.includes('entry point'))
})

test('el DAG respeta el orden de dependencias', () => {
  const dag = buildDAG(parseRequirements(MD))
  const orden = dag.ready.map((t) => t.id)
  assert.ok(orden.indexOf('index') < orden.indexOf('db'))
})

test('una dependencia inexistente corta en vez de ignorarse', () => {
  const t = [{ id: 'a', deps: ['fantasma'], allowedFiles: ['a.js'] }]
  assert.throws(() => buildDAG(t), /unknown ticket/)
})

test('reparte los tickets entre los workers', () => {
  const dag = buildDAG(parseRequirements(MD))
  const { ticketsPerWorker } = assignTickets(dag, 2)
  assert.equal(ticketsPerWorker[0].length + ticketsPerWorker[1].length, 2)
})

console.log('\nsolapamiento')

test('dos tickets con el mismo archivo se detectan', () => {
  const choques = detectarSolapamiento([
    { id: 'a', allowedFiles: ['src/x.js'] },
    { id: 'b', allowedFiles: ['src/x.js'] }
  ])
  assert.equal(choques.length, 1)
  assert.equal(choques[0].file, 'src/x.js')
})

test('archivos disjuntos no chocan', () => {
  const choques = detectarSolapamiento([
    { id: 'a', allowedFiles: ['src/a.js'] },
    { id: 'b', allowedFiles: ['src/b.js'] }
  ])
  assert.equal(choques.length, 0)
})

console.log('\nsecurity')

const WS = path.join(os.tmpdir(), 'orq-test-ws')

test('escribir un archivo del ticket se permite', () => {
  const abs = validarEscritura(WS, 'src/db.js', ['src/db.js'])
  assert.ok(abs.endsWith(path.join('orq-test-ws', 'src', 'db.js')))
})

test('escribir fuera del ticket se rechaza', () => {
  assert.throws(
    () => validarEscritura(WS, 'src/otro.js', ['src/db.js']),
    (e) => e instanceof ViolacionDeAlcance && e.motivo === 'ruta fuera del ticket'
  )
})

test('salir del workspace con .. se rechaza', () => {
  assert.throws(
    () => validarEscritura(WS, '../../etc/passwd', ['../../etc/passwd']),
    (e) => e instanceof ViolacionDeAlcance && e.motivo === 'fuga del workspace'
  )
})

test('un prefijo de directorio habilita lo de adentro', () => {
  assert.ok(rutaPermitida('src/lib/x.js', ['src/']))
  assert.ok(!rutaPermitida('srcx/lib.js', ['src/']))
})

test('un nombre parecido NO cuenta como el archivo permitido', () => {
  assert.ok(!rutaPermitida('src/db.js.bak', ['src/db.js']))
})

test('una herramienta prohibida se rechaza aunque esté en la allowlist', () => {
  assert.throws(
    () => validarHerramienta('sudo', ['sudo', 'read_file']),
    (e) => e.motivo === 'herramienta prohibida'
  )
})

test('una herramienta fuera de la allowlist se rechaza', () => {
  assert.throws(() => validarHerramienta('git_push', ['read_file']), /allowlist/)
})

console.log('\nharness')

test('cortar por pasos antes de gastar', () => {
  const h = new Harness({ maxSteps: 2 })
  h.spend({ tokens: 1 })
  h.spend({ tokens: 1 })
  assert.throws(() => h.checkBudget(), (e) => e instanceof LimitReached && e.kind === 'steps')
})

test('cortar por tokens antes de gastar', () => {
  const h = new Harness({ maxSteps: 100, maxTokens: 50 })
  h.spend({ tokens: 60 })
  assert.throws(() => h.checkBudget(), (e) => e.kind === 'tokens')
})

test('el timeout por herramienta tiene que ser menor que el de la tarea', () => {
  assert.throws(() => new Harness({ toolTimeoutMs: 999, taskTimeoutMs: 999 }), /menor/)
})

test('un 500 es transitorio; un 400 no', () => {
  const e500 = Object.assign(new Error('x'), { status: 500 })
  const e400 = Object.assign(new Error('x'), { status: 400 })
  assert.ok(isTransient(e500))
  assert.ok(!isTransient(e400))
})

await testAsync('una herramienta colgada falla por timeout, no cuelga la tarea', async () => {
  const h = new Harness({ toolTimeoutMs: 50, taskTimeoutMs: 5000 })
  await assert.rejects(
    () => h.runTool('lenta', () => new Promise(() => {})),
    /timed out/
  )
})

await testAsync('no se reintenta un error determinista', async () => {
  const h = new Harness({ maxRetries: 3 })
  let intentos = 0
  await assert.rejects(() =>
    h.withRetry('x', () => {
      intentos++
      throw Object.assign(new Error('bad request'), { status: 400 })
    })
  )
  assert.equal(intentos, 1, 'un 400 no se reintenta')
})

await testAsync('sí se reintenta un transitorio, y termina bien', async () => {
  const h = new Harness({ maxRetries: 3 })
  let intentos = 0
  const r = await h.withRetry('x', () => {
    intentos++
    if (intentos < 2) throw Object.assign(new Error('boom'), { status: 503 })
    return 'ok'
  })
  assert.equal(r, 'ok')
  assert.equal(intentos, 2)
})

console.log('\nworker: prompt de sistema')

// Medido contra llama1b: el prompt mostraba `path=src/ejemplo.js` como muestra
// del formato y pedía escribir en `src/suma.js`. El modelo copió la ruta del
// ejemplo y el jail rechazó todo — 0 escritos, 1 rechazado. Con dos rutas en el
// prompt, un modelo chico elige la que está en la posición del ejemplo.
test('el prompt no menciona ninguna ruta que no sea la del ticket', () => {
  const p = promptDeSistema({ id: 'x', spec: 'y', allowedFiles: ['src/suma.js'] })
  const rutas = [...p.matchAll(/path=([^\n`]+)/g)].map((m) => m[1].trim())
  assert.ok(rutas.length > 0, 'el prompt tiene que mostrar el formato')
  assert.deepEqual([...new Set(rutas)], ['src/suma.js'])
})

test('con varios archivos, los lista a todos', () => {
  const files = ['src/a.js', 'tests/a.test.js']
  const p = promptDeSistema({ id: 'x', spec: 'y', allowedFiles: files })
  for (const f of files) assert.ok(p.includes(f), `falta ${f} en el prompt`)
  const rutas = [...p.matchAll(/path=([^\n`]+)/g)].map((m) => m[1].trim())
  assert.ok(files.includes(rutas[0]), 'el ejemplo usa una ruta del ticket')
})

// Medido: sin código de verdad en el ejemplo, llama1b devolvió 0 bloques. Un
// comentario de relleno no es un molde, y a un modelo chico lo guía el molde.
test('el ejemplo trae código, no un comentario de relleno', () => {
  const p = promptDeSistema({ id: 'x', spec: 'y', allowedFiles: ['src/suma.js'] })
  const bloques = parsearBloques(p)
  assert.equal(bloques.length, 1, 'el prompt tiene que mostrar un bloque de ejemplo')
  assert.match(bloques[0].content, /export function/, 'el ejemplo tiene que traer código')
  assert.ok(
    !/^\s*\/\/[^\n]*\n?\s*$/.test(bloques[0].content),
    'un ejemplo que es solo un comentario no sirve de molde'
  )
})

console.log('\nworker: parseo de bloques')

test('parsea varios bloques de archivo', () => {
  const b = parsearBloques(
    'bla\n```file path=src/a.js\nconst a = 1\n```\ny\n```file path=src/b.js\nconst b = 2\n```'
  )
  assert.equal(b.length, 2)
  assert.equal(b[0].path, 'src/a.js')
  assert.equal(b[0].content, 'const a = 1\n')
  assert.equal(b[1].path, 'src/b.js')
})

test('una respuesta sin bloques da lista vacía, no error', () => {
  assert.equal(parsearBloques('acá tenés el código, che').length, 0)
})

console.log('\nhyperdrive: un solo escritor')

// Esto no prueba código nuestro, prueba un supuesto del que depende toda la
// arquitectura. Se rompió una vez: el orquestador le pasaba SU clave al worker
// y `put()` se colgaba para siempre, sin error. El test queda para que el día
// que alguien escriba `new Hyperdrive(store, claveAjena)` esperando escribir,
// se entere acá y no colgado.
await testAsync('un drive abierto por clave ajena NO es escribible', async () => {
  const Corestore = (await import('corestore')).default
  const Hyperdrive = (await import('hyperdrive')).default
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-writable-'))

  const storeA = new Corestore(path.join(tmp, 'a'))
  await storeA.ready()
  const driveA = new Hyperdrive(storeA)
  await driveA.ready()

  const storeB = new Corestore(path.join(tmp, 'b'))
  await storeB.ready()
  const driveB = new Hyperdrive(storeB, driveA.key)
  await driveB.ready()

  assert.equal(driveA.core.writable, true, 'el creador SI escribe')
  assert.equal(driveB.core.writable, false, 'el que abre por clave NO escribe')

  // Y lo que hace que el bug sea traicionero: no falla, se cuelga.
  const r = await Promise.race([
    driveB.put('/x', Buffer.from('a')).then(() => 'escribio'),
    new Promise((res) => setTimeout(() => res('colgado'), 1500))
  ]).catch(() => 'error')
  assert.equal(r, 'colgado', 'put() sobre un drive de solo lectura se cuelga, no tira')

  await driveA.close()
  await driveB.close()
  await storeA.close()
  await storeB.close()
})

console.log('\nstate')

const LOG = path.join(os.tmpdir(), `orq-test-${Date.now()}.jsonl`)

test('un ticket cerrado queda cerrado tras releer el log', () => {
  const e = new Estado(LOG)
  e.agregar(EVENTOS.CORRIDA_INICIO, {})
  e.agregar(EVENTOS.TICKET_ASIGNADO, { ticketId: 'a' })
  e.agregar(EVENTOS.TICKET_HECHO, { ticketId: 'a' })
  e.agregar(EVENTOS.TICKET_ASIGNADO, { ticketId: 'b' })

  const releido = new Estado(LOG)
  assert.deepEqual(releido.hechos(), ['a'])
  assert.deepEqual(releido.pendientes(), ['b'])
})

test('una línea trunca se descarta y el resto sobrevive', () => {
  fs.appendFileSync(LOG, '{"ts":"x","tipo":"cor')
  const e = new Estado(LOG)
  assert.deepEqual(e.hechos(), ['a'])
})

test('dos corridas sin cerrar nada se marca como estancado', () => {
  const ruta = path.join(os.tmpdir(), `orq-estanc-${Date.now()}.jsonl`)
  const e = new Estado(ruta)
  e.agregar(EVENTOS.CORRIDA_INICIO, {})
  e.agregar(EVENTOS.CORRIDA_FIN, {})
  e.agregar(EVENTOS.CORRIDA_INICIO, {})
  e.agregar(EVENTOS.CORRIDA_FIN, {})
  assert.ok(e.estancado())
  fs.unlinkSync(ruta)
})

test('una corrida que cerró algo no está estancada', () => {
  const ruta = path.join(os.tmpdir(), `orq-ok-${Date.now()}.jsonl`)
  const e = new Estado(ruta)
  e.agregar(EVENTOS.CORRIDA_INICIO, {})
  e.agregar(EVENTOS.TICKET_HECHO, { ticketId: 'z' })
  e.agregar(EVENTOS.CORRIDA_INICIO, {})
  e.agregar(EVENTOS.TICKET_HECHO, { ticketId: 'y' })
  assert.ok(!e.estancado())
  fs.unlinkSync(ruta)
})

fs.unlinkSync(LOG)

console.log(`\n${pasados} ok, ${fallados} fallados\n`)
process.exit(fallados === 0 ? 0 : 1)
