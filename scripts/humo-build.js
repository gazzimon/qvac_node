#!/usr/bin/env node
'use strict'

// Resolves the module graph the same way the packer does, and BAILS if
// something doesn't resolve. Doesn't build the binary: that takes minutes and
// needs the platform toolchain. This takes seconds and catches 100% of the
// resolution errors, which is the one thing `npm test` structurally can't see.
//
// -----------------------------------------------------------------------------
// WHY IT EXISTS
//
// `npm test` runs under `bare` FROM SOURCE, with node_modules sitting right
// there. The standalone binary is a different environment: `bare-pack` walks
// the static graph and resolves under different conditions than the runtime
// does. An import that works at runtime may not resolve at pack time.
//
// That actually happened: `@noble/hashes` picked its `node:crypto` variant in
// the packer and the binary stopped compiling. It landed in Phase 7 and was
// discovered five phases later, because nobody built it in between. The only
// distribution channel the README declares was broken that whole time with
// the suite green.
//
//   node scripts/humo-build.js

const path = require('path')
const { pathToFileURL } = require('url')
const pack = require('bare-pack')
const traverse = require('bare-module-traverse')
const { readModule, listPrefix } = require('bare-pack/fs')

const root = path.resolve(__dirname, '..')
const entry = path.join(root, 'bin.mjs')

// The same hosts the release builds, so a platform-conditioned import that
// only fails on macOS doesn't slip by unnoticed on Windows.
const hosts = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

async function main() {
  const t = Date.now()
  try {
    const bundle = await pack(
      pathToFileURL(entry),
      // `linked: false` is what `--standalone` uses, which is how it ships.
      // With `true` the graph is smaller and the check would be worth less.
      { hosts, linked: false, resolve: traverse.resolve.bare },
      readModule,
      listPrefix
    )
    const n = Object.keys(bundle.files || {}).length
    console.log(`[humo] the graph resolves: ${n} modules, ${Date.now() - t}ms`)
  } catch (err) {
    console.error('[humo] THE BINARY IS NOT GOING TO COMPILE.')
    console.error('')
    console.error(`  ${(err && err.message) || err}`)
    if (err && err.referrer)
      console.error(`  imported from: ${err.referrer.href || err.referrer}`)
    console.error('')
    console.error('  `npm test` does NOT see this: the suite runs from source, where the')
    console.error('  runtime resolves differently than the packer. See scripts/humo-build.js')
    process.exit(1)
  }
}

main()
