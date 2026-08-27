#!/usr/bin/env node
'use strict'

// D14(b) / D30.4 — el facilitator self-hosted. Tres endpoints y una wallet con gas.
//
//   PYRUS_FACILITATOR_CLAVE=0x…  PYRUS_X402_PLASMA_TESTNET_ASSET=0x…  npm run facilitator
//
// y del otro lado, el nodo:
//
//   PYRUS_X402_FACILITATOR=http://127.0.0.1:8402  npm run serve
//
// -----------------------------------------------------------------------------
// POR QUE DEJA DE SER PLAN B
//
// D14 eligió el hosted de Semantic "hasta la Fase 10". D30 lo adelantó por dos
// hechos, no por preferencia: el hosted devolvía 500/503 en TODOS sus endpoints
// el 2026-08-27, y no soporta 9746 — y menos va a conocer un token que
// desplegamos nosotros. Sin esto, D30 se puede escribir pero no demostrar.
//
// -----------------------------------------------------------------------------
// ESTO ES NODE, NO BARE, Y NO ENTRA AL BINARIO. NO VIOLA D11.
//
// Conviene dejarlo escrito porque parece que sí: D11 decide el runtime de la
// wallet DENTRO DEL BINARIO QUE SE DISTRIBUYE. Un facilitator ya es hoy un
// servicio remoto — el nodo le habla por HTTP y nada más. Self-hostearlo cambia
// un servicio remoto por uno local; no mete una línea nueva adentro del binario.
// Vive en `scripts/`, que `package.json:files` no publica y que `pear.stage`
// ignora, así que la separación es mecánica y no una promesa.
//
// -----------------------------------------------------------------------------
// SU WALLET ES OTRA WALLET, Y NECESITA GAS
//
// El facilitator DIFUNDE la transacción, así que paga gas nativo. En testnet sale
// del faucet y es gratis. Es una wallet **distinta** de la de cobro del nodo:
//
//   - la del nodo (D13) cobra, vive cifrada en el keystore, y su seed no sale
//     nunca del proceso que la abre;
//   - esta gasta gas de faucet en una red de prueba, es desechable, y si se
//     filtra lo que se pierde es XPL sin valor.
//
// Mezclarlas sería darle a un servicio HTTP la llave de la plata, para ahorrarse
// una línea de configuración.
//
// -----------------------------------------------------------------------------
// SIN DEPENDENCIAS NUEVAS
//
// El camino de referencia (SemanticPay/x402-usdt0-demo) usa Express y el adapter
// `@semanticio/wdk-wallet-evm-x402-facilitator`. Acá no hace falta ninguno de los
// dos y meterlos costaría caro:
//
//   - ese adapter fija `@x402/evm@2.2.0` y `@tetherto/wdk-wallet-evm@1.0.0-beta.7`,
//     y este árbol corre 2.23.0 y beta.17. Instalarlo dejaría DOS copias de
//     `@x402/evm` en el mismo proceso, y la que arma el 402 no sería la que lo
//     liquida. Es la clase de divergencia silenciosa que este repo persigue.
//   - `@x402/evm` 2.23 ya exporta `toFacilitatorEvmSigner`, que es exactamente lo
//     que ese adapter hacía: envolver un signer para el rol de facilitator.
//   - los tres endpoints son un `http.createServer` de 40 líneas.
//
// Resultado: `viem`, `@x402/core` y `@x402/evm` — los tres ya estaban en el
// árbol. El facilitator no agrega ni una dependencia.

const http = require('http')
const { porQueNoSeEstrena, testnetDe } = require('./redes-prueba.js')

const VAR_CLAVE = 'PYRUS_FACILITATOR_CLAVE'
const VAR_PUERTO = 'PYRUS_FACILITATOR_PUERTO'
const VAR_RPC = 'PYRUS_FACILITATOR_RPC'
const VAR_CHAIN = 'PYRUS_FACILITATOR_CHAINID'
const PUERTO_DEFAULT = 8402

// La red por default es la de D30: 9746. No hay default de mainnet acá ni
// escondido en un `||`, que es donde ese tipo de default se cuela.
const CHAIN_DEFAULT = 9746

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let crudo = ''
    req.on('data', (c) => {
      crudo += c
      // Un facilitator es un endpoint público de un nodo que además tiene GPU.
      // Un POST infinito no puede ser una forma de tirarlo.
      if (crudo.length > 1_000_000) req.destroy(new Error('cuerpo demasiado grande'))
    })
    req.on('end', () => {
      try {
        resolve(crudo ? JSON.parse(crudo) : {})
      } catch (err) {
        reject(new Error('el cuerpo no es JSON'))
      }
    })
    req.on('error', reject)
  })
}

// `arrancar` devuelve el server ya escuchando en vez de terminar el proceso, para
// que el test lo pueda levantar y bajar. `main` es el que corta con exit code.
async function arrancar({ chainId, rpcUrl, clave, puerto, host = '127.0.0.1' }) {
  const viem = require('viem')
  const cuentas = require('viem/accounts')
  const { x402Facilitator } = require('@x402/core/facilitator')
  const { registerExactEvmScheme } = require('@x402/evm/exact/facilitator')
  const { toFacilitatorEvmSigner } = require('@x402/evm')

  // EL GUARDIA DE D30, ANTES DE CONSTRUIR NADA. Un facilitator liquida: es
  // literalmente el componente que mueve valor, así que si hay un solo lugar
  // donde esta comprobación no puede faltar, es éste.
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

  // `toFacilitatorEvmSigner` pide UN objeto con las lecturas, las escrituras y la
  // espera de recibo. Se compone de los dos clientes de viem: el público lee, el
  // de billetera escribe. Es la misma pieza que el adapter de SemanticPay armaba
  // a mano, ya provista por el paquete.
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
  // `networks` es un parámetro, y por eso 9746 —que ningún facilitator hosted
  // conoce— entra sin tocar el paquete.
  registerExactEvmScheme(facilitator, { networks: [red.caip2], signer })

  // `registerExactEvmScheme` NO registra sólo lo que le pedimos: adentro llama a
  // `facilitator.registerV1(NETWORKS, …)` con su propia lista de fábrica, que
  // trae `ethereum`, `base`, `avalanche` y demás. O sea que un `/supported`
  // crudo anuncia MAINNETS que este proceso no puede servir —el signer y el RPC
  // están en 9746— y que D30 dice que no se tocan.
  //
  // Anunciar algo que no se puede cumplir es el modo de falla que este bloque
  // entero existe para evitar: alguien lee `/supported`, ve `base`, y manda un
  // pago que nadie va a liquidar. Así que se filtra a la red configurada, y
  // `verify`/`settle` rechazan cualquier otra ANTES de mirar la firma.
  const soloNuestraRed = (soportado) => {
    const kinds = ((soportado && soportado.kinds) || []).filter((k) => k.network === red.caip2)
    return { ...soportado, kinds }
  }

  const redEquivocada = (cuerpo) => {
    const n = cuerpo && cuerpo.paymentPayload && cuerpo.paymentPayload.network
    if (!n || n === red.caip2) return null
    return `este facilitator sirve ${red.caip2} y el pago dice ${n}`
  }

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
    try {
      if (req.method === 'GET' && ruta === '/supported') {
        return responder(res, 200, soloNuestraRed(await facilitator.getSupported()))
      }
      if (req.method === 'POST' && ruta === '/verify') {
        const c = await leerCuerpo(req)
        const mal = redEquivocada(c)
        if (mal) return responder(res, 200, { isValid: false, invalidReason: mal })
        return responder(
          res,
          200,
          await facilitator.verify(c.paymentPayload, c.paymentRequirements)
        )
      }
      if (req.method === 'POST' && ruta === '/settle') {
        const c = await leerCuerpo(req)
        const mal = redEquivocada(c)
        if (mal) {
          return responder(res, 200, {
            success: false,
            errorReason: 'unsupported_network',
            errorMessage: mal,
            transaction: '',
            network: (c.paymentPayload && c.paymentPayload.network) || null
          })
        }
        return responder(
          res,
          200,
          await facilitator.settle(c.paymentPayload, c.paymentRequirements)
        )
      }
      return responder(res, 404, { error: 'no existe: ' + req.method + ' ' + ruta })
    } catch (err) {
      const message = (err && err.message) || String(err)
      console.error(`[facilitator] ${req.method} ${ruta}: ${message}`)
      // Un error se contesta ESTRUCTURADO y no con un 500 pelado: del otro lado
      // hay un gateway que ya sirvió los tokens y necesita poder registrar por
      // qué no se liquidó. Un 500 sin cuerpo se convierte en "settlement_failed"
      // sin motivo, que es justo lo que D12 pide no perder.
      return responder(res, 200, {
        success: false,
        isValid: false,
        errorReason: 'facilitator_error',
        errorMessage: message
      })
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
    console.error(`  falta ${VAR_CLAVE}.`)
    console.error('')
    console.error('  Es la wallet del FACILITATOR: paga el gas de difundir la transaccion, y')
    console.error('  NO es la wallet de cobro del nodo. En testnet el gas sale del faucet.')
    console.error('')
    console.error('    node -e "console.log(require(\'viem/accounts\').generatePrivateKey())"')
    console.error('')
    process.exit(1)
  }
  if (!rpcUrl) {
    console.error(`  no hay RPC para chainId ${chainId}: ponelo en ${VAR_RPC}`)
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
  console.log(`  red          ${vivo.red.nombre} (${vivo.red.caip2})`)
  console.log(`  rpc          ${rpcUrl}`)
  console.log(`  wallet       ${vivo.cuenta.address}   <- necesita ${vivo.red.nativo} del faucet`)
  console.log('')
  console.log('  Del otro lado, el nodo:')
  console.log(`    PYRUS_X402_FACILITATOR=${vivo.url}`)
  console.log('')

  // El saldo se mira DESPUES de levantar, y no corta el arranque: /supported y
  // /verify funcionan sin un centavo. El unico que necesita gas es /settle, y
  // avisar temprano evita descubrirlo con un request ya servido encima.
  try {
    const saldo = await vivo.publico.getBalance({ address: vivo.cuenta.address })
    if (saldo === 0n) {
      console.log(`  AVISO: la wallet no tiene ${vivo.red.nativo}. /verify anda; /settle no va a`)
      console.log('         poder difundir nada hasta que el faucet la fondee.')
      console.log('')
    }
  } catch {
    console.log('  AVISO: no se pudo leer el saldo (el RPC no contesto). /settle puede fallar.')
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
