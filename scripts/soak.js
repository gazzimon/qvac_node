#!/usr/bin/env node
'use strict'

// End-to-end robustness soak test for QVAC-Node.
//
// Runs the real cycle N times in a row and reports the distribution, not
// the best case. Exists because the three failure modes that ruin a demo
// don't show up in a single run:
//
//   1. The process doesn't exit. `unloadModel` deliberately leaves the
//      swarm, the registry client, and the corestore up; if `close()`
//      doesn't close everything every single time, the CLI answers and
//      then hangs with the cursor blinking.
//   2. The registry times out. Resolving the model hits QVAC's swarm: with
//      bad wifi that fails now and then, not always.
//   3. The P2P install hangs at 0 B/s. Documented in NOTES.md: the room's
//      client-to-client link degraded until it disappeared.
//
//   node scripts/soak.js                       5 prompts against the local binary
//   node scripts/soak.js --runs 10             more rounds
//   node scripts/soak.js --gpu-layers 0        passing flags to the CLI
//   node scripts/soak.js --install --runs 3    includes `pear install` from the link
//   node scripts/soak.js --bin <path>          against another binary (e.g. the installed one)
//
// A FAIL isn't opinion: it's a nonzero exit code, output with no response,
// or a process that had to be killed on timeout.

const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const isWindows = os.platform() === 'win32'

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i === -1 ? def : argv[i + 1]
}
const has = (name) => argv.includes(name)

const runs = Number(flag('--runs', 5))
const doInstall = has('--install')
// Timeout per run. Generous on purpose: on a cold start the model is 807 MB
// over hypercore. What's being hunted for is the infinite hang, not slowness.
const timeoutMs = Number(flag('--timeout', 600)) * 1000
const gpuLayers = flag('--gpu-layers', null)
// NOTE: kept in Spanish on purpose — this is the same benchmark prompt used
// verbatim in docs/NOTES.md and scripts/verify-node2.sh/.ps1 (see the note
// in qvac/infer.mjs); translating it here alone would break that
// consistency.
const prompt = flag('--prompt', 'Explica en dos frases que es una red peer-to-peer.')

const hostTarget = `${os.platform()}-${os.arch()}`
const defaultBin = path.join(root, 'out', hostTarget, isWindows ? 'qvac-node.exe' : 'qvac-node')
const bin = flag('--bin', defaultBin)

if (!fs.existsSync(bin)) {
  console.error(`Binary does not exist: ${bin}`)
  console.error('Build it with `npm run make`, or pass --bin <path>.')
  process.exit(1)
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`
}

// --- one CLI run -------------------------------------------------------------

// The child's output goes to a FILE, not a pipe, and that isn't a style
// detail: with `stdio: 'pipe'` the binary hangs forever.
//
// Measured: the CLI loads the model, prints the banner and the prompt, and
// then doesn't emit a single token. Never. Depends on what stdout is
// connected to:
//
//   console (inherit)        -> OK, ~12s
//   file (fd)                -> OK, ~16s
//   libuv pipe (spawn)       -> HUNG, forever
//   shell pipe (bash, PS)    -> OK
//
// libuv uses named pipes for children's stdio on Windows, and that's where
// it gets stuck; a shell's anonymous pipes work fine. Details in NOTES.md.
// If someone "cleans this up" back to 'pipe', the soak test comes back 100%
// hangs.
function runPrompt(n) {
  return new Promise((resolve) => {
    const args = ['prompt', prompt]
    if (gpuLayers !== null) args.push('--gpu-layers', gpuLayers)

    const outPath = path.join(os.tmpdir(), `qvac-soak-out-${process.pid}-${n}.txt`)
    const fd = fs.openSync(outPath, 'w')

    const t0 = Date.now()
    const child = spawn(bin, args, { cwd: root, stdio: ['ignore', fd, fd] })

    let killed = false
    const readOut = () => {
      try {
        return fs.readFileSync(outPath, 'utf8')
      } catch {
        return ''
      }
    }
    const cleanup = () => {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
      fs.rmSync(outPath, { force: true })
    }

    // The timeout is the soak's heart: without this a hang shows up as a
    // "slow" run and failure mode number 1 goes unnoticed.
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (e) => {
      clearTimeout(timer)
      cleanup()
      resolve({ ok: false, why: `could not launch: ${e.message}`, wallMs: Date.now() - t0 })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const wallMs = Date.now() - t0
      const out = readOut()
      cleanup()

      if (killed) {
        return resolve({
          ok: false,
          why: `HUNG: did not finish in ${timeoutMs / 1000}s, had to be killed`,
          wallMs
        })
      }
      if (code !== 0) {
        const last = out.trim().split('\n').slice(-1)[0] || ''
        return resolve({ ok: false, why: `exit ${code}: ${last}`, wallMs })
      }

      const ttft = /first token \(TTFT\)\s*:\s*([\d.]+)s/.exec(out)
      const load = /model load\s*:\s*([\d.]+)s/.exec(out)
      const total = /full answer\s*:\s*([\d.]+)s/.exec(out)

      // An exit 0 isn't enough: the CLI could have exited without emitting a
      // single token.
      if (!ttft) {
        return resolve({ ok: false, why: 'exit 0 but no first token', wallMs })
      }

      const answer = answerOf(out)
      if (answer.length < 20) {
        return resolve({
          ok: false,
          why: `suspiciously short answer (${answer.length} chars)`,
          wallMs
        })
      }

      resolve({
        ok: true,
        wallMs,
        loadS: load ? Number(load[1]) : null,
        ttftS: Number(ttft[1]),
        totalS: total ? Number(total[1]) : null,
        chars: answer.length
      })
    })
  })
}

// The answer's text sits between the `> <prompt>` line and the measurements
// block. Extracted so it can be asserted there genuinely was an answer.
function answerOf(out) {
  const lines = out.split('\n')
  const start = lines.findIndex((l) => l.startsWith('> '))
  const end = lines.findIndex((l) => /model load\s*:/.test(l))
  if (start === -1 || end === -1 || end <= start) return ''
  return lines
    .slice(start + 1, end)
    .join(' ')
    .trim()
}

// --- one `pear install` run ---------------------------------------------------

function runInstall(n) {
  const target = path.join(os.tmpdir(), `qvac-soak-${process.pid}-${n}`)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true }) // `pear install --to` gives ENOENT if it doesn't exist

  const t0 = Date.now()
  // With `shell: true` a SINGLE assembled command has to be passed, not
  // command + args: Node >=22 warns with DEP0190 because with shell the
  // args don't get escaped.
  const res = isWindows
    ? spawnSync(`pear install --to "${target}" ${pkg.upgrade}`, {
        cwd: root,
        encoding: 'utf8',
        shell: true,
        timeout: timeoutMs
      })
    : spawnSync('pear', ['install', '--to', target, pkg.upgrade], {
        cwd: root,
        encoding: 'utf8',
        timeout: timeoutMs
      })
  const wallMs = Date.now() - t0
  const installed = path.join(target, isWindows ? 'qvac-node.exe' : 'qvac-node')

  // Neither the exit code nor the file existing is enough: measured on
  // macOS, `pear install` prints "Network Timeout 30s" and "Failed", exits
  // with code 0, and leaves a TRUNCATED but executable binary on disk. The
  // only proof the install actually works is that the binary starts.
  const out = `${res.stdout || ''}${res.stderr || ''}`
  let result
  if (res.error && res.error.code === 'ETIMEDOUT') {
    result = { ok: false, why: `HUNG: the install did not finish in ${timeoutMs / 1000}s`, wallMs }
  } else if (res.status !== 0) {
    result = { ok: false, why: `pear install exit ${res.status}`, wallMs }
  } else if (/network timeout|failed/i.test(out)) {
    result = { ok: false, why: `the install reported failure: ${firstBadLine(out)}`, wallMs }
  } else if (!fs.existsSync(installed)) {
    result = { ok: false, why: 'the install said OK but the binary did not end up on disk', wallMs }
  } else {
    const mb = fs.statSync(installed).size / 1e6
    const ver = spawnSync(installed, ['--version'], { encoding: 'utf8', timeout: 60000 })
    if (!/v\d+\.\d+\.\d+/.test(`${ver.stdout || ''}`)) {
      result = {
        ok: false,
        why: `the binary ended up on disk (${mb.toFixed(1)} MB) but does NOT run: incomplete install`,
        wallMs
      }
    } else {
      result = { ok: true, wallMs, mb }
    }
  }

  fs.rmSync(target, { recursive: true, force: true })
  return result
}

function firstBadLine(out) {
  const line = out.split(/\r?\n/).find((l) => /network timeout|failed/i.test(l))
  return (line || '').trim().slice(0, 80)
}

// --- report --------------------------------------------------------------------

function stats(values) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return { min: s[0], med: p(0.5), max: s[s.length - 1] }
}

function fmt(st, unit = 's') {
  if (!st) return 'n/a'
  const r = (v) => v.toFixed(2)
  return `min ${r(st.min)}${unit}  median ${r(st.med)}${unit}  max ${r(st.max)}${unit}`
}

async function main() {
  console.log('')
  console.log(C.cyan(`== soak qvac-node v${pkg.version}`))
  console.log(`   binary    : ${bin}`)
  console.log(`   runs      : ${runs}`)
  console.log(`   timeout   : ${timeoutMs / 1000}s per run`)
  if (gpuLayers !== null) console.log(`   gpu-layers: ${gpuLayers}`)
  if (doInstall) console.log(`   install   : YES (${pkg.upgrade})`)
  console.log('')

  const promptResults = []
  const installResults = []

  for (let i = 1; i <= runs; i++) {
    if (doInstall) {
      process.stdout.write(C.dim(`  [${i}/${runs}] pear install ... `))
      const r = runInstall(i)
      installResults.push(r)
      console.log(
        r.ok
          ? C.green(`OK ${(r.wallMs / 1000).toFixed(1)}s  ${r.mb.toFixed(1)} MB`)
          : C.red(`FAIL ${r.why}`)
      )
    }

    process.stdout.write(C.dim(`  [${i}/${runs}] prompt ......... `))
    const r = await runPrompt(i)
    promptResults.push(r)
    console.log(
      r.ok
        ? C.green(
            `OK  TTFT ${r.ttftS.toFixed(2)}s  total ${r.totalS?.toFixed(1)}s  ${r.chars} chars`
          )
        : C.red(`FAIL ${r.why}`)
    )
  }

  const okPrompts = promptResults.filter((r) => r.ok)
  const okInstalls = installResults.filter((r) => r.ok)

  console.log('')
  console.log(C.cyan('== result'))

  if (doInstall) {
    console.log(`   install : ${okInstalls.length}/${installResults.length} OK`)
    console.log(`             ${fmt(stats(okInstalls.map((r) => r.wallMs / 1000)))}`)
  }

  console.log(`   prompt  : ${okPrompts.length}/${promptResults.length} OK`)
  console.log(`     load  : ${fmt(stats(okPrompts.map((r) => r.loadS).filter(Number.isFinite)))}`)
  console.log(`     TTFT  : ${fmt(stats(okPrompts.map((r) => r.ttftS)))}`)
  console.log(`     total : ${fmt(stats(okPrompts.map((r) => r.totalS).filter(Number.isFinite)))}`)

  const fails = [...promptResults, ...installResults].filter((r) => !r.ok)
  if (fails.length > 0) {
    console.log('')
    console.log(C.red(`   ${fails.length} failure(s):`))
    for (const f of fails) console.log(C.red(`     - ${f.why}`))
  }

  // Spread matters as much as the median: a TTFT that ranges from 0.6s to
  // 6s is a demo that sometimes looks bad, even if the median is good.
  const t = stats(okPrompts.map((r) => r.ttftS))
  if (t && t.max > t.med * 3 && okPrompts.length > 2) {
    console.log('')
    console.log(
      C.yellow(
        `   HEADS UP: max TTFT (${t.max.toFixed(2)}s) is 3x the median (${t.med.toFixed(2)}s).`
      )
    )
    console.log(C.yellow('   There is variance that can show up live. Run more rounds.'))
  }

  console.log('')
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
