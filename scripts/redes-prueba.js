'use strict'

// D30 — where something that moves value can have its first run, and where
// it can't.
//
// -----------------------------------------------------------------------------
// WHY THIS IS AN ALLOWLIST AND NOT A DENYLIST
//
// D30 says "every path that moves value has its first run on testnet, no
// exceptions." A denylist of mainnets satisfies that until the day a chain
// nobody wrote down shows up — and that omission's failure mode is deploying
// on a network with real money thinking it was a test one. With an
// allowlist, the omission fails toward the right side: a missing testnet
// gets added here with its name, and in the meantime NOTHING gets deployed.
//
// And there's no environment variable that skips it, on purpose. D30
// doesn't say "unless the operator confirms": it says no exceptions. Once a
// path has worked on 9746, promoting it to mainnet is a code change with
// review, not a flag someone exports at three in the morning.
//
// -----------------------------------------------------------------------------
// THIS FILE RUNS UNDER NODE **AND** UNDER BARE
//
// The scripts (`desplegar-activo-prueba.js`, `facilitator.js`) are Node;
// the suite runs under `brittle-bare`. That's why it's CommonJS with not a
// single `require`: that way the test can load it and compare this table
// against `qvac/wallet.mjs`'s, which is the duplication that actually does
// damage if it drifts out of sync — a network that's testnet here and
// mainnet there.

// The known testnets. `nativo` is the gas that has to be obtained from the
// faucet: without native gas the facilitator can't broadcast the
// transaction, which is the half of D30.4 that gets forgotten.
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
    nativo: 'ETH (fake)'
  }
}

// Only so the message says WHAT is being rejected instead of "I don't know
// it." Not what decides: what decides is TESTNETS.
const MAINNETS_CONOCIDAS = {
  1: 'Ethereum',
  988: 'Stable (D15\'s fallback)',
  9745: 'Plasma (D15\'s default)'
}

// Why `chainId` CANNOT be deployed/settled against, or `null` if it can.
//
// Returns the reason and not a boolean for the same reason as
// `verifyManifest`: it has to be possible to say on screen why it was cut
// off, and "false" doesn't read.
function porQueNoSeEstrena(chainId) {
  const id = Number(chainId)
  if (!Number.isInteger(id) || id <= 0) {
    return `invalid chainId: ${JSON.stringify(chainId)}`
  }
  if (TESTNETS[id]) return null
  const conocida = MAINNETS_CONOCIDAS[id]
  if (conocida) {
    return (
      `chainId ${id} is ${conocida}: MAINNET. D30 decides no path that ` +
      'moves value gets its first run there, and no flag skips it'
    )
  }
  return (
    `chainId ${id} is not in the list of known testnets. If it is a testnet, ` +
    'add it to TESTNETS in scripts/redes-prueba.js with its name and its faucet — ' +
    'D30 is not skipped with an environment variable'
  )
}

function testnetDe(chainId) {
  return TESTNETS[Number(chainId)] || null
}

module.exports = { TESTNETS, MAINNETS_CONOCIDAS, porQueNoSeEstrena, testnetDe }
