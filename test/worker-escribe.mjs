// Prueba end-to-end del worker SIN un nodo prendido: se levanta un gateway
// falso que habla el protocolo de OpenAI y devuelve bloques ```file, y se
// verifica que los archivos aparezcan en disco Y en el Hyperdrive.
//
// El gateway falso existe para probar el worker, no el modelo: lo que se está
// verificando es que el ciclo pedir -> parsear -> validar -> escribir funciona,
// y que un bloque fuera del ticket se rechaza aunque el "modelo" lo mande.
//
//   node test/worker-escribe.mjs

import assert from 'assert'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { Worker } from '../worker/run.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-worker-'))
const WS = path.join(TMP, 'workspace')
const STORE_W = path.join(TMP, 'worker')

// El "modelo" devuelve tres bloques: dos que el ticket permite y uno que no.
const RESPUESTA = [
  'Acá va el código.',
  '',
  '```file path=src/saludo.js',
  "export function saludo (nombre) {",
  "  return `hola ${nombre}`",
  '}',
  '```',
  '',
  '```file path=tests/saludo.test.js',
  "import { saludo } from '../src/saludo.js'",
  "console.log(saludo('mundo'))",
  '```',
  '',
  '```file path=src/NO-PERMITIDO.js',
  "// este bloque está fuera del ticket y tiene que rechazarse",
  '```'
].join('\n')

function levantarGatewayFalso() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: 'modelo-falso', object: 'model' }] }))
      }
      if (req.url === '/v1/chat/completions') {
        let cuerpo = ''
        req.on('data', (c) => (cuerpo += c))
        req.on('end', () => {
          const pedido = JSON.parse(cuerpo)
          // El prompt de sistema tiene que decirle qué archivos puede tocar.
          assert.ok(
            pedido.messages[0].content.includes('src/saludo.js'),
            'el system prompt tiene que listar los archivos del ticket'
          )
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: RESPUESTA } }],
              usage: { total_tokens: 120 }
            })
          )
        })
        return
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const server = await levantarGatewayFalso()
const puerto = server.address().port
console.log(`gateway falso en 127.0.0.1:${puerto}`)

const worker = new Worker({
  gateway: `http://127.0.0.1:${puerto}`,
  ticket: 'saludo',
  spec: 'Implementar una función que salude',
  allowedFiles: 'src/saludo.js,tests/saludo.test.js',
  workspace: WS,
  storage: STORE_W
})

// `cerrar: false` porque abajo se inspecciona el drive: si el worker lo cierra
// al terminar, las verificaciones sobre el drive no tendrían qué mirar.
const r = await worker.start({ cerrar: false })
server.close()

console.log('\n--- verificaciones ---')

let ok = 0
let mal = 0
function chequear (nombre, fn) {
  try {
    fn()
    ok++
    console.log(`  ok  ${nombre}`)
  } catch (err) {
    mal++
    console.log(`  NO  ${nombre}\n      ${err.message}`)
  }
}

chequear('el worker reporta que escribió', () => {
  assert.equal(r.ok, true)
  assert.equal(r.escritos, 2)
})

chequear('src/saludo.js existe en disco y tiene el contenido', () => {
  const p = path.join(WS, 'src', 'saludo.js')
  assert.ok(fs.existsSync(p), `no existe ${p}`)
  assert.ok(fs.readFileSync(p, 'utf8').includes('export function saludo'))
})

chequear('tests/saludo.test.js existe en disco', () => {
  assert.ok(fs.existsSync(path.join(WS, 'tests', 'saludo.test.js')))
})

chequear('el bloque fuera del ticket NO se escribió', () => {
  assert.ok(!fs.existsSync(path.join(WS, 'src', 'NO-PERMITIDO.js')))
})

chequear('el rechazo quedó registrado como violación', () => {
  assert.equal(worker.violaciones.length, 1)
  assert.equal(worker.violaciones[0].path, 'src/NO-PERMITIDO.js')
  assert.equal(worker.violaciones[0].motivo, 'ruta fuera del ticket')
})

chequear('el drive del worker es escribible (es SU drive, no uno ajeno)', () => {
  assert.equal(worker.drive.core.writable, true)
})

// Lo que hace que las otras máquinas vean el cambio: el archivo tiene que estar
// en el Hyperdrive, no solo en el disco local.
const enDrive = await worker.drive.get('/src/saludo.js')
chequear('src/saludo.js está en el Hyperdrive, no solo en disco', () => {
  assert.ok(enDrive, 'el drive no tiene /src/saludo.js')
  assert.ok(enDrive.toString('utf8').includes('export function saludo'))
})

// Se resuelve ANTES de chequear: un `async` pasado a `chequear` devuelve una
// promesa que nadie espera, la aserción de adentro no corre nunca y el test
// pasa en falso.
const rechazadoEnDrive = await worker.drive.get('/src/NO-PERMITIDO.js')
chequear('el rechazado NO está en el drive tampoco', () => {
  assert.equal(rechazadoEnDrive, null)
})

chequear('la clave del drive quedó en disco para el orquestador', () => {
  const p = path.join(STORE_W, 'drive-key')
  assert.ok(fs.existsSync(p))
  assert.equal(fs.readFileSync(p, 'utf8'), worker.driveKey)
})

chequear('el harness contó el gasto', () => {
  const s = worker.harness.summary()
  assert.equal(s.steps, 1)
  assert.equal(s.tokensUsed, 120)
})

chequear('quedó el log JSONL del worker', () => {
  const log = path.join(STORE_W, 'saludo.jsonl')
  assert.ok(fs.existsSync(log))
  const lineas = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(lineas.some((l) => l.type === 'write'))
  assert.ok(lineas.some((l) => l.type === 'violation'))
})

console.log(`\n${ok} ok, ${mal} fallados`)
console.log(`workspace quedó en: ${WS}`)

// Salir por `exitCode` y no por `process.exit()`: en Windows, bajar el proceso
// con los handles de RocksDB todavía abiertos hace que libuv aborte con un
// assert — después de que el test pasó, así que se lee como si hubiera fallado.
await worker.close()

process.exitCode = mal === 0 ? 0 : 1
