#!/usr/bin/env node
'use strict'

// D30.3 — mintea el activo de prueba (tUSD) a una direccion. SOLO EN TESTNET.
//
//   PYRUS_DESPLIEGUE_CLAVE=0x…  npm run mintear-tusd -- \
//     --asset 0x…  --a 0xDirDelPagador  --monto 100
//
// -----------------------------------------------------------------------------
// POR QUE ESTO EXISTE APARTE DEL DEPLOY
//
// `desplegar-activo-prueba.js` ya tiene un `--mint-a` de comodidad, pero mintea
// un monto fijo (1.000.000 tUSD) y solo en el mismo tx del deploy. Para fondear
// al PAGADOR de un `curl` de prueba —o al agente de la Fase 11— con un monto
// elegido, contra un contrato que ya esta desplegado, hace falta esto.
//
// El `mint` del contrato es ABIERTO (ver `scripts/activo-prueba.sol`): no es un
// privilegio del que desplego. Cualquier clave con gas de faucet puede llamarlo,
// a cualquier direccion. Que sea abierto es la marca mas fuerte de que tUSD no
// es una stablecoin y no vale nada.
//
// -----------------------------------------------------------------------------
// LOS MISMOS DOS GUARDIAS QUE EL DEPLOY, Y POR EL MISMO MOTIVO
//
// 1. La red tiene que estar en la lista blanca de `redes-prueba.js`. Mainnet
//    esta afuera por D30 y no hay flag que lo saltee — mintear un "activo de
//    prueba" contra una mainnet seria desplegar teatro sobre plata real.
// 2. El chainId se lee DE LA CADENA, no del flag `--rpc`. Un RPC mal apuntado es
//    justo el modo de falla contra el que sirve el guardia.
//
// La clave es DESECHABLE (misma variable que el deploy): paga gas de faucet en
// una red de prueba. No se guarda y no se cifra — si se filtra, se pierde XPL de
// testnet.

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

// "100" o "100.5" (dolares) -> unidades minimas del token, con SUS decimales
// leidos de la cadena. Entero exacto, sin `Number` de por medio: un monto con el
// que se firma no puede pasar por un float.
function aUnidades(montoStr, decimals) {
  const m = String(montoStr).trim()
  if (!/^\d+(\.\d+)?$/.test(m)) throw new Error(`--monto invalido: ${JSON.stringify(montoStr)}`)
  const [entero, frac = ''] = m.split('.')
  if (frac.length > decimals) {
    throw new Error(`--monto tiene mas de ${decimals} decimales, que es la precision de tUSD`)
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
    console.error(`  falta ${VAR_CLAVE}.`)
    console.error('')
    console.error('  Es una clave DESECHABLE de testnet, con gas del faucet. NO es la wallet')
    console.error('  de cobro del nodo y no se guarda en ningun lado.')
    console.error('')
    console.error('    node -e "console.log(require(\'viem/accounts\').generatePrivateKey())"')
    console.error('')
    console.error(`  Despues pedile ${testnetDe(9746).nativo} al faucet para esa direccion.`)
    console.error('')
    process.exit(1)
  }

  if (!asset || !/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    console.error('')
    console.error(`  falta el contrato del activo. Pasalo con --asset 0x… o exporta ${VAR_ASSET}.`)
    console.error('  Es la direccion que imprimio `npm run desplegar-activo`.')
    console.error('')
    process.exit(1)
  }

  const a = flag('a', null)
  const cuenta = clave.trim().startsWith('0x')
    ? cuentas.privateKeyToAccount(clave.trim())
    : cuentas.mnemonicToAccount(clave.trim())
  const destino = a || cuenta.address
  if (!/^0x[0-9a-fA-F]{40}$/.test(destino)) {
    console.error(`  --a no es una direccion EVM: ${JSON.stringify(destino)}`)
    process.exit(1)
  }

  const publico = viem.createPublicClient({ transport: viem.http(rpcUrl) })

  // El chainId sale DE LA CADENA (ver el encabezado).
  let chainId
  try {
    chainId = await publico.getChainId()
  } catch (err) {
    console.error(`  el RPC ${rpcUrl} no responde: ${(err && err.message) || err}`)
    process.exit(1)
  }

  const motivo = porQueNoSeEstrena(chainId)
  if (motivo) {
    console.error('')
    console.error('  NO SE MINTEA. ' + motivo)
    console.error('')
    process.exit(1)
  }

  const red = testnetDe(chainId)
  const artefacto = JSON.parse(fs.readFileSync(ARTEFACTO, 'utf8'))

  // Los decimales salen de la cadena, no de una constante de acá: es el numero
  // con el que se escala el monto, y tiene que venir del mismo lugar que lo lee
  // todo el resto.
  const decimals = Number(
    await publico.readContract({ address: asset, abi: artefacto.abi, functionName: 'decimals' })
  )
  const monto = aUnidades(montoStr, decimals)

  console.log('')
  console.log(`  red        ${red.nombre} (eip155:${chainId})`)
  console.log(`  rpc        ${rpcUrl}`)
  console.log(`  activo     ${asset}`)
  console.log(`  desde      ${cuenta.address}`)
  console.log(`  a          ${destino}`)
  console.log(`  monto      ${montoStr} tUSD  (${monto} unidades, ${decimals} decimales)`)
  console.log('')

  const saldoGas = await publico.getBalance({ address: cuenta.address })
  console.log(`  gas        ${viem.formatEther(saldoGas)} ${red.nativo}`)
  if (saldoGas === 0n) {
    console.error('')
    console.error(
      `  sin ${red.nativo} no se puede firmar el mint. Pedile al faucet de ${red.nombre}.`
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
    console.error(`  el mint fallo: status=${recibo.status}`)
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
  console.log(`    antes    ${antes} unidades`)
  console.log(`    despues  ${despues} unidades  (+${despues - antes})`)
  if (red.explorer) console.log(`  explorer   ${red.explorer}/tx/${hash}`)
  console.log('')
}

main().catch((err) => {
  console.error('[mintear-tusd] ' + ((err && err.stack) || err))
  process.exit(2)
})
