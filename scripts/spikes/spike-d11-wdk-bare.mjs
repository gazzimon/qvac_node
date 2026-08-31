// D11 spike — do WDK and x402 run under Bare, or is a worklet needed?
//
// RESULT (2026-08-25): YES, directly. All four steps pass under Bare with no
// shim or worklet, and the EIP-3009 signature comes out byte-for-byte
// identical to Node's. That last part wasn't what the spike was looking
// for and it's worth more than the yes: it rules out two swarm machines
// with different runtimes being able to sign different authorizations.
//
// KEPT AROUND TO BE RE-RUN, not as documentation of something already
// closed: the answer holds for TODAY's versions of wdk-wallet-evm and
// @x402/*. Whenever either bumps a major, this gets run again before
// assuming it still works.
//
//   npm install @tetherto/wdk-wallet-evm @x402/core @x402/evm
//   node scripts/spikes/spike-d11-wdk-bare.mjs     # control
//   bare scripts/spikes/spike-d11-wdk-bare.mjs     # la pregunta real
//
// Installs nothing and doesn't touch the project tree: run it in a
// separate directory with those three dependencies. They're kept out of
// package.json on purpose while Phase 7 doesn't actually use them yet.
//
// Each step reports on its own and doesn't cut off the ones after it: what
// matters is knowing WHICH one fails, not letting the first failure hide
// the rest.
const paso = async (n, nombre, fn) => {
  try {
    const r = await fn()
    console.log(`OK   ${n}. ${nombre}${r ? ' -> ' + r : ''}`)
    return true
  } catch (e) {
    console.log(`FAIL ${n}. ${nombre}`)
    console.log(`     ${(e && e.message ? e.message : e).toString().split('\n')[0]}`)
    return false
  }
}

// Well-known public test seed. Never funded.
const SEED = 'test test test test test test test test test test test junk'

let WalletManagerEvm = null
let cuenta = null

await paso(1, 'import @tetherto/wdk-wallet-evm', async () => {
  const m = await import('@tetherto/wdk-wallet-evm')
  WalletManagerEvm = m.default || m
  return typeof WalletManagerEvm
})

await paso(2, 'derive an account from the seed', async () => {
  const wm = new WalletManagerEvm(SEED, { provider: 'https://rpc.plasma.to' })
  cuenta = await wm.getAccount()
  const addr = await cuenta.getAddress()
  return addr
})

await paso(3, 'sign EIP-3009 transferWithAuthorization OFFLINE', async () => {
  const dominio = {
    name: 'USDT0',
    version: '1',
    chainId: 9745,
    verifyingContract: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb'
  }
  const tipos = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }
    ]
  }
  const valor = {
    from: await cuenta.getAddress(),
    to: '0x0000000000000000000000000000000000000001',
    value: 1000n,
    validAfter: 0n,
    validBefore: 9999999999n,
    nonce: '0x' + '11'.repeat(32)
  }
  const fn = cuenta.signTypedData || cuenta.signTypedDataV4 || cuenta._signTypedData
  if (typeof fn !== 'function') {
    throw new Error(
      'the account does not expose signTypedData; methods: ' +
        Object.getOwnPropertyNames(Object.getPrototypeOf(cuenta)).join(',')
    )
  }
  const sig = await fn.call(cuenta, {
    domain: dominio,
    types: tipos,
    primaryType: 'TransferWithAuthorization',
    message: valor
  })
  return (typeof sig === 'string' ? sig : JSON.stringify(sig)).slice(0, 24) + '...'
})

await paso(4, 'import @x402/core and @x402/evm', async () => {
  const core = await import('@x402/core')
  const evm = await import('@x402/evm')
  return `core:${Object.keys(core).length} exports, evm:${Object.keys(evm).length}`
})

// -----------------------------------------------------------------------------
// Step 5 exists because step 4 was PASSING FOR THE WRONG REASON (2026-08-26).
//
// Step 4 runs after steps 1-3, which already imported WDK. And that's not
// incidental: `@x402/evm` does NOT import under Bare on its own.
//
// The cause is diagnosed and it's a GLOBAL, not a resolution issue: viem
// uses `TextEncoder`, Bare doesn't provide it, and WDK installs it when it
// loads.
//
//     before importing WDK:   typeof globalThis.TextEncoder === 'undefined'
//     after:                  'function'
//
// (There was also a resolution problem -- @noble/hashes picking its
// `node:crypto` variant under the packer -- that broke the BINARY. That one
// gets fixed in scripts/parche-noble-bare.js and no longer shows up here.)
//
// If step 5 fails and step 4 passes, the conclusion is NOT "it works": it's
// that it only works as long as someone loads WDK first, and that has to be
// guaranteed in the code.
// -----------------------------------------------------------------------------
await paso(5, '@x402/evm imports ALONE, with no WDK loaded beforehand', async () => {
  const { spawnSync } = await import('bare-subprocess')
  const r = spawnSync(
    Bare.argv[0],
    ['-e', "import('@x402/evm').then(m => console.log('OK ' + Object.keys(m).length))"],
    { encoding: 'utf8' }
  )
  const salida = ((r.stdout || '') + (r.stderr || '')).trim()
  if (!salida.startsWith('OK')) {
    throw new Error('does not import in isolation: ' + salida.split('\n')[0].slice(0, 120))
  }
  return salida
})
