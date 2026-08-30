// The wire vocabulary for `qvac/task/v0`: how a coordinator hands a unit of
// software work to a worker over the connection that ALREADY exists.
//
// -----------------------------------------------------------------------------
// WHY THIS IS ITS OWN MODULE, WITH NO IMPORTS
//
// Same rule the rest of this repo follows (routing.mjs, split.mjs): the message
// layer is a decision, not a transport. It builds and validates plain objects
// and nothing else — no swarm, no drive, no fs — so the whole protocol can be
// tested without standing anything up. `coordinator.mjs` and the worker side
// import the transport; this file never does.
//
// WHY EVERYTHING RIDES ONE JSON MESSAGE
//
// The control channel (`qvac/channel.mjs`) carries a SINGLE JSON message type
// on purpose: with the OTA running, two nodes on different builds is the normal
// case, and a node that does not recognise a `type` just ignores it in
// `_dispatch` and keeps going. So `task:*` is not a new Protomux channel or a
// new message table — it is more values for the `type` field that is already
// there. Adding one is backwards-compatible by construction.
//
// WHY THE VERSION TRAVELS IN EVERY MESSAGE
//
// New `type`s are additive and safe. A CHANGED FIELD in an existing message is
// not. Every message carries `protocol: "qvac/task/v0"`; a receiver that does
// not know the version answers `task:reject` with `unsupported-protocol`
// instead of guessing. A breaking change becomes `qvac/task/v1`, a new value,
// spoken alongside v0 until the fleet has rolled over.

export const TASK_PROTOCOL = 'qvac/task/v0'

export const TYPES = {
  ASSIGN: 'task:assign',
  ACCEPT: 'task:accept',
  REJECT: 'task:reject',
  PROGRESS: 'task:progress',
  RESULT: 'task:result',
  // coordinator -> worker: this attempt has been given up on. Sent when the
  // progress watchdog fires, so the worker can stop and — the reason this
  // exists — FREE THE SLOT. Measured on the K16: two attempts the coordinator
  // had abandoned were still counted as active by the worker, so the third
  // ticket of the run was refused `at-capacity` by a node that was, as far as
  // the coordinator knew, doing nothing. `chat:cancel` already does the
  // equivalent for inference; tasks had no counterpart.
  //
  // Advisory, like everything else here: a worker on an older build ignores
  // the unknown type and simply keeps its slot until the work finishes.
  CANCEL: 'task:cancel'
}

// `task:ack` from the earlier draft is gone: with results delivered INLINE in
// `task:result` (up to INLINE_CEILING, see mirror.mjs), there is nothing left
// for the worker to seed and nothing to acknowledge. The slot is released when
// `task:result` is sent. A drive is only used for an overflow artefact, and
// that path carries its own completion signal.

// Refusal reasons a worker may send. Closed set so the coordinator can branch
// without matching prose: `not-authorized` (key not on the allowlist),
// `at-capacity` (maxConcurrentTasks reached), `unsupported-protocol` (version),
// `no-model` (no engine loaded / reachable), `tasks-disabled` (`--accept-tasks`
// off). `busy-elsewhere` is for a worker that already holds this exact
// attemptId — a duplicate assign, harmless, refused idempotently.
export const REJECT_REASONS = new Set([
  'not-authorized',
  'at-capacity',
  'unsupported-protocol',
  'no-model',
  'tasks-disabled',
  'busy-elsewhere'
])

// Failure reasons in a `task:result` with `ok: false`. Mirrors the worker's own
// vocabulary in `worker/run.mjs` so the run log reads the same on both sides.
export const RESULT_REASONS = new Set([
  'limit-reached',
  'no-blocks',
  'reasoning-unclosed',
  'engine-error',
  'context-unavailable',
  'timed-out'
])

// -----------------------------------------------------------------------------
// attemptId — the idempotency key, PER ASSIGNMENT, not per ticket
// -----------------------------------------------------------------------------
//
// The case that forces it: a ticket goes to worker B, B goes quiet, the
// coordinator times out and reassigns to C, and then B comes back and delivers.
// Two results, one ticket. The coordinator accepts a result only for the
// attempt currently live for that ticket; B's carries a dead attemptId and is
// discarded with a log line.
//
// Keyed per TICKET instead, a reassignment would reuse the key and the second
// delivery would be rejected as a duplicate — so a legitimate retry could never
// deliver at all.
//
// Shape: `<ticketId>#<base36 time><base36 counter>`. The ticketId prefix keeps
// it greppable in the run log; the suffix makes it unique even for two attempts
// minted in the same millisecond.
let _seq = 0
export function mintAttemptId(ticketId) {
  if (!ticketId || typeof ticketId !== 'string') {
    throw new Error('mintAttemptId: ticketId (string) is required')
  }
  return `${ticketId}#${Date.now().toString(36)}${(_seq++).toString(36)}`
}

// The ticketId is recoverable from the attemptId, which is what lets the run
// log key `ticket:*` events on the stable id while `attemptId` rides alongside.
export function ticketIdOf(attemptId) {
  const i = String(attemptId).indexOf('#')
  return i === -1 ? String(attemptId) : String(attemptId).slice(0, i)
}

// -----------------------------------------------------------------------------
// Turning a `task:assign` into the timeouts a worker's Harness can use.
//
// `deadline` used to be sent and never read: the worker was bound only by its
// OWN `limits.taskTimeoutMs`, so a coordinator that needed a tighter ceiling
// had no way to enforce it, and nothing would ever notice the two numbers
// drifting apart. This is the one place that reads `deadline` and turns it
// into real timeouts, so worker/task-accept.mjs never has to reimplement the
// clamping logic (or, worse, skip it).
//
// `Harness` requires `toolTimeoutMs` strictly less than `taskTimeoutMs` — see
// its constructor — so the tool timeout here is always DERIVED from the
// already-clamped task timeout, never handed through separately clamped.
// -----------------------------------------------------------------------------

// Returns { taskTimeoutMs, toolTimeoutMs }, or `null` if `now` is already past
// `msg.deadline` — the caller's cue to refuse the assignment outright rather
// than start work against a budget of zero or negative time.
// toolTimeoutMs is always strictly under the (possibly clamped)
// taskTimeoutMs — never a fixed floor, which could exceed a deadline-clamped
// taskTimeoutMs on a razor-thin deadline and violate that invariant.
export function timeoutsForAssignment(msg, { now = Date.now() } = {}) {
  const defaultTask = msg.limits?.taskTimeoutMs || 1800000
  const defaultTool = msg.limits?.toolTimeoutMs || 600000

  if (!msg.deadline || msg.deadline <= 0) {
    return { taskTimeoutMs: defaultTask, toolTimeoutMs: defaultTool }
  }

  const remaining = msg.deadline - now
  // < 2, not <= 0: with 1ms of nominal budget there is no integer pair
  // (taskTimeoutMs, toolTimeoutMs) with toolTimeoutMs strictly under
  // taskTimeoutMs and both >= 1. Under 2ms is "no time to speak of" anyway —
  // treated the same as an already-passed deadline.
  if (remaining < 2) return null

  const taskTimeoutMs = Math.min(defaultTask, remaining)
  // Always strictly under taskTimeoutMs — Harness's constructor throws
  // otherwise. No floor here: with a genuinely razor-thin deadline, an
  // absurdly small tool timeout IS the correct answer (there just is not more
  // time to give), not a case to special-case a floor for that could put it
  // back over taskTimeoutMs and make the clamp self-defeating.
  const toolTimeoutMs = Math.min(defaultTool, Math.max(1, Math.floor(taskTimeoutMs / 2)))
  return { taskTimeoutMs, toolTimeoutMs }
}

// -----------------------------------------------------------------------------
// Builders — the coordinator and the worker construct messages only through
// these, so the required fields cannot drift between call sites.
// -----------------------------------------------------------------------------

// coordinator -> worker
export function buildAssign({
  attemptId,
  ticketId,
  spec,
  allowedFiles,
  contextDrive = null,
  contextPaths = [],
  // Paths this ticket owns that ALREADY EXIST, created by a ticket it depends
  // on. Additive and optional, per this protocol's versioning rule: a worker
  // that does not know the field still runs correctly — it just treats those
  // files as ordinary reference context instead of as material to return
  // updated. Always a subset of `allowedFiles`.
  editPaths = [],
  limits = {},
  deadline = 0
}) {
  if (!attemptId) throw new Error('buildAssign: attemptId is required')
  if (!ticketId) throw new Error('buildAssign: ticketId is required')
  if (typeof spec !== 'string' || !spec.trim()) {
    throw new Error('buildAssign: spec (non-empty string) is required')
  }
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    throw new Error('buildAssign: allowedFiles must be a non-empty array')
  }
  return {
    type: TYPES.ASSIGN,
    protocol: TASK_PROTOCOL,
    attemptId,
    ticketId,
    spec,
    allowedFiles: allowedFiles.slice(),
    ...(contextDrive ? { contextDrive } : {}),
    ...(contextPaths.length ? { contextPaths: contextPaths.slice() } : {}),
    ...(editPaths.length ? { editPaths: editPaths.slice() } : {}),
    limits: {
      maxSteps: limits.maxSteps ?? null,
      maxTokens: limits.maxTokens ?? null,
      toolTimeoutMs: limits.toolTimeoutMs ?? null,
      taskTimeoutMs: limits.taskTimeoutMs ?? null
    },
    deadline: Number(deadline) || 0
  }
}

// worker -> coordinator, immediately, before any work starts
export function buildAccept({ attemptId, etaMs = 0 }) {
  if (!attemptId) throw new Error('buildAccept: attemptId is required')
  return {
    type: TYPES.ACCEPT,
    protocol: TASK_PROTOCOL,
    attemptId,
    accepted: true,
    ...(etaMs > 0 ? { etaMs: Math.round(etaMs) } : {})
  }
}

export function buildReject({ attemptId, reason }) {
  if (!attemptId) throw new Error('buildReject: attemptId is required')
  if (!REJECT_REASONS.has(reason)) {
    throw new Error(`buildReject: unknown reason "${reason}"`)
  }
  return {
    type: TYPES.REJECT,
    protocol: TASK_PROTOCOL,
    attemptId,
    accepted: false,
    reason
  }
}

// worker -> coordinator, optional heartbeat. The only thing that tells a node
// thinking hard from a node that fell over. Carries the same numbers
// `--log-inference` prints locally (bytes, chunks, TTFT) — never a token count
// the engine did not give us.
// coordinator -> worker
export function buildCancel({ attemptId, reason = 'abandoned' }) {
  if (!attemptId) throw new Error('buildCancel: attemptId is required')
  return { type: TYPES.CANCEL, protocol: TASK_PROTOCOL, attemptId, reason: String(reason) }
}

export function buildProgress({ attemptId, bytes = 0, chunks = 0, ttftMs = null, note = '' }) {
  if (!attemptId) throw new Error('buildProgress: attemptId is required')
  return {
    type: TYPES.PROGRESS,
    protocol: TASK_PROTOCOL,
    attemptId,
    bytes: Number(bytes) || 0,
    chunks: Number(chunks) || 0,
    ttftMs: ttftMs === null ? null : Number(ttftMs),
    ...(note ? { note: String(note).slice(0, 200) } : {})
  }
}

// worker -> coordinator. `files` carries the bytes INLINE when they fit under
// the ceiling; `driveKey` + per-file `drive: true` is the overflow path. See
// mirror.mjs for how the coordinator applies it.
export function buildResult({
  attemptId,
  ok,
  files = [],
  rejected = [],
  usage = {},
  driveKey = null,
  reason = null
}) {
  if (!attemptId) throw new Error('buildResult: attemptId is required')
  if (typeof ok !== 'boolean') throw new Error('buildResult: ok (boolean) is required')
  if (reason !== null && !RESULT_REASONS.has(reason)) {
    throw new Error(`buildResult: unknown reason "${reason}"`)
  }
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.hash !== 'string') {
      throw new Error('buildResult: every file needs { path, hash }')
    }
    if (f.content == null && f.drive !== true) {
      throw new Error(`buildResult: file ${f.path} has neither inline content nor drive:true`)
    }
    if (f.drive === true && !driveKey) {
      throw new Error(`buildResult: file ${f.path} is drive:true but no driveKey was given`)
    }
  }
  return {
    type: TYPES.RESULT,
    protocol: TASK_PROTOCOL,
    attemptId,
    ok,
    files: files.map((f) => ({
      path: f.path,
      hash: f.hash,
      bytes: Number(f.bytes) || 0,
      ...(f.drive === true ? { drive: true } : { content: f.content })
    })),
    rejected: rejected.slice(),
    usage: {
      steps: usage.steps ?? 0,
      tokens: usage.tokens ?? 0,
      tokenSource: usage.tokenSource ?? null
    },
    ...(driveKey ? { driveKey } : {}),
    ...(reason ? { reason } : {})
  }
}

// -----------------------------------------------------------------------------
// Inbound validation — the FIRST thing either side does with a `task:*` message
// off the wire. Returns { ok, reason } so the caller can answer `task:reject`
// with `unsupported-protocol` rather than throwing on a peer's malformed frame.
// -----------------------------------------------------------------------------
export function validateInbound(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'not-an-object' }
  if (typeof msg.type !== 'string' || !msg.type.startsWith('task:')) {
    return { ok: false, reason: 'not-a-task-message' }
  }
  if (msg.protocol !== TASK_PROTOCOL) {
    return { ok: false, reason: 'unsupported-protocol' }
  }
  if (typeof msg.attemptId !== 'string' || !msg.attemptId) {
    return { ok: false, reason: 'missing-attemptId' }
  }

  switch (msg.type) {
    case TYPES.ASSIGN:
      if (typeof msg.ticketId !== 'string' || !msg.ticketId) {
        return { ok: false, reason: 'missing-ticketId' }
      }
      if (typeof msg.spec !== 'string' || !msg.spec.trim()) {
        return { ok: false, reason: 'missing-spec' }
      }
      if (!Array.isArray(msg.allowedFiles) || msg.allowedFiles.length === 0) {
        return { ok: false, reason: 'missing-allowedFiles' }
      }
      if (msg.contextDrive != null && !/^[0-9a-f]{64}$/.test(msg.contextDrive)) {
        return { ok: false, reason: 'bad-contextDrive' }
      }
      return { ok: true }

    case TYPES.ACCEPT:
    case TYPES.REJECT:
      if (typeof msg.accepted !== 'boolean') return { ok: false, reason: 'missing-accepted' }
      if (msg.type === TYPES.REJECT && !REJECT_REASONS.has(msg.reason)) {
        return { ok: false, reason: 'bad-reject-reason' }
      }
      return { ok: true }

    case TYPES.PROGRESS:
    case TYPES.CANCEL:
      return { ok: true }

    case TYPES.RESULT:
      if (typeof msg.ok !== 'boolean') return { ok: false, reason: 'missing-ok' }
      if (!Array.isArray(msg.files)) return { ok: false, reason: 'missing-files' }
      for (const f of msg.files) {
        if (!f || typeof f.path !== 'string' || typeof f.hash !== 'string') {
          return { ok: false, reason: 'bad-file-entry' }
        }
        if (f.content == null && f.drive !== true) {
          return { ok: false, reason: 'file-without-bytes' }
        }
      }
      if (msg.files.some((f) => f.drive === true) && !/^[0-9a-f]{64}$/.test(msg.driveKey || '')) {
        return { ok: false, reason: 'drive-file-without-driveKey' }
      }
      return { ok: true }

    default:
      // A `task:` type this build does not know. Not an error: a newer peer may
      // speak more of them. The caller ignores it, exactly as `_dispatch` does.
      return { ok: false, reason: 'unknown-task-type' }
  }
}
