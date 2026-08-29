// Runs the full orchestrator against a REAL gateway: two tickets, two workers
// in parallel, the CI gate deciding, and a second pass that redoes nothing.
//
//   node scripts/demo-orchestrator.mjs --gateway http://localhost:8787 --model qwen4b
//
// -----------------------------------------------------------------------------
// THE CI IS OWNED BY THE REQUIREMENTS AUTHOR, NOT WRITTEN BY THE MODEL
//
// The workspace is seeded with `verify.mjs` BEFORE any worker runs, and no
// ticket is allowed to touch it. That is deliberate and it is the whole point
// of the gate: if the tests that judge the work were produced by the same model
// doing the work, a green run would prove nothing — the cheapest way to pass is
// to write a test that always passes.
//
// So the tickets get to write `src/`, and the thing that decides whether they
// succeeded lives outside their allowlist. `detectOverlap` cannot protect this
// on its own: it only stops two TICKETS from clashing, and `verify.mjs` belongs
// to no ticket.
// -----------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { Orchestrator } from '../orchestrator/index.mjs'

const REQUIREMENTS = `# Demo — two small modules

## Ticket: sum
Write a module that exports a function named \`sum\` taking two numbers and
returning their sum.

Depends on: none
Files: src/sum.js

## Ticket: mul
Write a module that exports a function named \`mul\` taking two numbers and
returning their product.

Depends on: none
Files: src/mul.js
`

// Written with string concatenation and no template literals: this is a
// template literal itself, and nesting them means escaping every backtick and
// every `${`, which is exactly the kind of thing that ships broken because the
// error only appears at the far end, inside a generated file nobody read.
//
// Imported dynamically so a missing file fails as a clear assertion rather than
// as a module-resolution error before the checks even start.
export const VERIFY = [
  "import assert from 'assert'",
  "import fs from 'fs'",
  '',
  'const expected = [',
  "  ['src/sum.js', 'sum', [[2, 3, 5], [-1, 1, 0]]],",
  "  ['src/mul.js', 'mul', [[2, 3, 6], [-2, 5, -10]]]",
  ']',
  '',
  'for (const [file, name, cases] of expected) {',
  "  assert.ok(fs.existsSync(file), 'missing ' + file)",
  "  const mod = await import('./' + file)",
  "  assert.equal(typeof mod[name], 'function', file + ' does not export ' + name + '()')",
  '  for (const [a, b, want] of cases) {',
  "    assert.equal(mod[name](a, b), want, name + '(' + a + ', ' + b + ') should be ' + want)",
  '  }',
  '}',
  '',
  "console.log('ok - both modules behave')",
  ''
].join('\n')

function parseArgv(argv) {
  const alias = {
    '--gateway': 'gateway',
    '--api-key': 'apiKey',
    '--model': 'model',
    '--workspace': 'workspace',
    '--storage': 'storage',
    '--workers': 'workers',
    '--tool-timeout': 'toolTimeout'
  }
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const key = alias[argv[i]]
    if (key) opts[key] = argv[++i]
  }
  return opts
}

async function fetchPanelKey(gateway) {
  const res = await fetch(`${gateway}/v1/keys/panel`)
  if (!res.ok) throw new Error(`could not get an API key: ${res.status}`)
  return (await res.json()).key
}

async function main() {
  const opts = parseArgv(process.argv.slice(2))
  const gateway = opts.gateway || 'http://localhost:8787'
  const workspace = path.resolve(opts.workspace || './demo-build')
  const storage = path.resolve(opts.storage || './.qvac/demo-orchestrator')

  // A fresh start every run: leftovers from a previous attempt would let a
  // ticket "pass" on work it did not do.
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(storage, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })

  const requirementFile = path.join(storage, 'requirements.md')
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(requirementFile, REQUIREMENTS)

  // The gate, seeded before anyone can write to the workspace.
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'demo-build', type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2)
  )
  fs.writeFileSync(path.join(workspace, 'verify.mjs'), VERIFY)

  const apiKey = opts.apiKey || (await fetchPanelKey(gateway))

  console.log(`gateway:   ${gateway}`)
  console.log(`model:     ${opts.model || '(from the catalogue)'}`)
  console.log(`workspace: ${workspace}`)
  console.log(`the CI gate (verify.mjs) is seeded and belongs to no ticket\n`)

  const config = {
    gateway,
    apiKey,
    model: opts.model,
    requirement: requirementFile,
    workspace,
    storage,
    workers: opts.workers || 2,
    toolTimeout: opts.toolTimeout || 600
  }

  console.log('=== first run ===')
  const r1 = await new Orchestrator(config).start()

  console.log('\n=== second run (should redo nothing) ===')
  const r2 = await new Orchestrator(config).start()

  console.log('\n--- what is on disk ---')
  for (const f of ['src/sum.js', 'src/mul.js']) {
    const p = path.join(workspace, f)
    if (fs.existsSync(p)) {
      console.log(`\n${f}:`)
      console.log(fs.readFileSync(p, 'utf8').trimEnd())
    } else {
      console.log(`\n${f}: MISSING`)
    }
  }

  console.log('\n--- verdict ---')
  console.log(`first run:  ${r1.done}/${r1.total} closed`)
  console.log(`second run: ${r2.done}/${r2.total} closed, redid ${r2.done - r1.done}`)
  console.log(`worker drives: ${Object.keys(r1.drives).length}`)

  const ok = r1.done === r1.total && r2.done === r1.done
  console.log(ok ? '\nOK — everything closed, and the second run redid nothing.' : '\nNot there yet.')
  process.exitCode = ok ? 0 : 1
}

// Guarded so the gate can be imported by its test without launching a demo run.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
