#!/usr/bin/env node
'use strict'

// Can x402 charge today, and on which network? Entirely READ-ONLY.
//
//   npm run verificar-x402
//
// -----------------------------------------------------------------------------
// WHY IT EXISTS
//
// Phase 9's DoD asks for a tx hash on an explorer. Before funding a wallet
// to go get one, it has to be known whether the path to the chain exists,
// and that question has THREE parts that break independently:
//
//   1. the chain responds and is the one we say it is (chainId);
//   2. there's an ERC-20 with EIP-3009 at the address we're going to charge
//      with, and the EIP-712 domain we SIGN with is the one that contract
//      VALIDATES;
//   3. there's a live facilitator that supports that network.
//
// All three get answered without moving a cent. Discovering (3) AFTER
// funding means spending real money to find out there was nobody to ask
// for settlement — which is exactly what almost happened: D14's hosted one
// (`x402.semanticpay.io`) was returning 500/503 on every one of its
// endpoints on 2026-08-27, and a test that hit it by accident still
// "passed" because the receipt gets saved even if settlement fails.
//
// (2) is the one that fails the most quietly. `version` can't be read from
// the contract in every case —Plasma's USD₮0 reverts on `version()`— but
// `DOMAIN_SEPARATOR` can be read, and comparing what the contract returns
// against what we compute with our own values proves the equality without
// needing the getter. Stronger than reading the field.
//
// -----------------------------------------------------------------------------
// IT'S ALSO THE ACCEPTANCE CRITERION FOR THE TOKEN WE'RE GOING TO DEPLOY
//
// On Plasma testnet (9746) there's no stablecoin: the faucets only give
// out XPL, which is gas and has no contract. So the asset to test with has
// to be deployed. Once it exists, it gets pointed to here with:
//
//   PYRUS_X402_PLASMA_TESTNET_ASSET=0x… npm run verificar-x402
//
// and this says whether it came out right: whether it implements EIP-3009
// and whether its domain matches the one we're going to sign with. A test
// token that passes these checks is interchangeable with mainnet's for
// everything the gateway does.

const https = require('https')
const http = require('http')

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

// The same variable name `qvac/x402.mjs` reads, so both can be pointed at
// the same side without having to think about it twice.
const VAR_FACILITATOR = 'PYRUS_X402_FACILITATOR'
const FACILITATOR_DEFAULT = 'https://x402.semanticpay.io'

// NOTE: this table duplicates what `qvac/x402.mjs` declares, and does so on
// purpose. That module runs under Bare (it imports `bare-env`) and this
// runs under node, so it can't be imported. If they drift apart, this
// script lies — that's why it compares against the CHAIN and not against
// itself: a value copied wrong here gives itself away in the
// `DOMAIN_SEPARATOR`, it doesn't go unnoticed.
const REDES = [
  {
    nombre: 'plasma',
    caip2: 'eip155:9745',
    rpc: 'https://rpc.plasma.to',
    explorer: 'https://plasmascan.to',
    activo: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    dominio: { name: 'USDT0', version: '1' },
    rol: 'D15\'s default — MAINNET, real money'
  },
  {
    nombre: 'plasma-testnet',
    caip2: 'eip155:9746',
    rpc: 'https://testnet-rpc.plasma.to',
    explorer: 'https://testnet.plasmascan.to',
    // No stablecoin deployed: declared via variable once it exists.
    activo: process.env.PYRUS_X402_PLASMA_TESTNET_ASSET || null,
    dominio: {
      name: process.env.PYRUS_X402_PLASMA_TESTNET_NAME || null,
      version: process.env.PYRUS_X402_PLASMA_TESTNET_VERSION || '1'
    },
    rol: 'where testing happens — project rule: never a first run on mainnet'
  },
  {
    nombre: 'stable',
    caip2: 'eip155:988',
    rpc: null, // no public RPC known in this tree; only x402's table gets checked
    explorer: null,
    activo: null,
    dominio: null,
    rol: 'D15\'s fallback — @x402/evm knows it out of the box'
  }
]

// -----------------------------------------------------------------------------
// RPC
// -----------------------------------------------------------------------------

function rpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const cuerpo = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const mod = url.startsWith('http://') ? http : https
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) }
      },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch (e) {
            reject(new Error(`non-JSON response (HTTP ${res.statusCode}): ${d.slice(0, 120)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('20s timeout')))
    req.write(cuerpo)
    req.end()
  })
}

// An ABI-encoded string. Old tokens return bytes32 instead of string, so the
// short case is handled instead of returning garbage.
function leerString(hex) {
  if (!hex || hex === '0x') return null
  const b = Buffer.from(hex.slice(2), 'hex')
  if (b.length < 64) return b.toString('utf8').replace(/\0+$/g, '')
  const len = parseInt(b.slice(32, 64).toString('hex'), 16)
  return b.slice(64, 64 + len).toString('utf8')
}

const SEL = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  version: '0x54fd4d50',
  DOMAIN_SEPARATOR: '0x3644e515',
  // authorizationState(address,bytes32) — if this does NOT revert, the
  // contract implements EIP-3009, which is x402's `exact` scheme.
  authorizationState: '0xe94a0102'
}

async function llamar(url, to, data) {
  const r = await rpc(url, 'eth_call', [{ to, data }, 'latest'])
  if (r.error) return { error: r.error.message }
  return { valor: r.result }
}

// -----------------------------------------------------------------------------
// The checks
// -----------------------------------------------------------------------------

const ok = (s) => '  ✓ ' + s
const no = (s) => '  ✗ ' + s
const dato = (s) => '    ' + s

async function verificarRed(red, viem) {
  const lineas = []
  let usable = false

  if (!red.rpc) {
    lineas.push(dato('no RPC in this table; cannot verify against the chain from here'))
    return { lineas, usable: null }
  }

  // 1. The chain is the one we say it is.
  let chainId = null
  try {
    const r = await rpc(red.rpc, 'eth_chainId', [])
    chainId = parseInt(r.result, 16)
  } catch (err) {
    lineas.push(no(`the RPC does not respond: ${err.message}`))
    return { lineas, usable: false }
  }

  const esperado = Number(red.caip2.split(':')[1])
  if (chainId !== esperado) {
    lineas.push(no(`the RPC says chainId ${chainId} and the config declares ${esperado}`))
    return { lineas, usable: false }
  }
  lineas.push(ok(`chainId ${chainId} — matches ${red.caip2}`))

  // 2. The asset.
  if (!red.activo) {
    lineas.push(no('no asset declared: nothing to charge with on this network'))
    if (red.nombre === 'plasma-testnet') {
      lineas.push(dato('the faucets give out XPL, which is native gas and has no contract'))
      lineas.push(dato('once one is deployed: PYRUS_X402_PLASMA_TESTNET_ASSET=0x…'))
    }
    return { lineas, usable: false }
  }

  const code = await rpc(red.rpc, 'eth_getCode', [red.activo, 'latest'])
  if (!code.result || code.result === '0x') {
    lineas.push(no(`no contract at ${red.activo}`))
    return { lineas, usable: false }
  }
  lineas.push(ok(`contract at ${red.activo} (${(code.result.length - 2) / 2} bytes)`))

  const nombre = leerString((await llamar(red.rpc, red.activo, SEL.name)).valor)
  const simbolo = leerString((await llamar(red.rpc, red.activo, SEL.symbol)).valor)
  const dec = await llamar(red.rpc, red.activo, SEL.decimals)
  const decimals = dec.valor ? parseInt(dec.valor, 16) : null
  lineas.push(
    dato(`name=${JSON.stringify(nombre)} symbol=${JSON.stringify(simbolo)} decimals=${decimals}`)
  )

  // 3. EIP-3009. Without this x402's `exact` scheme has nothing to sign.
  const auth = await llamar(
    red.rpc,
    red.activo,
    SEL.authorizationState +
      '0'.repeat(24) +
      'f39fd6e51aad88f6f4ce6ab8827279cfffb92266' +
      '00'.repeat(32)
  )
  if (auth.error) {
    lineas.push(no(`does NOT implement EIP-3009 (authorizationState reverts: ${auth.error})`))
    return { lineas, usable: false }
  }
  lineas.push(ok('implements EIP-3009 (authorizationState responds)'))

  // 4. The EIP-712 domain we SIGN with is the one the contract VALIDATES.
  //    This is the check that fails the most quietly and the only one that
  //    proves the signature is going to verify on the other side.
  const ds = await llamar(red.rpc, red.activo, SEL.DOMAIN_SEPARATOR)
  if (!ds.valor || ds.error) {
    lineas.push(dato('the contract does not expose DOMAIN_SEPARATOR: cannot compare the domain'))
    usable = true
  } else if (!red.dominio || !red.dominio.name) {
    lineas.push(dato(`on-chain DOMAIN_SEPARATOR: ${ds.valor}`))
    lineas.push(
      dato(
        'with no `name` declared it cannot be compared — declare it with PYRUS_X402_PLASMA_TESTNET_NAME'
      )
    )
  } else {
    const computado = viem.domainSeparator({
      domain: {
        name: red.dominio.name,
        version: red.dominio.version,
        chainId,
        verifyingContract: red.activo
      }
    })
    if (computado.toLowerCase() === ds.valor.toLowerCase()) {
      lineas.push(
        ok(
          `the EIP-712 domain matches (name="${red.dominio.name}" version="${red.dominio.version}")`
        )
      )
      usable = true
    } else {
      lineas.push(no('the EIP-712 domain does NOT match: one of our signatures would not verify'))
      lineas.push(dato(`  computed : ${computado}`))
      lineas.push(dato(`  on-chain : ${ds.valor}`))
    }
  }

  return { lineas, usable }
}

async function verificarFacilitator(url) {
  const lineas = []
  try {
    const { HTTPFacilitatorClient } = require('@x402/core/http')
    const cliente = new HTTPFacilitatorClient({ url })
    const soportado = await cliente.getSupported()
    const kinds = (soportado && (soportado.kinds || soportado.supported)) || soportado
    lineas.push(ok('/supported responds'))
    lineas.push(dato(JSON.stringify(kinds).slice(0, 600)))
    return { lineas, vivo: true, kinds }
  } catch (err) {
    lineas.push(no(`does not respond: ${String((err && err.message) || err).slice(0, 200)}`))
    lineas.push(
      dato('with no facilitator there is NO settlement: a payment can be verified, not charged (D12)')
    )
    lineas.push(dato('plan B is already written: D14(b), self-hosted — risk #5'))
    return { lineas, vivo: false, kinds: null }
  }
}

// -----------------------------------------------------------------------------

async function main() {
  const viem = require('viem')
  const facilitator = process.env[VAR_FACILITATOR] || FACILITATOR_DEFAULT

  console.log('')
  console.log('  x402 — can it charge today?   (all read-only, moves no funds)')
  console.log('  ' + '-'.repeat(70))

  console.log('')
  console.log(`  FACILITATOR  ${facilitator}`)
  if (facilitator === FACILITATOR_DEFAULT) {
    console.log(dato(`(D14's default; change it with ${VAR_FACILITATOR})`))
  }
  const fac = await verificarFacilitator(facilitator)
  for (const l of fac.lineas) console.log(l)

  const usables = []
  for (const red of REDES) {
    console.log('')
    console.log(`  NETWORK  ${red.nombre}  (${red.caip2})`)
    console.log(dato(red.rol))
    const r = await verificarRed(red, viem)
    for (const l of r.lineas) console.log(l)
    if (r.usable) usables.push(red.nombre)
  }

  console.log('')
  console.log('  ' + '-'.repeat(70))
  if (usables.length === 0) {
    console.log('  RESULT: no network with a verified asset. Nothing to charge with.')
  } else {
    console.log(`  RESULT: verified asset on ${usables.join(', ')}.`)
  }
  if (!fac.vivo) {
    console.log('  And there is NO facilitator: even if the asset is fine, settlement does not happen.')
  }
  console.log('')

  // Exits nonzero when there is NO complete path to the chain. It's the
  // question this script exists to answer, and it has to be chainable.
  process.exit(fac.vivo && usables.length > 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[verificar-x402] ' + ((err && err.stack) || err))
  process.exit(2)
})
