// The "wake up at 2am and let the fleet work" wrapper. Runs the coordinator
// once, captures its output to a dated log, then reads the run log and decides
// whether a human needs to look — stalled, tickets blocked, over budget, or
// the coordinator crashed outright. Exits 0 if the night was healthy (made
// progress, or nothing left to do), non-zero if it wants attention.
//
//   node scripts/nightly-build.mjs \
//     --storage .qvac/myproject/coordinator \
//     [--pull] [--notify "<command>"] [--log-dir <dir>] \
//     -- --worker <hex,...> --requirement ./requirements.md --workspace ./build \
//        --storage .qvac/myproject/coordinator --budget 2000000 --max-attempts 4
//
// Everything after `--` is passed to orchestrator/coordinator.mjs untouched.
// `--storage` is needed BEFORE the `--` too, so the wrapper knows which
// runs.jsonl to inspect afterwards (pass the same value both places).
//
// cron (Linux/macOS), 02:00 daily:
//   0 2 * * * cd /path/to/qvac_node && node scripts/nightly-build.mjs --storage .qvac/app/coordinator --notify 'scripts/notify.sh' -- --worker <key> --requirement ./requirements.md --workspace ./build --storage .qvac/app/coordinator --budget 2000000 >> .qvac/nightly-logs/cron.log 2>&1
//
// systemd timer: an OnCalendar=*-*-* 02:00:00 timer whose service ExecStart is
// the same `node scripts/nightly-build.mjs ...` line, WorkingDirectory the
// repo root. Do not put --pull in an unattended unit unless you trust the
// remote — it runs whatever landed on the branch.

import fs from 'fs'
import path from 'path'
import { spawn, execSync } from 'child_process'
import { State } from '../orchestrator/state.mjs'

function parseWrapperArgv(argv) {
  const sep = argv.indexOf('--')
  const mine = sep === -1 ? argv : argv.slice(0, sep)
  const forwarded = sep === -1 ? [] : argv.slice(sep + 1)

  const opts = { pull: false, logDir: path.join('.qvac', 'nightly-logs') }
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] === '--pull') opts.pull = true
    else if (mine[i] === '--storage') opts.storage = mine[++i]
    else if (mine[i] === '--notify') opts.notify = mine[++i]
    else if (mine[i] === '--log-dir') opts.logDir = mine[++i]
  }
  return { opts, forwarded }
}

const { opts, forwarded } = parseWrapperArgv(process.argv.slice(2))
if (!opts.storage) {
  console.error('nightly-build: --storage <dir> is required (same value you pass the coordinator)')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(path.resolve(opts.logDir), { recursive: true })
const logPath = path.join(path.resolve(opts.logDir), `run-${stamp}.log`)
const logStream = fs.createWriteStream(logPath, { flags: 'a' })

function line(s) {
  const msg = `[nightly ${new Date().toISOString()}] ${s}`
  console.log(msg)
  logStream.write(msg + '\n')
}

line(`log: ${logPath}`)

if (opts.pull) {
  try {
    const out = execSync('git pull --ff-only', { encoding: 'utf8' })
    line(`git pull: ${out.trim().split('\n').pop()}`)
  } catch (err) {
    line(`git pull FAILED: ${(err && err.message) || err} — running the checkout as-is`)
  }
}

const started = Date.now()
const child = spawn(process.execPath, ['orchestrator/coordinator.mjs', ...forwarded], {
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (d) => {
  process.stdout.write(d)
  logStream.write(d)
})
child.stderr.on('data', (d) => {
  process.stderr.write(d)
  logStream.write(d)
})

const coordExit = await new Promise((resolve) => {
  child.on('exit', (code, signal) => resolve(signal ? `signal:${signal}` : code))
  child.on('error', (err) => resolve(`spawn-error:${err.message}`))
})

line(`coordinator exited ${coordExit} after ${Math.round((Date.now() - started) / 1000)}s`)

// Now read the run log the coordinator just wrote and turn it into a verdict.
let verdict = 'ok'
let detail = ''
try {
  const s = new State(path.join(path.resolve(opts.storage), 'runs.jsonl'))
  const runs = s.runSummaries()
  const last = runs[runs.length - 1] || {}
  const blocked = s.blocked()
  const stalled = s.isStalled()

  detail =
    `closed=${last.done || 0} blocked_total=${blocked.length} ` +
    `tokens_this_run=${last.tokens || 0} stalled=${stalled}`
  line(detail)

  if (typeof coordExit !== 'number') verdict = 'crashed'
  else if (coordExit === 3) verdict = 'over-budget'
  else if (blocked.length > 0) verdict = 'blocked'
  else if (stalled) verdict = 'stalled'
  else verdict = 'ok'

  if (blocked.length > 0) line(`blocked tickets: ${blocked.join(', ')}`)
} catch (err) {
  verdict = 'no-log'
  detail = `could not read ${opts.storage}/runs.jsonl: ${(err && err.message) || err}`
  line(detail)
}

line(`verdict: ${verdict}`)

if (verdict !== 'ok' && opts.notify) {
  try {
    // The notify command gets the verdict and one-line detail as args, plus
    // the log path — enough to send a message without parsing anything.
    execSync(`${opts.notify} ${JSON.stringify(verdict)} ${JSON.stringify(detail)} ${JSON.stringify(logPath)}`, {
      stdio: 'inherit'
    })
  } catch (err) {
    line(`notify command failed: ${(err && err.message) || err}`)
  }
}

logStream.end()
// 0 = healthy (progress or nothing to do). Non-zero = a human should look.
process.exitCode = verdict === 'ok' ? 0 : 1
