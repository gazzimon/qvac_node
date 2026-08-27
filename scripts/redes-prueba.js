'use strict'

// D30 — dónde se puede estrenar algo que mueve valor, y dónde no.
//
// -----------------------------------------------------------------------------
// POR QUE ES UNA LISTA BLANCA Y NO UNA LISTA NEGRA
//
// D30 dice "todo camino que mueva valor se estrena en testnet, sin excepción".
// Una lista negra de mainnets cumple eso hasta el día que aparece una cadena que
// nadie anotó — y el modo de falla de esa omisión es desplegar en una red con
// plata real creyendo que era de prueba. Con lista blanca, la omisión falla
// hacia el lado correcto: una testnet que falta se agrega acá con su nombre, y
// mientras tanto NO se despliega nada.
//
// Y no hay variable de entorno que lo saltee, a propósito. D30 no dice "salvo
// que el operador confirme": dice sin excepción. Una vez que el camino funcionó
// en 9746, promocionar a mainnet es un cambio de código con revisión, no un flag
// que alguien exporta a las tres de la mañana.
//
// -----------------------------------------------------------------------------
// ESTE ARCHIVO CORRE BAJO NODE **Y** BAJO BARE
//
// Los scripts (`desplegar-activo-prueba.js`, `facilitator.js`) son Node; la
// suite corre bajo `brittle-bare`. Por eso es CommonJS sin un solo `require`:
// así el test puede cargarlo y comparar esta tabla contra la de
// `qvac/wallet.mjs`, que es la duplicación que de verdad hace daño si se
// desincroniza — una red que acá es testnet y allá es mainnet.

// Las redes de prueba conocidas. `nativo` es el gas que hay que conseguir del
// faucet: sin gas nativo el facilitator no puede difundir la transacción, que es
// la mitad de D30.4 que se olvida.
const TESTNETS = {
  9746: {
    nombre: 'plasma-testnet',
    caip2: 'eip155:9746',
    rpc: 'https://testnet-rpc.plasma.to',
    explorer: 'https://testnet.plasmascan.to',
    nativo: 'XPL'
  },
  11155111: {
    nombre: 'sepolia',
    caip2: 'eip155:11155111',
    rpc: null,
    explorer: 'https://sepolia.etherscan.io',
    nativo: 'ETH'
  },
  84532: {
    nombre: 'base-sepolia',
    caip2: 'eip155:84532',
    rpc: null,
    explorer: 'https://sepolia.basescan.org',
    nativo: 'ETH'
  },
  31337: {
    nombre: 'local',
    caip2: 'eip155:31337',
    rpc: 'http://127.0.0.1:8545',
    explorer: null,
    nativo: 'ETH (de mentira)'
  }
}

// Sólo para que el mensaje diga QUÉ es lo que se está rechazando en vez de "no
// la conozco". No es lo que decide: lo que decide es TESTNETS.
const MAINNETS_CONOCIDAS = {
  1: 'Ethereum',
  988: 'Stable (el fallback de D15)',
  9745: 'Plasma (el default de D15)'
}

// Por qué NO se puede desplegar/liquidar contra `chainId`, o `null` si se puede.
//
// Devuelve el motivo y no un booleano por lo mismo que `verifyManifest`: hay que
// poder decir en pantalla por qué se cortó, y "false" no se lee.
function porQueNoSeEstrena(chainId) {
  const id = Number(chainId)
  if (!Number.isInteger(id) || id <= 0) {
    return `chainId invalido: ${JSON.stringify(chainId)}`
  }
  if (TESTNETS[id]) return null
  const conocida = MAINNETS_CONOCIDAS[id]
  if (conocida) {
    return (
      `chainId ${id} es ${conocida}: MAINNET. D30 decide que ningun camino que ` +
      'mueva valor se estrena ahi, y no hay flag que lo saltee'
    )
  }
  return (
    `chainId ${id} no esta en la lista de testnets conocidas. Si es una testnet, ` +
    'agregala a TESTNETS en scripts/redes-prueba.js con su nombre y su faucet — ' +
    'D30 no se saltea con una variable de entorno'
  )
}

function testnetDe(chainId) {
  return TESTNETS[Number(chainId)] || null
}

module.exports = { TESTNETS, MAINNETS_CONOCIDAS, porQueNoSeEstrena, testnetDe }
