#!/usr/bin/env node
'use strict'

// D14(b) / D30.4 — the self-hosted facilitator. Three endpoints and a wallet with gas.
//
//   PYRUS_FACILITATOR_CLAVE=0x…  PYRUS_X402_PLASMA_TESTNET_ASSET=0x…  npm run facilitator
//
// and on the other side, the node:
//
//   PYRUS_X402_FACILITATOR=http://127.0.0.1:8402  npm run serve
//
// -----------------------------------------------------------------------------
// WHY IT STOPS BEING PLAN B
//
// D14 picked Semantic's hosted facilitator "until Phase 10". D30 pulled that
// forward for two facts, not out of preference: the hosted one was returning
// 500/503 on ALL its endpoints on 2026-08-27, and it doesn't support 9746 —
// let alone knowing about a token we deployed ourselves. Without this, D30 can
// be written but not demonstrated.
//
// -----------------------------------------------------------------------------
// THIS IS NODE, NOT BARE, AND IT DOES NOT GO INTO THE BINARY. IT DOES NOT VIOLATE D11.
//
// Worth spelling out because it looks like it might: D11 decides the wallet's
// runtime INSIDE THE BINARY THAT SHIPS. A facilitator is already a remote
// service today — the node just talks to it over HTTP, nothing more. Self-
// hosting it swaps one remote service for a local one; it doesn't add a single
// line inside the binary. It lives in `scripts/`, which `package.json:files`
// doesn't publish and which `pear.stage` ignores, so the separation is
// mechanical, not a promise.
//
// -----------------------------------------------------------------------------
// ITS WALLET IS A DIFFERENT WALLET, AND IT NEEDS GAS
//
// The facilitator BROADCASTS the transaction, so it pays native gas. On testnet
// that comes from the faucet and is free. It's a wallet **distinct** from the
// node's payout wallet:
//
//   - the node's (D13) collects payment, lives encrypted in the keystore, and
//     its seed never leaves the process that opens it;
//   - this one spends faucet gas on a test network, is disposable, and if it
//     leaks all that's lost is worthless XPL.
//
// Mixing them would be handing an HTTP service the key to the money, just to
// save one line of configuration.
//
// -----------------------------------------------------------------------------
// NO NEW DEPENDENCIES
//
// The reference path (SemanticPay/x402-usdt0-demo) uses Express and the
// `@semanticio/wdk-wallet-evm-x402-facilitator` adapter. Neither is needed here,
// and pulling them in would be expensive:
//
//   - that adapter pins `@x402/evm@2.2.0` and `@tetherto/wdk-wallet-evm@1.0.0-beta.7`,
//     and this tree runs 2.23.0 and beta.17. Installing it would leave TWO
//     copies of `@x402/evm` in the same process, and the one that builds the
//     402 wouldn't be the one that settles it. That's exactly the kind of
//     silent divergence this repo is chasing down.
//   - `@x402/evm` 2.23 already exports `toFacilitatorEvmSigner`, which is
//     exactly what that adapter did: wrap a signer for the facilitator role.
//   - the three endpoints are a 40-line `http.createServer`.
//
// Result: `viem`, `@x402/core` and `@x402/evm` — all three were already in the
// tree. The facilitator doesn't add a single dependency.

const http = require('http')
const { porQueNoSeEstrena, testnetDe } = require('./redes-prueba.js')

const VAR_CLAVE = 'PYRUS_FACILITATOR_CLAVE'
const VAR_PUERTO = 'PYRUS_FACILITATOR_PUERTO'
const VAR_RPC = 'PYRUS_FACILITATOR_RPC'
const VAR_CHAIN = 'PYRUS_FACILITATOR_CHAINID'
const PUERTO_DEFAULT = 8402

// The default network is D30's: 9746. There's no mainnet default here, hidden
// in a `||` or otherwise — that's exactly where that kind of default sneaks in.
const CHAIN_DEFAULT = 9746

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let crudo = ''
    req.on('data', (c) => {
      crudo += c
      // A facilitator is a public endpoint on a node that also has a GPU.
      // An infinite POST can't be a way to take it down.
      if (crudo.length > 1_000_000) req.destroy(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(crudo ? JSON.parse(crudo) : {})
      } catch (err) {
        reject(new Error('body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

// `arrancar` returns the server already listening instead of ending the
// process, so the test can bring it up and down. `main` is the one that exits
// with an exit code.
async function arrancar({ chainId, rpcUrl, clave, puerto, host = '127.0.0.1' }) {
  const viem = require('viem')
  const cuentas = require('viem/accounts')
  const { x402Facilitator } = require('@x402/core/facilitator')
  const { registerExactEvmScheme } = require('@x402/evm/exact/facilitator')
  const { toFacilitatorEvmSigner } = require('@x402/evm')

  // D30'S GUARD, BEFORE BUILDING ANYTHING. A facilitator settles: it's
  // literally the component that moves value, so if there's one place this
  // check can't be missing, it's here.
  const motivo = porQueNoSeEstrena(chainId)
  if (motivo) throw new Error('NO SE LEVANTA. ' + motivo)

  const red = testnetDe(chainId)
  const cuenta = clave.trim().startsWith('0x')
    ? cuentas.privateKeyToAccount(clave.trim())
    : cuentas.mnemonicToAccount(clave.trim())

  const cadena = viem.defineChain({
    id: chainId,
    name: red.nombre,
    nativeCurrency: { name: red.nativo, symbol: red.nativo, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  })

  const publico = viem.createPublicClient({ chain: cadena, transport: viem.http(rpcUrl) })
  const billetera = viem.createWalletClient({
    account: cuenta,
    chain: cadena,
    transport: viem.http(rpcUrl)
  })

  // `toFacilitatorEvmSigner` wants ONE object with the reads, the writes, and
  // the receipt wait. It's composed from the two viem clients: the public one
  // reads, the wallet one writes. It's the same piece the SemanticPay adapter
  // built by hand, already provided by the package.
  const signer = toFacilitatorEvmSigner({
    address: cuenta.address,
    readContract: (args) => publico.readContract(args),
    verifyTypedData: (args) => publico.verifyTypedData(args),
    writeContract: (args) => billetera.writeContract({ ...args, chain: cadena }),
    sendTransaction: (args) => billetera.sendTransaction({ ...args, chain: cadena }),
    waitForTransactionReceipt: (args) => publico.waitForTransactionReceipt(args),
    getCode: (args) => publico.getCode(args)
  })

  const facilitator = new x402Facilitator()
  // `networks` is a parameter, and that's why 9746 — which no hosted
  // facilitator knows about — goes in without touching the package.
  registerExactEvmScheme(facilitator, { networks: [red.caip2], signer })

  // `registerExactEvmScheme` does NOT register only what we asked for: inside
  // it calls `facilitator.registerV1(NETWORKS, …)` with its own factory list,
  // which brings `ethereum`, `base`, `avalanche` and more. Which means a raw
  // `/supported` advertises MAINNETS this process can't serve — the signer and
  // the RPC are on 9746 — and that D30 says stay untouched.
  //
  // Advertising something that can't be honored is the failure mode this whole
  // block exists to prevent: someone reads `/supported`, sees `base`, and sends
  // a payment nobody's going to settle. So it gets filtered down to the
  // configured network, and `verify`/`settle` reject anything else BEFORE
  // looking at the signature.
  const soloNuestraRed = (soportado) => {
    const kinds = ((soportado && soportado.kinds) || []).filter((k) => k.network === red.caip2)
    return { ...soportado, kinds }
  }

  const redEquivocada = (cuerpo) => {
    const n = cuerpo && cuerpo.paymentPayload && cuerpo.paymentPayload.network
    if (!n || n === red.caip2) return null
    return `this facilitator serves ${red.caip2} and the payment says ${n}`
  }

  // -------------------------------------------------------------------------
  // THE TWO ERROR BODIES, SHAPED THE WAY THE OFFICIAL CLIENT ACCEPTS
  //
  // This isn't style. `@x402/core` parses EVERY 200 response against a zod
  // schema, and the two schemas are different:
  //
  //   verifyResponseSchema  isValid + invalidReason / invalidMessage
  //   settleResponseSchema  success + errorReason / errorMessage, and ON TOP
  //                         OF THAT `transaction` and `network` as REQUIRED
  //                         strings, even when it fails.
  //
  // Sending the wrong body doesn't produce a loud error: it produces a quiet
  // one, and in two different ways. With settle's keys on /verify, zod
  // DISCARDS them without complaint and the gateway gets a bare
  // `{isValid:false}`, no reason. On /settle, without `transaction` or
  // `network`, zod rejects the ENTIRE response and the client throws
  // `FacilitatorResponseError`, which buries the real reason nested inside
  // another exception's text.
  //
  // Both break exactly what this block exists to uphold: on the other side
  // there's a gateway that has ALREADY served the tokens — D12 settles
  // AFTERWARD — and needs to be able to record WHY it didn't get paid. That's
  // what ends up in the receipt, in the panel, and what Phase 10 will read to
  // decide whether a failure gets retried, discarded, or blamed on someone.
  //
  // Verified against the OFFICIAL CLIENT and not against a curl: a test that
  // looks at the raw JSON passes with both bugs in place, because both happen
  // on the parsing side.
  // -------------------------------------------------------------------------
  const errorDeVerify = (motivo, mensaje) => ({
    isValid: false,
    invalidReason: motivo,
    invalidMessage: mensaje
  })

  const errorDeSettle = (motivo, mensaje, network) => ({
    success: false,
    errorReason: motivo,
    errorMessage: mensaje,
    // Empty, but PRESENT and a string: the schema requires them even when
    // there's no transaction to report, and without them everything else
    // gets lost too.
    network: network || ''
  })

  const responder = (res, codigo, cuerpo) => {
    const texto = JSON.stringify(cuerpo)
    res.writeHead(codigo, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(texto)
    })
    res.end(texto)
  }

  const server = http.createServer(async (req, res) => {
    const ruta = (req.url || '').split('?')[0]
    // Saved as soon as the body is parsed so the `catch` below can return
    // the PAYMENT's network and not the one this process serves: they differ
    // exactly in the case that matters most to debug.
    let redDelPago = ''
    try {
      if (req.method === 'GET' && ruta === '/supported') {
        return responder(res, 200, soloNuestraRed(await facilitator.getSupported()))
      }
      if (req.method === 'POST' && ruta === '/verify') {
        const c = await leerCuerpo(req)
        redDelPago = (c && c.paymentPayload && c.paymentPayload.network) || ''
        const mal = redEquivocada(c)
        if (mal) return responder(res, 200, errorDeVerify('unsupported_network', mal))
        return responder(
          res,
          200,
          await facilitator.verify(c.paymentPayload, c.paymentRequirements)
        )
      }
      if (req.method === 'POST' && ruta === '/settle') {
        const c = await leerCuerpo(req)
        redDelPago = (c && c.paymentPayload && c.paymentPayload.network) || ''
        const mal = redEquivocada(c)
        if (mal) {
          return responder(res, 200, errorDeSettle('unsupported_network', mal, redDelPago))
        }
        return responder(
          res,
          200,
          await facilitator.settle(c.paymentPayload, c.paymentRequirements)
        )
      }
      return responder(res, 404, { error: 'not found: ' + req.method + ' ' + ruta })
    } catch (err) {
      const message = (err && err.message) || String(err)
      console.error(`[facilitator] ${req.method} ${ruta}: ${message}`)
      // An error gets answered STRUCTURED and not with a bare 500: on the
      // other side there's a gateway that already served the tokens and needs
      // to be able to record why it didn't get settled. A bodyless 500 turns
      // into a "settlement_failed" with no reason, which is exactly what D12
      // asks not to lose.
      //
      // And structured means SHAPED LIKE THE ROUTE — see the two constructors
      // above. A body with the other route's keys gets lost just like a 500,
      // only quietly.
      if (ruta === '/settle') {
        return responder(res, 200, errorDeSettle('facilitator_error', message, redDelPago))
      }
      return responder(res, 200, errorDeVerify('facilitator_error', message))
    }
  })

  await new Promise((resolve) => server.listen(puerto, host, resolve))
  return { server, cuenta, red, publico, url: `http://${host}:${server.address().port}` }
}

async function main() {
  const chainId = Number(process.env[VAR_CHAIN] || CHAIN_DEFAULT)
  const red = testnetDe(chainId)
  const rpcUrl = process.env[VAR_RPC] || (red && red.rpc)
  const puerto = Number(process.env[VAR_PUERTO] || PUERTO_DEFAULT)
  const clave = process.env[VAR_CLAVE]

  if (!clave) {
    console.error('')
    console.error(`  missing ${VAR_CLAVE}.`)
    console.error('')
    console.error('  This is the FACILITATOR wallet: it pays the gas to broadcast the')
    console.error('  transaction, and it is NOT the node\'s payout wallet. On testnet the gas')
    console.error('  comes from the faucet.')
    console.error('')
    console.error('    node -e "console.log(require(\'viem/accounts\').generatePrivateKey())"')
    console.error('')
    process.exit(1)
  }
  if (!rpcUrl) {
    console.error(`  no RPC for chainId ${chainId}: set it in ${VAR_RPC}`)
    process.exit(1)
  }

  let vivo
  try {
    vivo = await arrancar({ chainId, rpcUrl, clave, puerto })
  } catch (err) {
    console.error('')
    console.error('  ' + ((err && err.message) || err))
    console.error('')
    process.exit(1)
  }

  console.log('')
  console.log(`  facilitator  ${vivo.url}`)
  console.log(`  network      ${vivo.red.nombre} (${vivo.red.caip2})`)
  console.log(`  rpc          ${rpcUrl}`)
  console.log(`  wallet       ${vivo.cuenta.address}   <- needs ${vivo.red.nativo} from the faucet`)
  console.log('')
  console.log('  On the other side, the node:')
  console.log(`    PYRUS_X402_FACILITATOR=${vivo.url}`)
  console.log('')

  // The balance is checked AFTER startup, and doesn't block it: /supported and
  // /verify work without a cent. The only one that needs gas is /settle, and
  // warning early avoids finding out about it with a request already served.
  try {
    const saldo = await vivo.publico.getBalance({ address: vivo.cuenta.address })
    if (saldo === 0n) {
      console.log(`  WARNING: the wallet has no ${vivo.red.nativo}. /verify works; /settle won't be`)
      console.log('           able to broadcast anything until the faucet funds it.')
      console.log('')
    }
  } catch {
    console.log('  WARNING: could not read the balance (the RPC did not respond). /settle may fail.')
    console.log('')
  }
}

module.exports = { arrancar, VAR_CLAVE, VAR_PUERTO, VAR_RPC, VAR_CHAIN, CHAIN_DEFAULT }

if (require.main === module) {
  main().catch((err) => {
    console.error('[facilitator] ' + ((err && err.stack) || err))
    process.exit(2)
  })
}
