#!/usr/bin/env node
'use strict'

// D30.3 — deploys the test asset. TESTNET ONLY.
//
//   PYRUS_DESPLIEGUE_CLAVE=0x…  npm run desplegar-activo   -- --rpc https://testnet-rpc.plasma.to
//
// -----------------------------------------------------------------------------
// WHY THIS IS NEITHER HARDHAT NOR FOUNDRY
//
// The repo has no Solidity or toolchain, and it doesn't gain one here: what's
// in `scripts/` is the **already compiled bytecode** (`activo-prueba.artefacto.json`)
// and this, which sends it. The compilation happened once, outside the tree,
// with a standalone `solc` — the artifact records the exact compiler version,
// the settings, and the SHA-256 of the source, so it can be repeated without
// guessing. The product never finds out Solidity exists, which is the point.
//
// The price of that decision, stated plainly: recompiling isn't `npm run`
// anything. If someone edits `activo-prueba.sol`, the artifact goes stale —
// and that's why there's a test that recomputes the source hash and breaks
// when they no longer match.
//
// -----------------------------------------------------------------------------
// HOW TO RECOMPILE, EXACTLY
//
// It used to just say "with a standalone solc" and that's not enough to
// repeat it: it had to be guessed once. The full recipe, outside the tree:
//
//   mkdir /tmp/solcbox && cd /tmp/solcbox && npm init -y && npm i solc@0.8.28
//
// and compile with the STANDARD JSON interface, using the three fields the
// artifact already records — `solc`, `settings`, and `claveFuente`:
//
//   {
//     "language": "Solidity",
//     "sources": { "<claveFuente>": { "content": "<the whole .sol>" } },
//     "settings": { ...<settings>, "outputSelection": { "*": { "*": [
//       "abi", "evm.bytecode.object", "evm.deployedBytecode.object" ] } } }
//   }
//
// **`claveFuente` is not cosmetic, hence the note.** The key under which the
// source is handed to solc goes into the metadata hash the compiler appends
// to the end of the bytecode: the same source, with the same version and the
// same settings, compiles to DIFFERENT bytecode if the key changes. With
// `solc@0.8.28` and `claveFuente: "activo-prueba.sol"` the artifact
// reproduces byte for byte — verified, and it's the check to pass BEFORE
// regenerating it: if you can't reproduce the old artifact, your toolchain
// isn't the one this file was built with, and what you generate will differ
// for reasons that aren't your change.
//
// The repo still gains no toolchain: `/tmp/solcbox` isn't this tree and
// `package.json` never finds out.
//
// -----------------------------------------------------------------------------
// THE TWO GUARDS, AND WHY THEY CAN'T BE TURNED OFF
//
// 1. The network has to be on `redes-prueba.js`'s whitelist. Mainnet is out
//    per D30 and there's no flag that skips it.
// 2. The chainId is read FROM THE CHAIN, not from whatever the `--rpc` flag
//    says. A misconfigured RPC is exactly the failure mode this guard exists
//    for, so asking the chain who it is before signing anything is the
//    correct order.
//
// The deploy key is DISPOSABLE and is not the node's payout wallet: it pays
// faucet gas on a test network. It isn't stored, isn't encrypted, and doesn't
// need to be — if it leaks, all that's lost is testnet XPL.

const fs = require('fs')
const path = require('path')
const { porQueNoSeEstrena, testnetDe } = require('./redes-prueba.js')

const VAR_CLAVE = 'PYRUS_DESPLIEGUE_CLAVE'
const ARTEFACTO = path.join(__dirname, 'activo-prueba.artefacto.json')

function flag(nombre, porDefecto = null) {
  const i = process.argv.indexOf('--' + nombre)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto
}

async function main() {
  const viem = require('viem')
  const cuentas = require('viem/accounts')

  const rpcUrl = flag('rpc', testnetDe(9746).rpc)
  const mintA = flag('mint-a', null)

  const clave = process.env[VAR_CLAVE]
  if (!clave) {
    console.error('')
    console.error(`  missing ${VAR_CLAVE}.`)
    console.error('')
    console.error('  It\'s a DISPOSABLE testnet key, with faucet gas. It is NOT the node\'s')
    console.error('  payout wallet and it isn\'t stored anywhere.')
    console.error('')
    console.error('    node -e "console.log(require(\'viem/accounts\').generatePrivateKey())"')
    console.error('')
    console.error(`  Then ask the faucet for ${testnetDe(9746).nativo} for that address.`)
    console.error('')
    process.exit(1)
  }

  const cuenta = clave.trim().startsWith('0x')
    ? cuentas.privateKeyToAccount(clave.trim())
    : cuentas.mnemonicToAccount(clave.trim())

  const publico = viem.createPublicClient({ transport: viem.http(rpcUrl) })

  // The chainId comes FROM THE CHAIN. See the header: trusting the flag means
  // trusting exactly the data that can be wrong.
  let chainId
  try {
    chainId = await publico.getChainId()
  } catch (err) {
    console.error(`  RPC ${rpcUrl} is not responding: ${(err && err.message) || err}`)
    process.exit(1)
  }

  const motivo = porQueNoSeEstrena(chainId)
  if (motivo) {
    console.error('')
    console.error('  NOT DEPLOYING. ' + motivo)
    console.error('')
    process.exit(1)
  }

  const red = testnetDe(chainId)
  const artefacto = JSON.parse(fs.readFileSync(ARTEFACTO, 'utf8'))

  console.log('')
  console.log(`  network    ${red.nombre} (eip155:${chainId})`)
  console.log(`  rpc        ${rpcUrl}`)
  console.log(`  from       ${cuenta.address}`)
  console.log(`  contract   ${artefacto.contrato} — ${artefacto.solc}`)
  console.log(`  bytecode   ${(artefacto.bytecode.length - 2) / 2} bytes`)
  console.log('')

  const saldo = await publico.getBalance({ address: cuenta.address })
  console.log(`  gas        ${viem.formatEther(saldo)} ${red.nativo}`)
  if (saldo === 0n) {
    console.error('')
    console.error(`  no ${red.nativo}, cannot deploy. Ask the ${red.nombre} faucet for some.`)
    console.error('')
    process.exit(1)
  }

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

  const hash = await billetera.deployContract({ abi: artefacto.abi, bytecode: artefacto.bytecode })
  console.log(`  tx         ${hash}`)

  const recibo = await publico.waitForTransactionReceipt({ hash })
  if (recibo.status !== 'success' || !recibo.contractAddress) {
    console.error(`  deployment failed: status=${recibo.status}`)
    process.exit(1)
  }
  const activo = recibo.contractAddress
  console.log(`  contract   ${activo}`)
  if (red.explorer) console.log(`  explorer   ${red.explorer}/address/${activo}`)

  // `mint` is open (see the .sol), so this is a convenience and not a
  // privilege reserved for whoever deployed: anyone can call it again later.
  if (mintA) {
    const h = await billetera.writeContract({
      address: activo,
      abi: artefacto.abi,
      functionName: 'mint',
      args: [mintA, 1000000000000n]
    })
    await publico.waitForTransactionReceipt({ hash: h })
    console.log(`  mint       1,000,000 tUSD -> ${mintA}`)
  }

  // `name` is read FROM THE CHAIN and not from a constant in here: it's the
  // one that's going into the EIP-712 domain used to sign, so it has to come
  // from the same place whoever verifies is going to read it from.
  const nombre = await publico.readContract({
    address: activo,
    abi: artefacto.abi,
    functionName: 'name'
  })
  const version = await publico.readContract({
    address: activo,
    abi: artefacto.abi,
    functionName: 'version'
  })

  console.log('')
  console.log('  ' + '-'.repeat(70))
  console.log('  Now the acceptance criterion, which already existed and is executable:')
  console.log('')
  console.log(`    PYRUS_X402_PLASMA_TESTNET_ASSET=${activo} \\`)
  console.log(`    PYRUS_X402_PLASMA_TESTNET_NAME="${nombre}" \\`)
  console.log(`    PYRUS_X402_PLASMA_TESTNET_VERSION=${version} \\`)
  console.log('    npm run verificar-x402')
  console.log('')
  console.log('  That checks against THE CHAIN that the contract implements EIP-3009 and')
  console.log('  that its DOMAIN_SEPARATOR is the same EIP-712 domain we are going to sign with.')
  console.log('  Until that passes green, the asset is not verified.')
  console.log('')
}

main().catch((err) => {
  console.error('[desplegar-activo-prueba] ' + ((err && err.stack) || err))
  process.exit(2)
})
