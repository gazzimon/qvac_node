// ¿El lote está bien armado y bien firmado? Todo de SOLO LECTURA, sin red.
//
//   bare scripts/verificar-lote.mjs <lote.json>
//   cat lote.json | bare scripts/verificar-lote.mjs
//
// -----------------------------------------------------------------------------
// POR QUE EXISTE, Y POR QUE BAJO BARE
//
// La Fase 10 difiere el settlement: los recibos se acumulan y se liquidan en
// lote. Antes de mandar un lote a liquidar —que SÍ mueve plata— hay que poder
// contestar, offline, tres preguntas que se rompen por separado:
//
//   1. la firma del lote es de la wallet que dice, sobre ESTE contenido (JCS);
//   2. todos los recibos van a la misma red y la misma wallet —un lote se
//      liquida contra un solo facilitator—;
//   3. cada autorización EIP-3009 recupera a quien dice pagar, contra el
//      dominio EIP-712 que el recibo guarda.
//
// Corre bajo `bare` —no `node` como `verificar-x402.js`— justamente para poder
// importar `qvac/lote.mjs` y usar la MISMA `verificarLote` que el gateway, en
// vez de reimplementar la canonicalización y arriesgar que diverja. `verificar-
// x402.js` es node porque hace RPC a cadenas reales; esto es sólo cripto local.

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
    console.error(`  ✗ la entrada no es JSON: ${(err && err.message) || err}`)
    process.exit(2)
  }

  console.log('')
  console.log('  lote x402 — ¿se puede liquidar?   (solo lectura, no mueve fondos)')
  console.log('  ' + '-'.repeat(70))
  console.log('')
  console.log(`  id        ${safe(() => lote.idDeLote({ ...l, signature: undefined }))}`)
  console.log(`  red       ${l.network}  (${l.red || 'sin nombre corto'})`)
  console.log(`  payTo     ${l.payTo}`)
  console.log(`  recibos   ${l.count}`)
  console.log(`  total     ${l.totalAmount} (unidades mínimas del activo)`)
  console.log('')

  const r = await lote.verificarLote(l)

  if (r.firmante) console.log(`  firmante  ${r.firmante}`)
  for (const mal of r.recibosMal || []) {
    console.log(`  ✗ recibo ${mal.nonce.slice(0, 14)}… : ${mal.reason}`)
  }

  console.log('')
  console.log('  ' + '-'.repeat(70))
  if (r.ok) {
    console.log('  RESULTADO: el lote está bien armado y bien firmado. Se puede liquidar.')
    process.exit(0)
  }
  console.log(`  RESULTADO: NO se puede liquidar — ${r.reason}`)
  process.exit(1)
}

function safe(fn) {
  try {
    return fn()
  } catch {
    return '(no calculable)'
  }
}

main().catch((err) => {
  console.error('[verificar-lote] ' + ((err && err.stack) || err))
  process.exit(2)
})
