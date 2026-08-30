// Applying a worker's `task:result` into the coordinator's workspace.
//
// This is the second half of the trust boundary. The worker's own jail catches
// the honest mistake on the far machine; THIS runs on arrival and catches the
// dishonest one. Same `validateWrite` from security.mjs, the other side of the
// line.
//
// -----------------------------------------------------------------------------
// THREE THINGS IT DOES, AND WHY EACH IS NOT OPTIONAL
//
//   1. FETCH BY DECLARED PATH, NEVER "everything you have". The coordinator
//      knows the ticket's allowedFiles because it assigned them. A file the
//      worker put in its result that the ticket did not declare is not written
//      and not looked at.
//
//   2. VERIFY EVERY HASH BEFORE WRITING ANYTHING. A file whose bytes do not
//      match its declared hash rejects the WHOLE result. A half-trusted mirror
//      is worse than none, because CI would then run on a mix of verified and
//      unverified bytes.
//
//   3. CLEAR THE TICKET'S DECLARED PATHS FIRST. Attempts of one ticket share
//      allowedFiles, so a fresh attempt normally overwrites everything the last
//      one wrote. But if attempt A1 produced declared file X and attempt A2's
//      model simply omits X, the stale A1 copy of X would sit in the workspace
//      and CI could pass on it. Content-hash idempotency cannot catch that —
//      there is no A2 write of X to compare against. So the declared paths are
//      removed before the accepted attempt is laid down.
// -----------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { validateWrite, ScopeViolation } from './security.mjs'
import { hashMatches } from './hash.mjs'

// Inline bytes in `task:result` are capped here. 1 MiB is comfortable for a
// batch of source files and 16x under the 16 MiB frame ceiling that
// NoiseSecretStream enforces (see qvac/channel.mjs). Anything larger travels
// over the worker's drive, fetched by declared path — the overflow route, not
// the common one.
export const INLINE_CEILING = 1024 * 1024

function normaliseRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

// Remove the ticket's declared files from the workspace. A path that is not
// there yet is not an error. Directories in allowedFiles (trailing slash) are
// left alone — clearing a whole subtree on every attempt is too blunt, and a
// directory grant is rare.
//
// `keep` is the set of paths this ticket INHERITED from a dependency (see
// `inheritedFiles` in split.mjs). Those are never cleared: clearing a path
// this ticket created is right — it stops a stale file from a superseded
// attempt lingering — but clearing one a dependency created would destroy
// that dependency's work the moment this ticket's model fails to reproduce
// it, turning "the edit did not happen" into "the original is gone".
export function clearDeclaredPaths(workspace, ticket, { keep = [] } = {}) {
  const keepSet = new Set(keep.map(normaliseRel))
  const cleared = []
  for (const decl of ticket.allowedFiles) {
    if (decl.endsWith('/')) continue
    if (keepSet.has(normaliseRel(decl))) continue
    let abs
    try {
      abs = validateWrite(workspace, decl, ticket.allowedFiles)
    } catch {
      continue // not a writable path for this ticket; nothing of ours to clear
    }
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true })
      cleared.push(normaliseRel(decl))
    }
  }
  return cleared
}

// Apply an accepted `task:result` to the workspace.
//
//   result        — a validated `task:result` object (see task-protocol.mjs)
//   fetchFromDrive — async (relPath) => Buffer, used only for files marked
//                    `drive: true`. Omit it and a drive-backed file is an error.
//
// Returns { ok, written, rejected, mismatched, cleared }. `ok` is false — and
// nothing is written — if any declared file fails its hash or a drive fetch
// throws. Out-of-scope files go to `rejected` and do not block the rest.
export async function applyResult(
  workspace,
  ticket,
  result,
  { fetchFromDrive = null, keepPaths = [] } = {}
) {
  const written = []
  const rejected = []
  const mismatched = []

  // Phase 1: resolve every file to verified bytes, WITHOUT touching disk. A
  // mismatch or a failed fetch here aborts before anything has changed.
  const staged = []
  for (const f of result.files || []) {
    const rel = normaliseRel(f.path)

    let abs
    try {
      abs = validateWrite(workspace, rel, ticket.allowedFiles)
    } catch (err) {
      if (err instanceof ScopeViolation) {
        rejected.push({ path: rel, reason: err.reason })
        continue
      }
      throw err
    }

    let bytes
    if (f.drive === true) {
      if (!fetchFromDrive) {
        return {
          ok: false,
          written: [],
          rejected,
          mismatched: [{ path: rel, reason: 'drive-backed file but no fetchFromDrive given' }],
          cleared: []
        }
      }
      try {
        bytes = await fetchFromDrive(rel)
      } catch (err) {
        return {
          ok: false,
          written: [],
          rejected,
          mismatched: [{ path: rel, reason: `drive fetch failed: ${(err && err.message) || err}` }],
          cleared: []
        }
      }
    } else {
      bytes = Buffer.from(String(f.content), 'utf8')
      if (bytes.byteLength > INLINE_CEILING) {
        mismatched.push({ path: rel, reason: `inline content over ${INLINE_CEILING} bytes` })
        continue
      }
    }

    if (!hashMatches(bytes, f.hash)) {
      mismatched.push({ path: rel, reason: 'hash does not match declared' })
      continue
    }

    staged.push({ abs, rel, bytes })
  }

  // A single bad hash rejects the whole result (rule 2). Nothing has been
  // written, so there is nothing to roll back.
  if (mismatched.length > 0) {
    return { ok: false, written: [], rejected, mismatched, cleared: [] }
  }

  // Phase 2: clear the declared paths, then lay down the verified bytes.
  const cleared = clearDeclaredPaths(workspace, ticket, { keep: keepPaths })

  for (const s of staged) {
    fs.mkdirSync(path.dirname(s.abs), { recursive: true })
    fs.writeFileSync(s.abs, s.bytes)
    written.push({ path: s.rel, bytes: s.bytes.byteLength })
  }

  return { ok: true, written, rejected, mismatched: [], cleared }
}
