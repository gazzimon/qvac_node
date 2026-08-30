#!/usr/bin/env node
'use strict'

// QVAC-Node's release pipeline, in one command.
//
// Exists because live OTA is part of the pitch: during the demo a new
// version has to get published and the judges need to see the copy they
// already have installed update itself. Chaining make -> build -> stage by
// hand on stage is a cheap way to break the demo.
//
//   node scripts/release.js            every platform
//   node scripts/release.js --host     only the local platform (fast, for iterating)

const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))

// win32-arm64 got dropped when inference was added: @qvac/llm-llamacpp
// publishes no prebuild for that platform and `bare-build` has nothing to
// link the addon against. It used to be published through Phase 0; the
// first full `release` after this change purges it from the hypercore. See
// NOTES.md.
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

const hostOnly = process.argv.includes('--host')
const host = `${os.platform()}-${os.arch()}`
const targets = hostOnly ? [host] : TARGETS

// The smoke test runs the host's binary before publishing. It can be
// skipped, but that has to be an explicit decision: the default is that a
// broken artifact doesn't reach the hypercore. See step 1-bis and
// scripts/smoke.js.
const skipSmoke = process.argv.includes('--skip-smoke')

if (hostOnly && !TARGETS.includes(host)) {
  console.error(`Unsupported platform: ${host}`)
  process.exit(1)
}

const link = pkg.upgrade
if (!link || link.includes('YOUR_KEY')) {
  console.error('package.json: the "upgrade" field still has the placeholder.')
  console.error('Run `pear touch` and paste the resulting link there.')
  console.error('Without this the installed app starts up with INVALID_URL.')
  process.exit(1)
}

const isWindows = os.platform() === 'win32'
const run = (cmd, args) => {
  const res = spawnSync(isWindows ? `${cmd} ${args.join(' ')}` : cmd, isWindows ? [] : args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows
  })
  if (res.error) {
    console.error(res.error.message)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status || 1)
}

console.log(`\n== qvac-node v${pkg.version} -> ${link}\n`)

// 1. standalone binaries (bare-build cross-compiles all 6 targets from any host)
for (const t of targets) {
  console.log(`-- build ${t}`)
  run(isWindows ? 'npm.cmd' : 'npm', ['run', `make:${t}`])
}

// 1-bis. The host's binary has to serve a token BEFORE it gets published.
//
// Compiling isn't working: `linux-x64` got published release after release
// unable to load a model, and nobody noticed because this script never ran
// what it was uploading. See NOTES.md, "Nodo Linux 24/7".
//
// WHAT THIS GATE DOESN'T COVER, and it has to be said: it only tests the
// host's target. The other four are cross-compiled and don't run here.
// Covering them needs a CI matrix, or running `npm run smoke -- --bin <path>`
// by hand on each platform before publishing.
if (skipSmoke) {
  console.log('\n!! smoke SKIPPED via --skip-smoke: publishing without verifying the binary.')
} else if (!targets.includes(host)) {
  console.log(`\n!! the host (${host}) is not among the targets: no binary to test here.`)
} else {
  console.log(`\n-- smoke ${host}`)
  const bin = path.join(root, 'out', host, isWindows ? 'pyrusllm.exe' : 'pyrusllm')
  run('node', ['scripts/smoke.js', '--bin', bin, '--gpu-layers', '0'])
}

// 2. deployment folder: pear install looks for /by-arch/<platform>/app/<bin>
const buildArgs = ['build', '--package', './package.json', '--target', './build']
for (const t of targets) {
  const bin = t.startsWith('win32') ? 'pyrusllm.exe' : 'pyrusllm'
  buildArgs.push(`--${t}-app`, `./out/${t}/${bin}`)
}
console.log('\n-- pear build')
run('pear', buildArgs)

// 3. stage.
// --purge only on a full release: erases from the hypercores whatever no
// longer belongs, so old material doesn't stay replicating forever. In
// --host mode ONLY one platform gets staged, and purging there would erase
// the other five's binaries from the hypercore: a judge on macOS would get
// "Not found" instead of the app. Host mode is for iterating; the full one
// is what cleans up.
console.log('\n-- pear stage')
const stageArgs = ['stage']
if (!hostOnly) stageArgs.push('--purge')
stageArgs.push(link, './build')
run('pear', stageArgs)

if (hostOnly) {
  console.log(`\n!! --host mode: only ${host} got published.`)
  console.log('!! Before the demo run `npm run release` (all 6 platforms).')
}

console.log(`\n== done. Seed it with:  pear seed ${link}\n`)
