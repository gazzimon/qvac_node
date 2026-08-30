#!/usr/bin/env node
'use strict'

// Smoke test for the artifact that gets published: does this binary serve a token?
//
// Exists because of a concrete incident. The `linux-x64` binary got published
// release after release without being able to load ANY model: the standalone
// packaging only registers the Vulkan backend and never enumerates the CPU
// variants, so `--gpu-layers 0` -the recommended setting on iGPU- always
// fails. See NOTES.md, "Nodo Linux 24/7".
//
// It went undiscovered for months because `release.js` compiles all five
// targets, stages them, and publishes them WITHOUT RUNNING ANY OF THEM.
// Compiling isn't working. This script closes that hole: if the binary
// doesn't produce a token, the release stops.
//
//   node scripts/smoke.js                     the host's binary, in ./out
//   node scripts/smoke.js --bin <path>        another binary (e.g. the installed one)
//   node scripts/smoke.js --bin <bare> --entry bin.mjs    the dev path
//   node scripts/smoke.js --gpu-layers 0      passing flags to the CLI
//   node scripts/smoke.js --timeout 900       more headroom on a cold start
//
// HONEST LIMIT: it can only test binaries that run on THIS machine. The
// other four targets are cross-compiled and don't run here. Covering them
// requires a CI matrix (ubuntu/macos/windows) where each system runs its
// own, or running this by hand on each machine before publishing.

const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const root = path.resolve(__dirname, '..')
const isWindows = os.platform() === 'win32'

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i === -1 ? def : argv[i + 1]
}

const hostTarget = `${os.platform()}-${os.arch()}`
const defaultBin = path.join(root, 'out', hostTarget, isWindows ? 'pyrusllm.exe' : 'pyrusllm')
const bin = path.resolve(flag('--bin', defaultBin))

// Generous on purpose: cold start is 808 MB of weights over hypercore.
// What's being hunted for is "doesn't serve a token," not "took a while."
const timeoutMs = Number(flag('--timeout', 600)) * 1000
const gpuLayers = flag('--gpu-layers', null)
const prompt = flag('--prompt', 'ping')

function fallar(porque, detalle) {
  console.error(`\n  SMOKE FAIL — ${porque}`)
  if (detalle) console.error('\n' + detalle.trimEnd() + '\n')
  process.exit(1)
}

if (!fs.existsSync(bin)) {
  fallar(`binary does not exist: ${bin}`, 'Build it with `npm run make` or pass --bin <path>.')
}

// The binary CANNOT write to a libuv pipe: it hangs forever. Documented in
// NOTES.md, "BUG: the binary hangs if stdout is a pipe". That's why output
// goes to a file and gets read at the end, same as in soak.js.
const salida = path.join(os.tmpdir(), `pyrusllm-smoke-${process.pid}.log`)
const fd = fs.openSync(salida, 'w+')

// NO --quiet, on purpose. The verdict comes from the TTFT line bin.mjs
// prints, and `--quiet` silences it (bin.mjs:211). Also llama.cpp's native
// logging can't be turned off (NOTES.md), so "there was output" proves
// nothing: this script's first version gave OK on pure log noise.
// `--entry` covers the dev path: `bare bin.mjs prompt ...`. It's not a
// luxury, it's the Linux node's PRODUCTION configuration, which runs from
// source because the standalone doesn't load models. Without this the smoke
// test would only know how to test the broken artifact and not the one that
// actually serves tokens.
const entry = flag('--entry', null)
const args = entry ? [entry, 'prompt', prompt] : ['prompt', prompt]
if (gpuLayers !== null) args.push('--gpu-layers', String(gpuLayers))

console.log(`\n  smoke: ${bin}`)
console.log(`  args : ${args.join(' ')}`)
console.log(`  timeout: ${timeoutMs / 1000}s\n`)

const arranque = Date.now()
const child = spawn(bin, args, { cwd: root, stdio: ['ignore', fd, fd] })

let matado = false
const reloj = setTimeout(() => {
  matado = true
  child.kill('SIGKILL')
}, timeoutMs)

child.on('error', (err) => {
  clearTimeout(reloj)
  fs.closeSync(fd)
  fallar(`could not run the binary: ${err.message}`)
})

child.on('exit', (code) => {
  clearTimeout(reloj)
  const wallMs = Date.now() - arranque
  fs.closeSync(fd)

  const texto = fs.readFileSync(salida, 'utf8')
  fs.unlinkSync(salida)

  if (matado) {
    fallar(`hung: did not finish in ${timeoutMs / 1000}s, had to be killed`, texto)
  }

  // Concrete causes go BEFORE the exit code, not after: an "exit code 1" as
  // the headline hides the reason the log itself already has written down.
  // The exit code is the last resort, for what we couldn't classify.

  // Another live node has the registry lock held. This is NOT a failure of
  // the artifact and can't be reported as one: there's only one process per
  // storage directory, so the smoke test requires the node to be down.
  if (/could not be locked/i.test(texto)) {
    fallar(
      'another node is running: the registry is locked',
      'Stop it before running the smoke test (`systemctl stop pyrusllm`, or\n' +
        'Ctrl+C in the `serve` terminal) and try again. This does NOT say\n' +
        'anything about whether the binary works.'
    )
  }

  // An exit 0 isn't enough. The CLI can end cleanly after printing the load
  // error: that's exactly what the linux-x64 binary used to do.
  if (/fallo la inferencia|failed to load model|Failed to initialize model/i.test(texto)) {
    fallar('the binary started but could NOT load the model', texto)
  }

  if (code !== 0) {
    const como = code === null ? 'died with no exit code (signal)' : `exit code ${code}`
    fallar(`${como}, no recognized cause in the log`, texto)
  }

  // The verdict. `bin.mjs:293` prints the measured TTFT, or the literal
  // `n/a` when the stream ended with not a single delta. A model that loads
  // but emits nothing has to be a FAIL just like one that doesn't load.
  const ttft = texto.match(/first token \(TTFT\)\s*:\s*(\S+)/)
  if (!ttft) {
    fallar(
      'the binary exited 0 but never got to measure the first token',
      texto
    )
  }
  if (ttft[1] === 'n/a') {
    fallar('the model loaded but did NOT emit a single token (TTFT n/a)', texto)
  }

  console.log(`  TTFT: ${ttft[1]}`)
  console.log(`\n  SMOKE OK — token served in ${(wallMs / 1000).toFixed(1)}s\n`)
})
