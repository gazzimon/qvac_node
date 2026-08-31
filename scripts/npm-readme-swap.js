#!/usr/bin/env node
'use strict'

// The GitHub README is the real docs: install, architecture, routing, the
// wallet, the x402 flow, the whole "what is real and what is not" section.
// None of that belongs on the npm page — npm always bundles README.md
// regardless of the "files" allowlist, so publishing it as-is would put the
// full technical doc where people expect three links and an install command.
//
// prepack swaps in scripts/npm-readme-source.md for the duration of `npm pack`/`npm
// publish`; postpack restores the real one. Never commit the swapped state:
// if this exits between the two (a failed publish), run `restore` by hand.

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const real = path.join(root, 'README.md')
const npmVersion = path.join(root, 'scripts', 'npm-readme-source.md')
const backup = path.join(root, '.README.full.md.bak')

const mode = process.argv[2]

if (mode === 'swap') {
  if (fs.existsSync(backup)) {
    console.error('npm-readme-swap: .README.full.md.bak already exists — a previous run did not restore. Run `node scripts/npm-readme-swap.js restore` first.')
    process.exit(1)
  }
  fs.renameSync(real, backup)
  fs.copyFileSync(npmVersion, real)
} else if (mode === 'restore') {
  if (!fs.existsSync(backup)) {
    console.error('npm-readme-swap: no backup to restore from — nothing to do.')
    process.exit(0)
  }
  fs.renameSync(backup, real)
} else {
  console.error('usage: node scripts/npm-readme-swap.js swap|restore')
  process.exit(1)
}
