// The standalone process a node runs to accept `qvac/task/v0` work: its own
// identity, its own corestore, its own connection to the marketplace topic —
// and, for every accepted ticket, an HTTP call to the SAME node's gateway
// (`--gateway`, default the local `pyrusllm serve` on 127.0.0.1:8787) to
// actually run the model.
//
// -----------------------------------------------------------------------------
// WHY THIS IS ITS OWN PROCESS, NOT A FLAG WIRED INTO `bin.mjs`
//
// `bin.mjs` runs under Bare, and everything it imports has to resolve there —
// which is why qvac/identity.mjs and qvac/corestore.mjs reach for `bare-fs` /
// `bare-path` instead of Node's. The audit's own conclusion (F3 / decision 1)
// was to keep the worker's agent loop OUT of the Bare/OTA binary: the one hop
// going through the gateway removes is noise against a 100-250s inference, and
// pulling it in-process would bypass the gateway's slot counter besides. This
// process is that decision, taken all the way: `worker/task-runner.mjs`,
// `worker/task-accept.mjs`, and everything under `orchestrator/` stay on plain
// Node built-ins (`fs`, `path`, `crypto`) and are never loaded by `bin.mjs`.
//
// WHAT IT SHARES WITH THE BARE NODE, AND WHAT IT DOES NOT
//
// It does NOT share the Bare process's Hyperswarm connections — it opens its
// own, on the SAME marketplace topic (qvac/swarm.mjs's TOPIC), with its own
// persistent identity. That is still "the existing connection" in the sense
// that matters for F1: once this process and a coordinator are peers, the
// context and result drives replicate over THAT connection, with no separate
// DHT announce per ticket. It shares the model itself only via HTTP, to the
// gateway `bin.mjs serve` is already running on this machine.
//
// This process advertises NOTHING about capacity to serve chat — its one
// manifest model entry is `maxConcurrentRequests: 0` on purpose, so the
// marketplace's own routing never considers it a chat candidate. The manifest
// schema is frozen (manifest-v0.json, additionalProperties:false) and has no
// `security.acceptsTasks` field yet, so authorization here is node config
// (--allow), not a signed advertisement — see the constructor note in
// orchestrator/coordinator.mjs for the same call made on the coordinator side.

import fs from 'fs'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
import { NodeSwarm } from '../qvac/swarm.mjs'
import { loadOrCreateIdentity } from '../orchestrator/node-identity.mjs'
import { attachTaskAccept } from './task-accept.mjs'

export async function serveTasks(opts = {}) {
  const dir = path.resolve(opts.storage || path.join('.qvac', 'task-worker'))
  fs.mkdirSync(dir, { recursive: true })

  const identity = loadOrCreateIdentity(dir)
  const store = new Corestore(path.join(dir, 'corestore'))
  await store.ready()

  const swarm = new NodeSwarm({
    identity,
    // One entry, capacity zero: this peer never serves chat, so the
    // marketplace's own routing has no reason to pick it — it exists on the
    // topic only to run the task channel.
    models: [{ modelId: 'task-worker', displayName: 'Task worker (no chat)', maxConcurrentRequests: 0 }],
    operator: opts.operator || `task-worker@${os.hostname()}`,
    tags: ['task-worker'],
    corestore: store
  })

  await swarm.join()
  console.log(`[serve-tasks] identity  : ${identity.publicKey.toString('hex')}`)
  console.log(`[serve-tasks] storage   : ${dir}`)
  console.log(`[serve-tasks] gateway   : ${opts.gateway || 'http://127.0.0.1:8787'}`)

  const allowlist = String(opts.allow || '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)

  const detach = attachTaskAccept({
    swarm,
    store,
    gateway: opts.gateway || 'http://127.0.0.1:8787',
    apiKey: opts.apiKey || null,
    model: opts.model || null,
    allowlist,
    maxConcurrentTasks: Number.isFinite(+opts.maxConcurrentTasks) ? +opts.maxConcurrentTasks : 2
  })

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    console.log('\n[serve-tasks] closing...')
    detach()
    await swarm.destroy()
    await store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { swarm, store, identity, close: shutdown }
}

function parseArgv(argv) {
  const alias = {
    '--storage': 'storage',
    '--gateway': 'gateway',
    '--api-key': 'apiKey',
    '--model': 'model',
    '--allow': 'allow',
    '--operator': 'operator',
    '--max-concurrent-tasks': 'maxConcurrentTasks'
  }
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const key = alias[argv[i]]
    if (key) opts[key] = argv[++i]
  }
  return opts
}

async function main() {
  const opts = parseArgv(process.argv.slice(2))
  if (!opts.allow) {
    console.error(
      '[serve-tasks] --allow <hex-key[,hex-key...]> is required: without it this process' +
        ' is on the topic but accepts task:assign from nobody.'
    )
  }
  await serveTasks(opts)
  console.log('[serve-tasks] waiting for task:assign — Ctrl+C to stop\n')
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
