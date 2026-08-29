// The jail: which files a worker may touch, and which tools it may call.
//
// Enforced here and not in the prompt, because a prompt is a suggestion and
// this is a condition. The contents of a repo file and the output of a test run
// are inputs of unknown origin: they can carry instructions.

import path from 'path'

export const FORBIDDEN_TOOLS = new Set([
  'delete_directory',
  'move_file',
  'chmod',
  'sudo',
  'fetch'
])

export const BASE_TOOLS = [
  'read_file',
  'write_file',
  'list_dir',
  'search_files',
  'git_status',
  'git_diff',
  'git_add',
  'git_commit'
]

export class ScopeViolation extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`)
    this.reason = reason
  }
}

// Normalise to the shape a ticket uses: always relative, always forward slashes.
export function normalise(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

// Resolve the path against the workspace and confirm it did not escape. A
// `../../etc/passwd` only leaves the workspace once resolved, not before — which
// is why the comparison is on the ABSOLUTE path and not on the incoming string.
export function resolveInWorkspace(workspace, filePath) {
  const root = path.resolve(workspace)
  const abs = path.resolve(root, normalise(filePath))
  const inside = abs === root || abs.startsWith(root + path.sep)
  if (!inside) {
    throw new ScopeViolation('escaped the workspace', filePath)
  }
  return abs
}

// A ticket's allowlist matches either an exact file or a directory prefix.
// `src/db.js` does not grant `src/db.js.bak`, while `src/` does grant everything
// beneath it — the trailing slash is what makes the difference.
export function isPathAllowed(filePath, allowedFiles) {
  const target = normalise(filePath)
  return allowedFiles.some((allowed) => {
    const a = normalise(allowed)
    if (target === a) return true
    const prefix = a.endsWith('/') ? a : a + '/'
    return target.startsWith(prefix)
  })
}

export function validateWrite(workspace, filePath, allowedFiles) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    throw new ScopeViolation('ticket has no allowedFiles', filePath)
  }
  const abs = resolveInWorkspace(workspace, filePath)
  if (!isPathAllowed(filePath, allowedFiles)) {
    throw new ScopeViolation('path outside the ticket', filePath)
  }
  return abs
}

// Reads are deliberately wider than writes: a worker needs to see the rest of
// the repo to write coherent code, but it may not modify it. The workspace is
// still the boundary.
export function validateRead(workspace, filePath) {
  return resolveInWorkspace(workspace, filePath)
}

export function validateTool(name, allowedTools = BASE_TOOLS) {
  if (FORBIDDEN_TOOLS.has(name)) {
    throw new ScopeViolation('forbidden tool', name)
  }
  if (!allowedTools.includes(name)) {
    throw new ScopeViolation('tool not in the allowlist', name)
  }
  return true
}

// The violation log is a metric, not a debug trace: it is the number that says
// how often an input of unknown origin got the agent to try to step outside its
// scope.
export class ViolationLog {
  constructor() {
    this.entries = []
  }

  record(ticketId, err) {
    this.entries.push({
      ts: new Date().toISOString(),
      ticketId,
      reason: err.reason || 'unknown',
      detail: err.message
    })
  }

  total() {
    return this.entries.length
  }

  byReason() {
    const counts = {}
    for (const e of this.entries) counts[e.reason] = (counts[e.reason] || 0) + 1
    return counts
  }
}
