// Inspect what a coordinator run actually produced: per-ticket summary from
// the run log (attempts, who worked it, tokens spent, CI verdict, file
// hashes), and — the point of this tool — an independent RE-RUN of the CI
// gate against the workspace as it stands right now, using the exact same
// `runCI` the coordinator itself calls. Not a parallel verification path: the
// same one, run again by hand, so "did this really pass" never has to be
// taken on faith from a log line.
//
//   node scripts/inspect-run.mjs --storage .qvac/demo-cross/coordinator --workspace .qvac/demo-cross/workspace
//
// `--files` additionally prints each declared file's current content on disk
// next to the hash the run log recorded for it, so a stale or hand-edited
// file is visible, not just "present".

import fs from 'fs'
import path from 'path'
import { State, EVENTS } from '../orchestrator/state.mjs'
import { runCI } from '../orchestrator/ci.mjs'
import { hashContent } from '../orchestrator/hash.mjs'
import { parseRequirements } from '../orchestrator/split.mjs'

function parseArgv(argv) {
  const alias = { '--storage': 'storage', '--workspace': 'workspace', '--requirement': 'requirement' }
  const opts = { files: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--files') {
      opts.files = true
      continue
    }
    const key = alias[argv[i]]
    if (key) opts[key] = argv[++i]
  }
  return opts
}

const opts = parseArgv(process.argv.slice(2))
if (!opts.storage || !opts.workspace) {
  console.error('usage: node scripts/inspect-run.mjs --storage <dir> --workspace <dir> [--requirement <file>] [--files]')
  process.exit(1)
}

const logPath = path.join(path.resolve(opts.storage), 'runs.jsonl')
if (!fs.existsSync(logPath)) {
  console.error(`no run log at ${logPath} — this coordinator has not run yet`)
  process.exit(1)
}

const state = new State(logPath)
const workspace = path.resolve(opts.workspace)

// Per-ticket summary, built the same way State itself reasons about a
// ticket's status — the last relevant event wins.
const ticketIds = [...new Set(state.events.filter((e) => e.ticketId).map((e) => e.ticketId))]

console.log(`run log: ${logPath}`)
console.log(`runs so far: ${state.runSummaries().length}`)
console.log(`stalled: ${state.isStalled()}\n`)

for (const id of ticketIds) {
  const events = state.events.filter((e) => e.ticketId === id)
  const assigns = events.filter((e) => e.type === EVENTS.TICKET_ASSIGNED)
  const lastResult = [...events].reverse().find((e) => e.type === EVENTS.RESULT_RECEIVED)
  const status = state.ticketStates()[id] || 'never assigned'

  // RESULT_RECEIVED does not carry the worker key itself — TICKET_ASSIGNED
  // does, keyed by the same attemptId.
  const assignForResult = lastResult && assigns.find((a) => a.attemptId === lastResult.attemptId)

  console.log(`── ${id} ── ${status}`)
  console.log(`   attempts: ${assigns.length}`)
  if (lastResult) {
    console.log(`   last worker: ${(assignForResult?.worker || '(unknown)').slice(0, 16)}…`)
    console.log(`   last attempt: ${lastResult.attemptId}`)
    console.log(`   usage: ${JSON.stringify(lastResult.usage || {})}`)
    for (const f of lastResult.files || []) {
      console.log(`   file: ${f.path}  ${f.hash}  ${f.bytes}B`)
      if (opts.files) {
        const abs = path.join(workspace, f.path)
        if (!fs.existsSync(abs)) {
          console.log(`     ON DISK: MISSING`)
        } else {
          const onDisk = hashContent(fs.readFileSync(abs))
          console.log(`     ON DISK: ${onDisk}${onDisk === f.hash ? ' (matches)' : '  *** DIFFERS FROM THE LOGGED RESULT ***'}`)
        }
      }
    }
  }
  console.log('')
}

// The re-run. If --requirement is given, each ticket's real allowedFiles are
// used (closer to what the coordinator actually checks); otherwise this runs
// a single generic CI pass over the whole workspace, which is what most
// `npm test` setups care about anyway — one gate, not one per ticket.
console.log('── re-running CI against the workspace as it stands right now ──')
let ticket = { id: 'workspace', allowedFiles: [] }
if (opts.requirement && fs.existsSync(path.resolve(opts.requirement))) {
  const tickets = parseRequirements(fs.readFileSync(path.resolve(opts.requirement), 'utf8'))
  console.log(`(${tickets.length} ticket(s) declared in ${opts.requirement} — CI itself does not run per-ticket, one pass covers all of them)`)
}

const result = await runCI(workspace, ticket, { timeout: 30000 })
console.log(`status: ${result.status}`)
console.log(`duration: ${result.duration}ms`)
if (result.stdout) console.log(`stdout:\n${result.stdout}`)
if (result.stderr) console.log(`stderr:\n${result.stderr}`)
console.log(result.passed ? '\nPASS' : '\nFAIL')
process.exitCode = result.passed ? 0 : 1
