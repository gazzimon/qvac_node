// The `serve --accept-tasks` side: a node that will do software work assigned by
// a coordinator it trusts.
//
// -----------------------------------------------------------------------------
// THE TRUST BOUNDARY MOVED, AND THIS IS THE FAR SIDE OF IT
//
// On one machine the worker was trusted because the orchestrator spawned it.
// Here the assignment arrives from another machine. So:
//
//   - Being on the topic is not enough. `--accept-tasks` is off by default, and
//     even on, an assignment is only taken from a key on the coordinator
//     allowlist. An empty allowlist accepts from nobody — deliberately.
//   - The jail still runs here (executeTicket → validateWrite), catching the
//     honest mistake. It ALSO runs on the coordinator on arrival (mirror.mjs),
//     catching the dishonest one. Same check, both sides.
//
// WHY THE MODEL CALL IS STILL HTTP TO THE LOCAL GATEWAY
//
// The one hop this removes by going in-process is JSON over loopback, which is
// noise against a 100-250 s inference. And an in-process `engine.complete()`
// call bypasses the gateway's slot counter (store.beginRequest/endRequest) —
// the only place node capacity is tracked — so a node doing task work would
// advertise free capacity while its decode slot is busy. Going through the
// gateway keeps the task's inferences counted like any other request.
// -----------------------------------------------------------------------------

import fs from 'fs'
import os from 'os'
import path from 'path'
import { Harness } from '../orchestrator/harness.mjs'
import { executeTicket } from './task-runner.mjs'
import { openContext } from '../orchestrator/context-drive.mjs'
import { INLINE_CEILING } from '../orchestrator/mirror.mjs'
import {
  TYPES,
  validateInbound,
  timeoutsForAssignment,
  buildAccept,
  buildReject,
  buildProgress,
  buildResult
} from '../orchestrator/task-protocol.mjs'

// attach({ swarm, store, gateway, allowlist, ... }) wires the listener and
// returns a detach function. `store` is the node's corestore — the same one the
// peer connection already replicates, so a context drive opens over that
// connection with no swarm.join.
export function attachTaskAccept({
  swarm,
  store,
  gateway = 'http://127.0.0.1:8787',
  apiKey = null,
  model = null,
  allowlist = [],
  maxConcurrentTasks = 2,
  log = (m) => console.log(`[accept-tasks] ${m}`)
}) {
  const allowed = new Set(allowlist.map((k) => String(k).toLowerCase()))
  const active = new Map() // attemptId -> { ticketId, startedAt }

  log(
    allowed.size
      ? `on · ${allowed.size} coordinator key(s) allowed · up to ${maxConcurrentTasks} task(s)`
      : `on · allowlist EMPTY: no coordinator can assign until one is added`
  )

  const detach = swarm.addTaskListener((peer, msg, reply) => {
    if (msg.type !== TYPES.ASSIGN) return // accept/progress/result are the coordinator's

    const v = validateInbound(msg)
    if (!v.ok) {
      // No attemptId means we cannot even address a reject; drop it.
      if (msg && typeof msg.attemptId === 'string') {
        reply(buildReject({ attemptId: msg.attemptId, reason: 'unsupported-protocol' }))
      }
      return
    }

    if (!allowed.has(peer.key.toLowerCase())) {
      log(`refused ${msg.ticketId} from ${peer.key.slice(0, 8)}… — not on the allowlist`)
      return reply(buildReject({ attemptId: msg.attemptId, reason: 'not-authorized' }))
    }
    if (active.has(msg.attemptId)) {
      return reply(buildReject({ attemptId: msg.attemptId, reason: 'busy-elsewhere' }))
    }
    if (active.size >= maxConcurrentTasks) {
      return reply(buildReject({ attemptId: msg.attemptId, reason: 'at-capacity' }))
    }

    active.set(msg.attemptId, { ticketId: msg.ticketId, startedAt: Date.now() })
    reply(buildAccept({ attemptId: msg.attemptId, etaMs: 120000 }))
    log(`accepted ${msg.ticketId} (${msg.attemptId}) from ${peer.key.slice(0, 8)}…`)

    runAssignment({ msg, reply, store, gateway, apiKey, model, log })
      .catch((err) => {
        log(`${msg.ticketId} crashed: ${(err && err.message) || err}`)
        reply(
          buildResult({
            attemptId: msg.attemptId,
            ok: false,
            reason: 'engine-error'
          })
        )
      })
      .finally(() => active.delete(msg.attemptId))
  })

  return () => {
    detach()
  }
}

async function runAssignment({ msg, reply, store, gateway, apiKey, model, log }) {
  // `deadline` made real: if the coordinator's ceiling has already passed by
  // the time this runs (the assignment sat somewhere in transit), refuse
  // before spending anything, instead of starting a harness with essentially
  // no budget left. Otherwise the harness gets the TIGHTER of its own
  // `limits` and what is left before the deadline — see
  // timeoutsForAssignment's header for why the clamp lives there and not here.
  const timeouts = timeoutsForAssignment(msg)
  if (!timeouts) {
    log(`${msg.ticketId}: deadline already passed on arrival — refusing ${msg.attemptId}`)
    return reply(buildResult({ attemptId: msg.attemptId, ok: false, reason: 'timed-out' }))
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrus-task-'))

  const harness = new Harness({
    maxSteps: msg.limits?.maxSteps || 10,
    maxTokens: msg.limits?.maxTokens || 8000,
    toolTimeoutMs: timeouts.toolTimeoutMs,
    taskTimeoutMs: timeouts.taskTimeoutMs
  })

  // Pull the context files the coordinator flagged. Sparse, by path, over the
  // connection that already exists — no swarm handed to openContext.
  let contextFiles = []
  let ctx = null
  if (msg.contextDrive) {
    try {
      ctx = await openContext(store, msg.contextDrive, { timeoutMs: 30000 })
      for (const p of msg.contextPaths || []) {
        try {
          contextFiles.push({ path: p, content: (await ctx.readFile(p)).toString('utf8') })
        } catch {
          // A hinted path that is not in the drive is not fatal — it is a hint.
        }
      }
    } catch (err) {
      log(`context drive ${msg.contextDrive.slice(0, 8)}… unavailable: ${(err && err.message) || err}`)
      await ctx?.close().catch(() => {})
      return reply(buildResult({ attemptId: msg.attemptId, ok: false, reason: 'context-unavailable' }))
    }
  }

  let lastBeat = 0
  const prog = { bytes: 0, chunks: 0 }
  const onProgress = (text) => {
    prog.chunks++
    prog.bytes += Buffer.byteLength(String(text), 'utf8')
    const now = Date.now()
    if (now - lastBeat > 5000) {
      lastBeat = now
      reply(buildProgress({ attemptId: msg.attemptId, bytes: prog.bytes, chunks: prog.chunks }))
    }
  }

  const callModel = makeGatewayCall({ gateway, apiKey, model, onProgress })

  const r = await executeTicket({
    ticket: { id: msg.ticketId, spec: msg.spec, allowedFiles: msg.allowedFiles },
    workspace,
    callModel,
    harness,
    contextFiles,
    onProgress
  })

  await ctx?.close().catch(() => {})
  fs.rmSync(workspace, { recursive: true, force: true })

  if (!r.ok) {
    return reply(
      buildResult({
        attemptId: msg.attemptId,
        ok: false,
        rejected: r.rejected,
        usage: r.usage,
        reason: r.reason || 'no-blocks'
      })
    )
  }

  // Inline what fits; anything over the ceiling goes on this node's files drive
  // and is fetched by the coordinator over the same connection.
  const total = r.files.reduce((n, f) => n + f.bytes, 0)
  let driveKey = null
  const files = r.files.map((f) => ({ ...f }))
  if (total > INLINE_CEILING) {
    const filesApi = await ensureFilesDrive(store)
    driveKey = filesApi.keyHex
    for (const f of files) {
      await filesApi.drive.put('/' + f.path, Buffer.from(f.content, 'utf8'))
      delete f.content
      f.drive = true
    }
    log(`result ${msg.ticketId}: ${(total / 1024).toFixed(0)} KB over the ceiling → files drive`)
  }

  reply(
    buildResult({
      attemptId: msg.attemptId,
      ok: true,
      files,
      rejected: r.rejected,
      usage: r.usage,
      driveKey
    })
  )
  log(`delivered ${msg.ticketId}: ${files.length} file(s)${driveKey ? ' via drive' : ' inline'}`)
}

// A model call that POSTs the OpenAI protocol to the local gateway. Returns the
// shape executeTicket expects: { text, tokens, tokenSource }.
//
// Streams (`stream: true`) instead of waiting for the whole response, and
// forwards each SSE delta to `onProgress`. Measured: a non-streaming call only
// resolves once generation is fully done, so executeTicket's own one-shot
// onProgress(text) call (task-runner.mjs) never fires until the ticket is
// already finished — and the coordinator's progressGraceMs watchdog (120s,
// coordinator.mjs) abandons the attempt as "worker went silent" well before
// that, even while the model is genuinely generating (a landing-page ticket on
// qwen4b was still producing chunks past 60s with zero heartbeats sent). The
// gateway does not emit `usage` on stream (qvac/gateway.mjs), so token count
// stays the same byte-estimate fallback the non-streaming path already used.
function makeGatewayCall({ gateway, apiKey, model, onProgress = null }) {
  return async ({ system, user, maxTokens }) => {
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    let resolvedModel = model
    if (!resolvedModel) {
      const mr = await fetch(`${gateway}/v1/models`, { headers })
      if (!mr.ok) throw new Error(`could not read the model catalogue: ${mr.status}`)
      resolvedModel = (await mr.json()).data?.[0]?.id
      if (!resolvedModel) throw new Error('the gateway advertises no model')
    }

    const res = await fetch(`${gateway}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: true,
        max_tokens: maxTokens
      })
    })
    if (!res.ok) {
      const err = new Error(`gateway returned ${res.status}: ${await res.text()}`)
      err.status = res.status
      throw err
    }

    let text = ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const line = rawEvent.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let evt
        try {
          evt = JSON.parse(payload)
        } catch {
          continue // a malformed chunk is not fatal to the stream, just skipped
        }
        const delta = evt.choices?.[0]?.delta?.content
        if (delta) {
          text += delta
          if (onProgress) onProgress(delta)
        }
      }
    }

    const bytes = Buffer.byteLength(system) + Buffer.byteLength(user) + Buffer.byteLength(text)
    return { text, tokens: Math.ceil(bytes / 4), tokenSource: 'gateway' }
  }
}

// Lazily open a Files-style drive for result overflow. Kept tiny: one writable
// Hyperdrive in the node's own namespace, reachable by key over any connection
// the corestore already replicates.
let _filesDrive = null
async function ensureFilesDrive(store) {
  if (_filesDrive) return _filesDrive
  const { default: Hyperdrive } = await import('hyperdrive')
  const drive = new Hyperdrive(store.namespace('task-results'))
  await drive.ready()
  _filesDrive = { drive, keyHex: drive.key.toString('hex') }
  return _filesDrive
}
