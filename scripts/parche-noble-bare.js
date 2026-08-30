#!/usr/bin/env node
'use strict'

// Adds a `bare` condition to `@noble/hashes`'s `./crypto` export.
//
// -----------------------------------------------------------------------------
// WHY IT'S NEEDED
//
// `bare-pack` — the one that builds the standalone binary — resolves the
// module graph with these conditions (bare-module-traverse/lib/resolve/bare.js):
//
//     ['bare', 'node', <platform>, <arch>]
//
// It includes `node` on purpose: almost the whole ecosystem publishes code
// compatible with Node, and Bare is mostly compatible with that too. But
// `@noble/hashes@1.x` uses that exact condition to pick the variant that does
// NOT work:
//
//     "./crypto": {
//       "node":   { "import": "./esm/cryptoNode.js" },   <- imports node:crypto
//       "import": "./esm/crypto.js"                      <- WebCrypto, this works
//     }
//
// and `node:crypto` doesn't exist under Bare. Result: the binary doesn't compile.
//
//     MODULE_NOT_FOUND: node:crypto
//       from @noble/hashes/esm/cryptoNode.js
//
// And it's not an x402 problem: the chain starts at `qvac/wallet.mjs`, which
// imports `@scure/bip39` -> `@noble/hashes/utils.js` -> `@noble/hashes/crypto`.
// It's been broken since Phase 7; it went unnoticed because `npm test` runs
// from source, where Bare's runtime resolves differently than the packer.
//
// -----------------------------------------------------------------------------
// WHY THIS WAY AND NOT ANOTHER
//
// `bare` is evaluated BEFORE `node`, so declaring it is enough. The patch is
// ONE key in an exports map: it doesn't touch a single line of cryptographic
// code.
//
// Everything else was tried and doesn't work:
//
//   - forcing `@noble/hashes@2.x` with overrides: 2.x doesn't have the
//     conditional export, but it dropped the extensionless subpaths and
//     breaks viem, ethers and curves with `PACKAGE_PATH_NOT_EXPORTED: './sha3'`;
//   - `bare-pack --imports` is the right lever, but `bare-build` calls
//     `pack()` with literal options and doesn't forward it (bare-build 1.0.4,
//     which is the latest);
//   - `--builtins` doesn't help: the packer's list has no `node:` entries at all.
//
// The real fix is upstream — either `bare-build` forwarding options to the
// packer, or `@noble/hashes` declaring the condition itself — and this gets
// removed the day that happens.
//
// -----------------------------------------------------------------------------
// FAILS LOUDLY
//
// If the exports map's shape changes, this script BAILS with exit 1 instead
// of patching blindly: a patch applied wrong on top of a crypto library is
// worse than one that doesn't apply at all. The build would break either way,
// but here the error says what happened.

const fs = require('fs')
const path = require('path')

const raiz = path.resolve(__dirname, '..', 'node_modules')

// All the copies: the tree has one per dependency that pins it differently
// (viem, ox, ethers, curves, bip32, wdk...), and the packer can end up
// reaching any of them. Patching only the one at the root leaves the build
// broken depending on how npm happened to arrange the tree that day.
function copias(dir, encontradas = []) {
  let entradas
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return encontradas
  }
  for (const e of entradas) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (e.name === 'hashes' && path.basename(dir) === '@noble') {
      encontradas.push(p)
      continue
    }
    if (
      e.name === 'node_modules' ||
      e.name.startsWith('@') ||
      fs.existsSync(path.join(p, 'node_modules'))
    ) {
      copias(p, encontradas)
    }
  }
  return encontradas
}

let parchadas = 0
let yaEstaban = 0
const problemas = []

for (const dir of copias(raiz)) {
  const archivo = path.join(dir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(archivo, 'utf8'))
  } catch (err) {
    problemas.push(`${archivo}: unreadable (${err.message})`)
    continue
  }

  const crypto = pkg.exports && pkg.exports['./crypto']
  // 2.x doesn't have this export and doesn't need anything. Not an error.
  if (!crypto || typeof crypto !== 'object') continue
  if (crypto.bare) {
    yaEstaban++
    continue
  }
  if (!crypto.node) continue

  // The branch that ISN'T node's is the one that works under Bare. It's taken
  // from the map itself instead of hardcoded here: if upstream renames the
  // file, this keeps pointing wherever it needs to point.
  const seguro = {}
  if (typeof crypto.import === 'string') seguro.import = crypto.import
  if (typeof crypto.default === 'string') seguro.default = crypto.default

  if (!seguro.import && !seguro.default) {
    problemas.push(
      `${dir}: the "./crypto" export has no branch without a \`node\` condition to pull the file from. ` +
        `Shape found: ${JSON.stringify(crypto)}`
    )
    continue
  }

  // `bare` FIRST: the object's order is the order conditions get evaluated
  // in, and the whole point is beating `node`.
  pkg.exports['./crypto'] = { bare: seguro, ...crypto }
  fs.writeFileSync(archivo, JSON.stringify(pkg, null, 2) + '\n')
  parchadas++
}

if (problemas.length) {
  console.error('[parche-noble] the package.json shape changed and this will not patch blindly:')
  for (const p of problemas) console.error('  ' + p)
  console.error('[parche-noble] see scripts/parche-noble-bare.js')
  process.exit(1)
}

if (parchadas > 0) {
  console.log(`[parche-noble] \`bare\` condition added to ${parchadas} copy/copies of @noble/hashes`)
} else if (yaEstaban > 0) {
  console.log(`[parche-noble] ${yaEstaban} copy/copies already patched`)
}
