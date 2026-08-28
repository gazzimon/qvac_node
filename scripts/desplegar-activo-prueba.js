#!/usr/bin/env node
'use strict'

// D30.3 — despliega el activo de prueba. SOLO EN TESTNET.
//
//   PYRUS_DESPLIEGUE_CLAVE=0x…  npm run desplegar-activo   -- --rpc https://testnet-rpc.plasma.to
//
// -----------------------------------------------------------------------------
// POR QUE ESTO NO ES HARDHAT NI FOUNDRY
//
// El repo no tiene Solidity ni toolchain, y no lo gana acá: lo que hay en
// `scripts/` es el **bytecode ya compilado** (`activo-prueba.artefacto.json`) y
// esto, que lo manda. La compilación pasó una vez, fuera del árbol, con `solc`
// suelto — el artefacto registra la versión exacta del compilador, los settings
// y el SHA-256 de la fuente, así que se puede repetir sin adivinar. El producto
// no se entera de que existe Solidity, que es la condición.
//
// El precio de esa decisión, dicho: recompilar no es `npm run` de nada. Si
// alguien edita `activo-prueba.sol`, el artefacto queda viejo — y por eso hay un
// test que recomputa el hash de la fuente y rompe cuando dejan de corresponder.
//
// -----------------------------------------------------------------------------
// COMO SE RECOMPILA, EXACTAMENTE
//
// Estaba escrito "con solc suelto" y eso no alcanza para repetirlo: hubo que
// adivinar una vez. La receta entera, fuera del árbol:
//
//   mkdir /tmp/solcbox && cd /tmp/solcbox && npm init -y && npm i solc@0.8.28
//
// y compilar con la interfaz STANDARD JSON, usando los tres campos que el
// artefacto ya registra — `solc`, `settings` y `claveFuente`:
//
//   {
//     "language": "Solidity",
//     "sources": { "<claveFuente>": { "content": "<el .sol entero>" } },
//     "settings": { ...<settings>, "outputSelection": { "*": { "*": [
//       "abi", "evm.bytecode.object", "evm.deployedBytecode.object" ] } } }
//   }
//
// **`claveFuente` no es cosmética y por eso se anota.** La clave con la que se
// le pasa la fuente a solc entra en el hash de metadata que el compilador pega
// al final del bytecode: la misma fuente, con la misma versión y los mismos
// settings, compila a bytecode DISTINTO si la clave cambia. Con `solc@0.8.28` y
// `claveFuente: "activo-prueba.sol"` el artefacto se reproduce byte a byte —
// comprobado, y es el control que hay que pasar ANTES de regenerarlo: si no
// reproducís el artefacto viejo, tu toolchain no es el de este archivo y lo que
// generes va a diferir por razones que no son tu cambio.
//
// El repo sigue sin ganar toolchain: `/tmp/solcbox` no es este árbol y
// `package.json` no se entera.
//
// -----------------------------------------------------------------------------
// LOS DOS GUARDIAS, Y POR QUE NO SE PUEDEN APAGAR
//
// 1. La red tiene que estar en la lista blanca de `redes-prueba.js`. Mainnet
//    está afuera por D30 y no hay flag que lo saltee.
// 2. El chainId se lee DE LA CADENA, no de lo que diga el flag `--rpc`. Un RPC
//    mal apuntado es exactamente el modo de falla contra el que sirve el guardia,
//    así que preguntarle a la cadena quién es antes de firmar nada es el orden
//    correcto.
//
// La clave de despliegue es DESECHABLE y no es la wallet de cobro del nodo:
// paga gas de faucet en una red de prueba. No se guarda, no se cifra, y no tiene
// por qué — si se filtra, lo que se pierde es XPL de testnet.

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

  const cuenta = clave.trim().startsWith('0x')
    ? cuentas.privateKeyToAccount(clave.trim())
    : cuentas.mnemonicToAccount(clave.trim())

  const publico = viem.createPublicClient({ transport: viem.http(rpcUrl) })

  // El chainId sale DE LA CADENA. Ver el encabezado: confiar en el flag es
  // confiar justo en el dato que puede estar mal.
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
    console.error('  NO SE DESPLIEGA. ' + motivo)
    console.error('')
    process.exit(1)
  }

  const red = testnetDe(chainId)
  const artefacto = JSON.parse(fs.readFileSync(ARTEFACTO, 'utf8'))

  console.log('')
  console.log(`  red        ${red.nombre} (eip155:${chainId})`)
  console.log(`  rpc        ${rpcUrl}`)
  console.log(`  desde      ${cuenta.address}`)
  console.log(`  contrato   ${artefacto.contrato} — ${artefacto.solc}`)
  console.log(`  bytecode   ${(artefacto.bytecode.length - 2) / 2} bytes`)
  console.log('')

  const saldo = await publico.getBalance({ address: cuenta.address })
  console.log(`  gas        ${viem.formatEther(saldo)} ${red.nativo}`)
  if (saldo === 0n) {
    console.error('')
    console.error(`  sin ${red.nativo} no se puede desplegar. Pedile al faucet de ${red.nombre}.`)
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
    console.error(`  el despliegue fallo: status=${recibo.status}`)
    process.exit(1)
  }
  const activo = recibo.contractAddress
  console.log(`  contrato   ${activo}`)
  if (red.explorer) console.log(`  explorer   ${red.explorer}/address/${activo}`)

  // El `mint` es abierto (ver el .sol), así que esto es una comodidad y no un
  // privilegio del que desplegó: cualquiera puede volver a llamarlo después.
  if (mintA) {
    const h = await billetera.writeContract({
      address: activo,
      abi: artefacto.abi,
      functionName: 'mint',
      args: [mintA, 1000000000000n]
    })
    await publico.waitForTransactionReceipt({ hash: h })
    console.log(`  mint       1.000.000 tUSD -> ${mintA}`)
  }

  // El `name` se lee DE LA CADENA y no de una constante de acá: es el que va a
  // entrar al dominio EIP-712 con el que se firma, así que tiene que salir del
  // mismo lugar del que lo va a leer el que verifique.
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
  console.log('  Ahora el criterio de aceptacion, que ya existia y es ejecutable:')
  console.log('')
  console.log(`    PYRUS_X402_PLASMA_TESTNET_ASSET=${activo} \\`)
  console.log(`    PYRUS_X402_PLASMA_TESTNET_NAME="${nombre}" \\`)
  console.log(`    PYRUS_X402_PLASMA_TESTNET_VERSION=${version} \\`)
  console.log('    npm run verificar-x402')
  console.log('')
  console.log('  Eso comprueba contra LA CADENA que el contrato implementa EIP-3009 y que')
  console.log('  su DOMAIN_SEPARATOR es el mismo dominio EIP-712 con el que vamos a firmar.')
  console.log('  Hasta que eso pase en verde, el activo no esta verificado.')
  console.log('')
}

main().catch((err) => {
  console.error('[desplegar-activo-prueba] ' + ((err && err.stack) || err))
  process.exit(2)
})
