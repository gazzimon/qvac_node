// Spike de D11 — ¿corren WDK y x402 bajo Bare, o hace falta un worklet?
//
// RESULTADO (2026-08-25): SI, directo. Los cuatro pasos pasan bajo Bare sin
// shim ni worklet, y la firma EIP-3009 sale byte a byte identica a la de Node.
// Eso ultimo no lo buscaba el spike y vale mas que el si: descarta que dos
// maquinas del swarm con runtimes distintos puedan firmar autorizaciones
// distintas.
//
// SE GUARDA PARA REPETIRLO, no como documentacion de algo ya cerrado: la
// respuesta vale para las versiones de HOY de wdk-wallet-evm y @x402/*. Cuando
// alguna suba de major, esto se vuelve a correr antes de asumir que sigue
// andando.
//
//   npm install @tetherto/wdk-wallet-evm @x402/core @x402/evm
//   node scripts/spike-d11-wdk-bare.mjs     # control
//   bare scripts/spike-d11-wdk-bare.mjs     # la pregunta real
//
// NO instala nada ni toca el arbol del proyecto: se corre en un directorio
// aparte con esas tres dependencias. Estan fuera del package.json a proposito
// mientras la Fase 7 no las use de verdad.
//
// Cada paso reporta solo y no corta a los siguientes: interesa saber CUAL
// falla, no que el primer fallo tape al resto.
const paso = async (n, nombre, fn) => {
  try {
    const r = await fn()
    console.log(`OK   ${n}. ${nombre}${r ? ' -> ' + r : ''}`)
    return true
  } catch (e) {
    console.log(`FALL ${n}. ${nombre}`)
    console.log(`     ${(e && e.message ? e.message : e).toString().split('\n')[0]}`)
    return false
  }
}

// Seed de prueba publica y conocida. No se fondea nunca.
const SEED = 'test test test test test test test test test test test junk'

let WalletManagerEvm = null
let cuenta = null

await paso(1, 'import @tetherto/wdk-wallet-evm', async () => {
  const m = await import('@tetherto/wdk-wallet-evm')
  WalletManagerEvm = m.default || m
  return typeof WalletManagerEvm
})

await paso(2, 'derivar una cuenta desde la seed', async () => {
  const wm = new WalletManagerEvm(SEED, { provider: 'https://rpc.plasma.to' })
  cuenta = await wm.getAccount()
  const addr = await cuenta.getAddress()
  return addr
})

await paso(3, 'firmar EIP-3009 transferWithAuthorization OFFLINE', async () => {
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
      'la cuenta no expone signTypedData; metodos: ' +
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

await paso(4, 'import @x402/core y @x402/evm', async () => {
  const core = await import('@x402/core')
  const evm = await import('@x402/evm')
  return `core:${Object.keys(core).length} exports, evm:${Object.keys(evm).length}`
})
