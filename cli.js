#!/usr/bin/env node
//
// Launcher for the npm channel. NOT the project's entrypoint: that's
// bin.mjs, which runs under Bare, not under Node.
//
// It exists because `npm i -g pyrusllm` leaves an executable that starts
// with Node, and bin.mjs imports `bare-storage`, `bare-process`, `bare-os`
// and `bare-path` -Bare runtime modules that Node cannot resolve-. Publishing
// bin.mjs directly as "bin" would ship a package that blows up on the first
// import, which is worse than publishing nothing.
//
// The only thing this file does is find the Bare binary and hand it off to
// bin.mjs with the same arguments. All the logic still lives on the other
// side; nothing gets decided here.
//
// The binary is not downloaded at runtime: `bare-runtime` declares an
// optionalDependency per platform (bare-runtime-<platform>-<arch>) and npm
// only pulls the one that matches on install. That's why resolving it is
// enough.

const { spawn } = require('child_process')
const path = require('path')

let bare
try {
  // bare-runtime's public API: returns the path to this platform's binary,
  // or throws if there's no build for it.
  bare = require('bare-runtime')('bare')
} catch (err) {
  // The real case is win32-arm64, the same platform that also isn't
  // published via Pear because @qvac/llm-llamacpp has no prebuild there.
  // State the problem instead of leaving the stack trace of a require.
  console.error('[pyrusllm] no Bare binary for this platform:', err.message)
  console.error('[pyrusllm] alternative install over P2P:')
  console.error(
    '[pyrusllm]   pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny'
  )
  process.exit(1)
}

// stdio inherited so token streaming and `prompt -` (prompt via stdin, which
// on Windows is the only way to pass accented characters) keep working
// without this process getting in the middle.
const hijo = spawn(bare, [path.join(__dirname, 'bin.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit'
})

hijo.on('error', (err) => {
  console.error('[pyrusllm] could not run Bare:', err.message)
  process.exit(1)
})

// The exit code is propagated because `peers --expect` uses it as a gate in
// scripts: if the wrapper always exited 0, that check would stop being
// useful. If Bare died from a signal, it's reported as 128+n, the convention
// a shell expects.
hijo.on('exit', (code, signal) => {
  process.exit(signal ? 128 + (require('os').constants.signals[signal] || 0) : (code ?? 0))
})
