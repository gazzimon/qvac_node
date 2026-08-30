// Is the batch well-formed and well-signed? Entirely READ-ONLY, no network.
//
//   bare scripts/verificar-lote.mjs <lote.json>
//   cat lote.json | bare scripts/verificar-lote.mjs
//
// -----------------------------------------------------------------------------
// WHY IT EXISTS, AND WHY UNDER BARE
//
// Phase 10 defers settlement: receipts accumulate and get settled in a
// batch. Before sending a batch off to settle —which DOES move money— it
// has to be possible to answer, offline, three questions that break
// independently:
//
//   1. the batch's signature belongs to the wallet it claims, over THIS
//      exact content (JCS);
//   2. every receipt goes to the same network and the same wallet —a batch
//      settles against a single facilitator—;
//   3. every EIP-3009 authorization recovers to whoever claims to be
//      paying, against the EIP-712 domain the receipt stores.
//
// Runs under `bare` —not `node` like `verificar-x402.js`— precisely so it
// can import `qvac/lote.mjs` and use the SAME `verificarLote` the gateway
// uses, instead of reimplementing canonicalization and risking it drifting
// apart. `verificar-x402.js` is node because it does RPC against real
// chains; this is only local crypto.

import process from 'bare-process'
import * as lote from '../qvac/lote.mjs'

async function leerEntrada() {
  const arg = Bare.argv[2] // `bare <script> <arg>`
  if (arg) {
    const fs = await import('bare-fs')
    return fs.default.readFileSync(arg, 'utf8')
  }
  return new Promise((resolve, reject) => {
    let d = ''
    process.stdin.on('data', (c) => (d += c))
    process.stdin.on('end', () => resolve(d))
    process.stdin.on('error', reject)
    process.stdin.resume()
  })
}

async function main() {
  const crudo = await leerEntrada()
  let l
  try {
    l = JSON.parse(crudo)
  } catch (err) {
    console.error(`  ✗ input is not JSON: ${(err && err.message) || err}`)
    process.exit(2)
  }

  console.log('')
  console.log('  x402 batch — can it be settled?   (read-only, moves no funds)')
  console.log('  ' + '-'.repeat(70))
  console.log('')
  console.log(`  id        ${safe(() => lote.idDeLote({ ...l, signature: undefined }))}`)
  console.log(`  network   ${l.network}  (${l.red || 'no short name'})`)
  console.log(`  payTo     ${l.payTo}`)
  console.log(`  receipts  ${l.count}`)
  console.log(`  total     ${l.totalAmount} (minimum units of the asset)`)
  console.log('')

  const r = await lote.verificarLote(l)

  if (r.firmante) console.log(`  signer    ${r.firmante}`)
  for (const mal of r.recibosMal || []) {
    console.log(`  ✗ receipt ${mal.nonce.slice(0, 14)}… : ${mal.reason}`)
  }

  console.log('')
  console.log('  ' + '-'.repeat(70))
  if (r.ok) {
    console.log('  RESULT: the batch is well-formed and well-signed. It can be settled.')
    process.exit(0)
  }
  console.log(`  RESULT: it CANNOT be settled — ${r.reason}`)
  process.exit(1)
}

function safe(fn) {
  try {
    return fn()
  } catch {
    return '(not computable)'
  }
}

main().catch((err) => {
  console.error('[verificar-lote] ' + ((err && err.stack) || err))
  process.exit(2)
})
