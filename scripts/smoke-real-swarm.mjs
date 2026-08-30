// One-off manual verification, NOT part of the fast test suite: two real
// NodeSwarm instances (real Hyperswarm, real DHT discovery) standing in for a
// coordinator and a worker on separate machines, finding each other the way
// NOTES.md measures (seconds, with real variance) rather than over a FakeSwarm
// or a pre-wired socket. Deliberately excluded from `npm run test:orchestrator`
// — this repo's own findings (NOTES.md, "la varianza es el riesgo") are that
// DHT timing does not belong in a suite that has to be fast and deterministic.
//
//   node scripts/smoke-real-swarm.mjs

import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
import { NodeSwarm } from '../qvac/swarm.mjs'
import { loadOrCreateIdentity } from '../orchestrator/node-identity.mjs'
import { attachTaskAccept } from '../worker/task-accept.mjs'
import { Coordinator } from '../orchestrator/coordinator.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-real-swarm-'))
const WS = path.join(TMP, 'workspace')
const REQ = path.join(TMP, 'requirements.md')
fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(
  REQ,
  `# Demo\n\n## Ticket: greet\nImplement a greeting function\nDepends on: none\nFiles: src/greet.js\n`
)
fs.writeFileSync(
  path.join(WS, 'package.json'),
  JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
)
fs.writeFileSync(
  path.join(WS, 'verify.mjs'),
  `import fs from 'fs'\nif (!fs.existsSync('src/greet.js')) process.exit(1)\nconsole.log('ok')\n`
)

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'fake', object: 'model' }] }))
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '```file path=src/greet.js\nexport const greet = () => "real-swarm"\n```'
            }
          }
        ],
        usage: { total_tokens: 42 }
      })
    )
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const gateway = `http://127.0.0.1:${server.address().port}`
console.log(`fake gateway: ${gateway}`)

async function bootSwarm(dir, models) {
  fs.mkdirSync(dir, { recursive: true })
  const identity = loadOrCreateIdentity(dir)
  const store = new Corestore(path.join(dir, 'corestore'))
  await store.ready()
  const swarm = new NodeSwarm({ identity, models, operator: path.basename(dir), tags: [], corestore: store })
  await swarm.join()
  return { identity, store, swarm }
}

console.log('joining the REAL marketplace topic (this can take several seconds — see NOTES.md)...')
const t0 = Date.now()

const worker = await bootSwarm(path.join(TMP, 'worker'), [
  { modelId: 'task-worker', maxConcurrentRequests: 0 }
])
const coord = await bootSwarm(path.join(TMP, 'coord'), [
  { modelId: 'coordinator', maxConcurrentRequests: 0 }
])

const workerKey = worker.identity.publicKey.toString('hex')
const coordKey = coord.identity.publicKey.toString('hex')
console.log(`worker key: ${workerKey}`)
console.log(`coord  key: ${coordKey}`)

const detach = attachTaskAccept({
  swarm: worker.swarm,
  store: worker.store,
  gateway,
  allowlist: [coordKey],
  maxConcurrentTasks: 2
})

// Wait for the two to actually see each other over the DHT before assigning —
// exactly the discovery step NOTES.md measures at up to ~38s in the tail.
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the two swarms never found each other in 90s')), 90000)
  const check = setInterval(() => {
    if (coord.swarm.peers.has(workerKey)) {
      clearInterval(check)
      clearTimeout(timer)
      resolve()
    }
  }, 200)
})
console.log(`peers found each other in ${Date.now() - t0}ms (real DHT, not a fake)`)

const coordinator = new Coordinator({
  swarm: coord.swarm,
  store: coord.store,
  workspace: WS,
  storageDir: path.join(TMP, 'coord-run'),
  requirementFile: REQ,
  workerKeys: [workerKey]
})

const summary = await coordinator.run()
console.log('summary:', summary)

const written = fs.readFileSync(path.join(WS, 'src', 'greet.js'), 'utf8')
console.log('workspace file:', written.trim())

const pass = summary.done === 1 && written.includes('real-swarm')
console.log(pass ? '\nPASS — real swarm, real drive replication, real task protocol' : '\nFAIL')

detach()
await coordinator.close()
await worker.swarm.destroy()
await coord.swarm.destroy()
await worker.store.close()
await coord.store.close()
server.close()
process.exit(pass ? 0 : 1)
