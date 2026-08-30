#!/usr/bin/env node
'use strict'

// D30.3 — mints the test asset (tUSD) to an address. TESTNET ONLY.
//
//   PYRUS_DESPLIEGUE_CLAVE=0x…  npm run mintear-tusd -- \
//     --asset 0x…  --a 0xPayerAddress  --monto 100
//
// -----------------------------------------------------------------------------
// WHY THIS EXISTS SEPARATELY FROM THE DEPLOY
//
// `desplegar-activo-prueba.js` already has a convenience `--mint-a`, but it
// mints a fixed amount (1,000,000 tUSD) and only in the same deploy tx. To
// fund the PAYER of a test `curl` — or the Phase 11 agent — with a chosen
// amount, against a contract that's already deployed, this is what's needed.
//
// The contract's `mint` is OPEN (see `scripts/activo-prueba.sol`): it's not a
// privilege reserved to whoever deployed it. Any key with faucet gas can call
// it, to any address. Being open is the strongest signal that tUSD is not a
// stablecoin and isn't worth anything.
//
// -----------------------------------------------------------------------------
// THE SAME TWO GUARDS AS THE DEPLOY, AND FOR THE SAME REASON
//
// 1. The network has to be on `redes-prueba.js`'s whitelist. Mainnet is out
//    per D30 and there's no flag to skip it — minting a "test asset" against
//    a mainnet would be staging theater on top of real money.
// 2. The chainId is read FROM THE CHAIN, not from the `--rpc` flag. A
//    misdirected RPC is exactly the failure mode the guard exists to catch.
//
// The key is DISPOSABLE (same variable as the deploy): it pays faucet gas on
// a test network. It's never saved and never encrypted — if it leaks, all
// that's lost is testnet XPL.

const fs = require('fs')
const path = require('path')
const { porQueNoSeEstrena, testnetDe } = require('./redes-prueba.js')

const VAR_CLAVE = 'PYRUS_DESPLIEGUE_CLAVE'
const VAR_ASSET = 'PYRUS_X402_PLASMA_TESTNET_ASSET'
const ARTEFACTO = path.join(__dirname, 'activo-prueba.artefacto.json')

function flag(nombre, porDefecto = null) {
  const i = process.argv.indexOf('--' + nombre)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto
}

// "100" or "100.5" (dollars) -> minimum token units, with ITS decimals read
// from the chain. Exact integer, no `Number` in the middle: an amount that
// gets signed can't go through a float.
function aUnidades(montoStr, decimals) {
  const m = String(montoStr).trim()
  if (!/^\d+(\.\d+)?$/.test(m)) throw new Error(`--monto invalid: ${JSON.stringify(montoStr)}`)
  const [entero, frac = ''] = m.split('.')
  if (frac.length > decimals) {
    throw new Error(`--monto has more than ${decimals} decimals, which is tUSD's precision`)
  }
  const fracPad = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(entero) * 10n ** BigInt(decimals) + BigInt(fracPad || '0')
}

async function main() {
  const viem = require('viem')
  const cuentas = require('viem/accounts')

  const rpcUrl = flag('rpc', testnetDe(9746).rpc)
  const asset = flag('asset', process.env[VAR_ASSET])
  const montoStr = flag('monto', '100')

  const clave = process.env[VAR_CLAVE]
  if (!clave) {
    console.error('')
    console.error(`  missing ${VAR_CLAVE}.`)
    console.error('')
    console.error('  This is a DISPOSABLE testnet key, with faucet gas. It is NOT the node\'s')
    console.error('  payout wallet and it is not saved anywhere.')
    console.error('')
    console.error('    node -e "console.log(require(\'viem/accounts\').generatePrivateKey())"')
    console.error('')
    console.error(`  Then ask the faucet for ${testnetDe(9746).nativo} for that address.`)
    console.error('')
    process.exit(1)
  }

  if (!asset || !/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    console.error('')
    console.error(`  missing the asset contract. Pass it with --asset 0x… or export ${VAR_ASSET}.`)
    console.error('  It is the address that `npm run desplegar-activo` printed.')
    console.error('')
    process.exit(1)
  }

  const a = flag('a', null)
  const cuenta = clave.trim().startsWith('0x')
    ? cuentas.privateKeyToAccount(clave.trim())
    : cuentas.mnemonicToAccount(clave.trim())
  const destino = a || cuenta.address
  if (!/^0x[0-9a-fA-F]{40}$/.test(destino)) {
    console.error(`  --a is not an EVM address: ${JSON.stringify(destino)}`)
    process.exit(1)
  }

  const publico = viem.createPublicClient({ transport: viem.http(rpcUrl) })

  // The chainId comes FROM THE CHAIN (see the header).
  let chainId
  try {
    chainId = await publico.getChainId()
  } catch (err) {
    console.error(`  RPC ${rpcUrl} did not respond: ${(err && err.message) || err}`)
    process.exit(1)
  }

  const motivo = porQueNoSeEstrena(chainId)
  if (motivo) {
    console.error('')
    console.error('  WILL NOT MINT. ' + motivo)
    console.error('')
    process.exit(1)
  }

  const red = testnetDe(chainId)
  const artefacto = JSON.parse(fs.readFileSync(ARTEFACTO, 'utf8'))

  // The decimals come from the chain, not from a constant here: it's the
  // number the amount gets scaled by, and it has to come from the same place
  // everything else reads it.
  const decimals = Number(
    await publico.readContract({ address: asset, abi: artefacto.abi, functionName: 'decimals' })
  )
  const monto = aUnidades(montoStr, decimals)

  console.log('')
  console.log(`  network    ${red.nombre} (eip155:${chainId})`)
  console.log(`  rpc        ${rpcUrl}`)
  console.log(`  asset      ${asset}`)
  console.log(`  from       ${cuenta.address}`)
  console.log(`  to         ${destino}`)
  console.log(`  amount     ${montoStr} tUSD  (${monto} units, ${decimals} decimals)`)
  console.log('')

  const saldoGas = await publico.getBalance({ address: cuenta.address })
  console.log(`  gas        ${viem.formatEther(saldoGas)} ${red.nativo}`)
  if (saldoGas === 0n) {
    console.error('')
    console.error(
      `  without ${red.nativo} the mint can't be signed. Ask the ${red.nombre} faucet for some.`
    )
    console.error('')
    process.exit(1)
  }

  const antes = await publico.readContract({
    address: asset,
    abi: artefacto.abi,
    functionName: 'balanceOf',
    args: [destino]
  })

  const cadena = viem.defineChain({
    id: chainId,
    name: red.nombre,
    nativeCurrency: { name: red.nativo, symbol: red.nativo, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  })
  const billetera = viem.createWalletClient({
    account: cuenta,
    chain: cadena,
    transport: viem.http(rpcUrl)
  })

  const hash = await billetera.writeContract({
    address: asset,
    abi: artefacto.abi,
    functionName: 'mint',
    args: [destino, monto]
  })
  console.log(`  tx         ${hash}`)

  const recibo = await publico.waitForTransactionReceipt({ hash })
  if (recibo.status !== 'success') {
    console.error(`  the mint failed: status=${recibo.status}`)
    process.exit(1)
  }

  const despues = await publico.readContract({
    address: asset,
    abi: artefacto.abi,
    functionName: 'balanceOf',
    args: [destino]
  })

  console.log('')
  console.log(`  balanceOf(${destino})`)
  console.log(`    before   ${antes} units`)
  console.log(`    after    ${despues} units  (+${despues - antes})`)
  if (red.explorer) console.log(`  explorer   ${red.explorer}/tx/${hash}`)
  console.log('')
}

main().catch((err) => {
  console.error('[mintear-tusd] ' + ((err && err.stack) || err))
  process.exit(2)
})
