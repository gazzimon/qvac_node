// El ciclo completo, sin un nodo prendido: orquestador -> workers en paralelo ->
// archivos en disco -> CI -> ticket cerrado -> segunda corrida que no rehace.
//
// El gateway falso devuelve el archivo que le corresponde a cada ticket, así que
// lo que se prueba es la coordinación: que dos workers escriban a la vez sin
// pisarse, que el gate de CI decida, y que el estado sobreviva al proceso.
//
//   node test/orquestador-e2e.mjs

import assert from 'assert'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { Orchestrator } from '../orchestrator/index.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-e2e-'))
const WS = path.join(TMP, 'workspace')
const STORE = path.join(TMP, 'orq')
const REQ = path.join(TMP, 'requirements.md')

fs.writeFileSync(
  REQ,
  `# Demo

## Ticket: suma
Implementar una función suma
Depende de: ninguno
Files: src/suma.js

## Ticket: resta
Implementar una función resta
Depende de: ninguno
Files: src/resta.js
`
)

// El workspace tiene que ser un proyecto que `npm test` pueda correr. El test
// de verdad es trivial a propósito: lo que se está probando es el GATE, no la
// suite del proyecto generado.
fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(
  path.join(WS, 'package.json'),
  JSON.stringify(
    {
      name: 'demo-generada',
      type: 'module',
      scripts: { test: 'node verificar.mjs' }
    },
    null,
    2
  )
)
fs.writeFileSync(
  path.join(WS, 'verificar.mjs'),
  `import fs from 'fs'
// Verde solo si los DOS archivos existen: así el CI del primer ticket que
// termina da rojo, y el del segundo da verde. Es el gate haciendo su trabajo.
const faltan = ['src/suma.js', 'src/resta.js'].filter((f) => !fs.existsSync(f))
if (faltan.length) {
  console.error('faltan: ' + faltan.join(', '))
  process.exit(1)
}
console.log('ok')
`
)

const CODIGO = {
  suma: 'export const suma = (a, b) => a + b\n',
  resta: 'export const resta = (a, b) => a - b\n'
}

function gatewayFalso() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: 'falso', object: 'model' }] }))
      }
      if (req.url === '/v1/chat/completions') {
        let cuerpo = ''
        req.on('data', (c) => (cuerpo += c))
        req.on('end', () => {
          const pedido = JSON.parse(cuerpo)
          // Qué archivo pide este worker sale de su propio system prompt.
          const sys = pedido.messages[0].content
          const cual = sys.includes('src/suma.js') ? 'suma' : 'resta'
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '```file path=src/' + cual + '.js\n' + CODIGO[cual] + '```'
                  }
                }
              ],
              usage: { total_tokens: 90 }
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

const server = await gatewayFalso()
const gateway = `http://127.0.0.1:${server.address().port}`
console.log(`gateway falso: ${gateway}\n`)

const opts = {
  gateway,
  requirement: REQ,
  workspace: WS,
  storage: STORE,
  workers: 2
}

console.log('=== primera corrida ===')
const r1 = await new Orchestrator(opts).start()

console.log('\n=== segunda corrida (debería no rehacer nada) ===')
const r2 = await new Orchestrator(opts).start()

server.close()

console.log('\n--- verificaciones ---')
let ok = 0
let mal = 0
function chequear(nombre, fn) {
  try {
    fn()
    ok++
    console.log(`  ok  ${nombre}`)
  } catch (err) {
    mal++
    console.log(`  NO  ${nombre}\n      ${err.message}`)
  }
}

chequear('los dos archivos existen en el workspace', () => {
  assert.ok(fs.existsSync(path.join(WS, 'src', 'suma.js')), 'falta suma.js')
  assert.ok(fs.existsSync(path.join(WS, 'src', 'resta.js')), 'falta resta.js')
})

chequear('el contenido es el que mandó el modelo', () => {
  assert.ok(fs.readFileSync(path.join(WS, 'src', 'suma.js'), 'utf8').includes('a + b'))
  assert.ok(fs.readFileSync(path.join(WS, 'src', 'resta.js'), 'utf8').includes('a - b'))
})

chequear('cada worker anunció la clave de SU drive, y son distintas', () => {
  const claves = Object.values(r1.drives)
  assert.equal(claves.length, 2, `esperaba 2 claves, hay ${claves.length}`)
  assert.notEqual(claves[0], claves[1], 'dos workers no pueden compartir drive')
  for (const k of claves) assert.match(k, /^[0-9a-f]{64}$/)
})

chequear('al menos un ticket cerró con CI verde', () => {
  assert.ok(r1.hechos >= 1, `hechos=${r1.hechos}`)
})

chequear('la segunda corrida no retrocede', () => {
  assert.ok(r2.hechos >= r1.hechos, `r1=${r1.hechos} r2=${r2.hechos}`)
})

chequear('el log de corridas quedó en disco y es releíble', () => {
  const p = path.join(STORE, 'corridas.jsonl')
  assert.ok(fs.existsSync(p))
  const lineas = fs.readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(lineas.some((l) => l.tipo === 'corrida:inicio'))
  assert.ok(lineas.some((l) => l.tipo === 'ticket:hecho'))
})

console.log(`\n${ok} ok, ${mal} fallados`)
console.log(`workspace: ${WS}`)
process.exitCode = mal === 0 ? 0 : 1
