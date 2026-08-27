#!/usr/bin/env node
'use strict'

// ¿Se puede cobrar por x402 hoy, y en qué red? Todo de SOLO LECTURA.
//
//   npm run verificar-x402
//
// -----------------------------------------------------------------------------
// POR QUE EXISTE
//
// El DoD de la Fase 9 pide un tx hash en un explorer. Antes de fondear una
// wallet para ir a buscarlo hay que saber si el camino a la cadena existe, y esa
// pregunta tiene TRES partes que se rompen por separado:
//
//   1. la cadena responde y es la que decimos que es (chainId);
//   2. hay un ERC-20 con EIP-3009 en la dirección con la que vamos a cobrar, y
//      el dominio EIP-712 con el que FIRMAMOS es el que ese contrato VALIDA;
//   3. hay un facilitator vivo que soporte esa red.
//
// Las tres se contestan sin mover un peso. Descubrir la (3) DESPUES de fondear
// es gastar plata real para enterarse de que no había a quién pedirle el
// settlement — que es exactamente lo que estuvo a punto de pasar: el hosted de
// D14 (`x402.semanticpay.io`) devolvía 500/503 en todos sus endpoints el
// 2026-08-27, y un test que le pegó sin querer "pasó" igual porque el recibo se
// guarda aunque la liquidación falle.
//
// La (2) es la que más callado falla. `version` NO se puede leer del contrato en
// todos los casos —el USD₮0 de Plasma revierte en `version()`— pero el
// `DOMAIN_SEPARATOR` sí se lee, y comparar el que devuelve el contrato contra el
// que computamos con nuestros valores prueba la igualdad sin necesitar el
// getter. Es más fuerte que leer el campo.
//
// -----------------------------------------------------------------------------
// TAMBIEN ES EL CRITERIO DE ACEPTACION DEL TOKEN QUE VAMOS A DESPLEGAR
//
// En Plasma testnet (9746) no hay stablecoin: los faucets dan sólo XPL, que es
// gas y no tiene contrato. Así que el activo con el que se pruebe hay que
// desplegarlo. Cuando exista, se apunta acá con:
//
//   PYRUS_X402_PLASMA_TESTNET_ASSET=0x… npm run verificar-x402
//
// y esto dice si quedó bien: si implementa EIP-3009 y si su dominio coincide con
// el que vamos a firmar. Un token de prueba que pasa estos chequeos es
// intercambiable con el de mainnet para todo lo que el gateway hace.

const https = require('https')
const http = require('http')

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

// El mismo nombre de variable que lee `qvac/x402.mjs`, para poder apuntar los
// dos al mismo lado sin pensarlo dos veces.
const VAR_FACILITATOR = 'PYRUS_X402_FACILITATOR'
const FACILITATOR_DEFAULT = 'https://x402.semanticpay.io'

// OJO: esta tabla duplica lo que `qvac/x402.mjs` declara, y lo hace a propósito.
// Ese módulo corre bajo Bare (importa `bare-env`) y esto corre bajo node, así
// que no se puede importar. Si divergen, este script miente — por eso compara
// contra la CADENA y no contra sí mismo: un valor mal copiado acá se delata en
// el `DOMAIN_SEPARATOR`, no pasa desapercibido.
const REDES = [
  {
    nombre: 'plasma',
    caip2: 'eip155:9745',
    rpc: 'https://rpc.plasma.to',
    explorer: 'https://plasmascan.to',
    activo: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    dominio: { name: 'USDT0', version: '1' },
    rol: 'default de D15 — MAINNET, plata real'
  },
  {
    nombre: 'plasma-testnet',
    caip2: 'eip155:9746',
    rpc: 'https://testnet-rpc.plasma.to',
    explorer: 'https://testnet.plasmascan.to',
    // No hay stablecoin desplegada: se declara por variable cuando exista.
    activo: process.env.PYRUS_X402_PLASMA_TESTNET_ASSET || null,
    dominio: {
      name: process.env.PYRUS_X402_PLASMA_TESTNET_NAME || null,
      version: process.env.PYRUS_X402_PLASMA_TESTNET_VERSION || '1'
    },
    rol: 'donde se prueba — regla del proyecto: nunca se estrena en mainnet'
  },
  {
    nombre: 'stable',
    caip2: 'eip155:988',
    rpc: null, // sin RPC público conocido en este árbol; se chequea sólo la tabla de x402
    explorer: null,
    activo: null,
    dominio: null,
    rol: 'fallback de D15 — lo conoce @x402/evm de fábrica'
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
            reject(new Error(`respuesta no-JSON (HTTP ${res.statusCode}): ${d.slice(0, 120)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('timeout de 20s')))
    req.write(cuerpo)
    req.end()
  })
}

// Un string ABI-encodeado. Los tokens viejos devuelven bytes32 en vez de string,
// así que se contempla el caso corto en vez de devolver basura.
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
  // authorizationState(address,bytes32) — si esto NO revierte, el contrato
  // implementa EIP-3009, que es el esquema `exact` de x402.
  authorizationState: '0xe94a0102'
}

async function llamar(url, to, data) {
  const r = await rpc(url, 'eth_call', [{ to, data }, 'latest'])
  if (r.error) return { error: r.error.message }
  return { valor: r.result }
}

// -----------------------------------------------------------------------------
// Los chequeos
// -----------------------------------------------------------------------------

const ok = (s) => '  ✓ ' + s
const no = (s) => '  ✗ ' + s
const dato = (s) => '    ' + s

async function verificarRed(red, viem) {
  const lineas = []
  let usable = false

  if (!red.rpc) {
    lineas.push(dato('sin RPC en esta tabla; no se puede verificar contra la cadena desde acá'))
    return { lineas, usable: null }
  }

  // 1. La cadena es la que decimos.
  let chainId = null
  try {
    const r = await rpc(red.rpc, 'eth_chainId', [])
    chainId = parseInt(r.result, 16)
  } catch (err) {
    lineas.push(no(`el RPC no responde: ${err.message}`))
    return { lineas, usable: false }
  }

  const esperado = Number(red.caip2.split(':')[1])
  if (chainId !== esperado) {
    lineas.push(no(`el RPC dice chainId ${chainId} y la config declara ${esperado}`))
    return { lineas, usable: false }
  }
  lineas.push(ok(`chainId ${chainId} — coincide con ${red.caip2}`))

  // 2. El activo.
  if (!red.activo) {
    lineas.push(no('no hay activo declarado: no hay con qué cobrar en esta red'))
    if (red.nombre === 'plasma-testnet') {
      lineas.push(dato('los faucets dan XPL, que es gas nativo y no tiene contrato'))
      lineas.push(dato('cuando se despliegue uno: PYRUS_X402_PLASMA_TESTNET_ASSET=0x…'))
    }
    return { lineas, usable: false }
  }

  const code = await rpc(red.rpc, 'eth_getCode', [red.activo, 'latest'])
  if (!code.result || code.result === '0x') {
    lineas.push(no(`no hay contrato en ${red.activo}`))
    return { lineas, usable: false }
  }
  lineas.push(ok(`contrato en ${red.activo} (${(code.result.length - 2) / 2} bytes)`))

  const nombre = leerString((await llamar(red.rpc, red.activo, SEL.name)).valor)
  const simbolo = leerString((await llamar(red.rpc, red.activo, SEL.symbol)).valor)
  const dec = await llamar(red.rpc, red.activo, SEL.decimals)
  const decimals = dec.valor ? parseInt(dec.valor, 16) : null
  lineas.push(
    dato(`name=${JSON.stringify(nombre)} symbol=${JSON.stringify(simbolo)} decimals=${decimals}`)
  )

  // 3. EIP-3009. Sin esto el esquema `exact` de x402 no tiene sobre qué firmar.
  const auth = await llamar(
    red.rpc,
    red.activo,
    SEL.authorizationState +
      '0'.repeat(24) +
      'f39fd6e51aad88f6f4ce6ab8827279cfffb92266' +
      '00'.repeat(32)
  )
  if (auth.error) {
    lineas.push(no(`NO implementa EIP-3009 (authorizationState revierte: ${auth.error})`))
    return { lineas, usable: false }
  }
  lineas.push(ok('implementa EIP-3009 (authorizationState responde)'))

  // 4. El dominio EIP-712 con el que FIRMAMOS es el que el contrato VALIDA.
  //    Es el chequeo que más callado falla y el único que prueba que la firma
  //    va a verificar del otro lado.
  const ds = await llamar(red.rpc, red.activo, SEL.DOMAIN_SEPARATOR)
  if (!ds.valor || ds.error) {
    lineas.push(dato('el contrato no expone DOMAIN_SEPARATOR: no se puede comparar el dominio'))
    usable = true
  } else if (!red.dominio || !red.dominio.name) {
    lineas.push(dato(`DOMAIN_SEPARATOR on-chain: ${ds.valor}`))
    lineas.push(
      dato(
        'sin `name` declarado no se puede comparar — declaralo con PYRUS_X402_PLASMA_TESTNET_NAME'
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
          `el dominio EIP-712 coincide (name="${red.dominio.name}" version="${red.dominio.version}")`
        )
      )
      usable = true
    } else {
      lineas.push(no('el dominio EIP-712 NO coincide: una firma nuestra no verificaría'))
      lineas.push(dato(`  computado: ${computado}`))
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
    lineas.push(ok('responde /supported'))
    lineas.push(dato(JSON.stringify(kinds).slice(0, 600)))
    return { lineas, vivo: true, kinds }
  } catch (err) {
    lineas.push(no(`no responde: ${String((err && err.message) || err).slice(0, 200)}`))
    lineas.push(
      dato('sin facilitator NO hay settlement: se puede verificar un pago, no cobrarlo (D12)')
    )
    lineas.push(dato('el plan B ya está escrito: D14(b), self-hosted — riesgo #5'))
    return { lineas, vivo: false, kinds: null }
  }
}

// -----------------------------------------------------------------------------

async function main() {
  const viem = require('viem')
  const facilitator = process.env[VAR_FACILITATOR] || FACILITATOR_DEFAULT

  console.log('')
  console.log('  x402 — se puede cobrar hoy?   (todo de solo lectura, no mueve fondos)')
  console.log('  ' + '-'.repeat(70))

  console.log('')
  console.log(`  FACILITATOR  ${facilitator}`)
  if (facilitator === FACILITATOR_DEFAULT) {
    console.log(dato(`(el default de D14; se cambia con ${VAR_FACILITATOR})`))
  }
  const fac = await verificarFacilitator(facilitator)
  for (const l of fac.lineas) console.log(l)

  const usables = []
  for (const red of REDES) {
    console.log('')
    console.log(`  RED  ${red.nombre}  (${red.caip2})`)
    console.log(dato(red.rol))
    const r = await verificarRed(red, viem)
    for (const l of r.lineas) console.log(l)
    if (r.usable) usables.push(red.nombre)
  }

  console.log('')
  console.log('  ' + '-'.repeat(70))
  if (usables.length === 0) {
    console.log('  RESULTADO: ninguna red con activo verificado. No hay con qué cobrar.')
  } else {
    console.log(`  RESULTADO: activo verificado en ${usables.join(', ')}.`)
  }
  if (!fac.vivo) {
    console.log('  Y NO hay facilitator: aunque el activo esté bien, el settlement no ocurre.')
  }
  console.log('')

  // Sale distinto de cero cuando NO hay un camino completo a la cadena. Es la
  // pregunta que el script existe para contestar, y hay que poder encadenarla.
  process.exit(fac.vivo && usables.length > 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[verificar-x402] ' + ((err && err.stack) || err))
  process.exit(2)
})
