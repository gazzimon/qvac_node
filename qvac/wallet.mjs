// The node's PAYOUT wallet. Phase 7 of ROADMAP_FASE7-X402 (D13, D15).
//
// -----------------------------------------------------------------------------
// THESE ARE TWO DIFFERENT KEYS, AND THAT'S WHY THIS FILE EXISTS
//
// `identity.mjs` holds the NETWORK key: the Ed25519 key the node uses to sign
// its manifest and present itself on the swarm. It lives IN THE CLEAR in
// `identity.json`, and for what it's for that's fine: compromising it lets
// someone impersonate a node, not steal money.
//
// This is the PAYOUT identity. The frozen schema already declared them
// separate (manifest-v0.json:84), and D13 decides that separation **also
// exists on disk**: its own seed, never derived from the network one, and
// encrypted at rest.
//
// The signed manifest is exactly what ties one to the other: a consumer
// verifies the signature with the network key and, if it validates, knows
// THAT node declared THAT payout address.
//
// -----------------------------------------------------------------------------
// WHY A MNEMONIC AND NOT THE 32-BYTE SEED WE ALREADY KNOW HOW TO STORE
//
// It's not a preference: WDK doesn't accept anything else. `new
// WalletManagerEvm(hex)` fails with "The seed phrase is invalid" — only a
// BIP-39 mnemonic goes in. And WDK doesn't export anything to generate one
// with either, so generating it is on us.
//
// `bip39` doesn't work under Bare (it imports `node:crypto`, R1). `@scure/bip39`
// does, with one caveat: its `generateMnemonic` uses `crypto.getRandomValues`,
// which Bare doesn't have. Not needed — `entropyToMnemonic` accepts OUR
// entropy, and cryptographic randomness is already in the tree. All of this is
// verified in `scripts/spike-d13-wallet-bare.mjs`, which gets re-run whenever
// WDK bumps its version (it's still in beta).
//
// -----------------------------------------------------------------------------
// THE HONEST LIMIT OF WHAT THIS ENCRYPTION PROTECTS
//
// The passphrase comes from an environment variable, typically set in the
// working directory's `.env`. If that `.env` lives next to the keystore, then
// **the encryption protects against a backup, a repo, or a `pear stage` — not
// against someone who already has access to that machine**. That's a decision
// made with eyes open: the alternative — prompting for it on the console at
// every startup — breaks unattended startup and the "double-click and it opens
// in the browser" promise.
//
// It's stated here, in the README, and in `.env.example`, rather than letting
// someone assume "encrypted at rest" means more than it actually means.
//
// -----------------------------------------------------------------------------
// FAIL CLOSED
//
// A wrong passphrase CANNOT return garbage: it would derive a DIFFERENT
// address, and the node would announce a wallet it doesn't control in a signed
// manifest — i.e. it would tell people to pay an address nobody holds the key
// to. `crypto_secretbox_open_easy` authenticates before decrypting, so that
// doesn't happen: either it opens what was stored, or it doesn't open at all.

// -----------------------------------------------------------------------------
// D30.1 / D30.2 — PHASE 7 WAS REOPENED HERE, AND CLOSED AGAIN
//
// This file is surface area from Phase 7, which was closed. D30 reopened it
// for two of its own preconditions that couldn't be met from outside:
//
//   D30.1  the keystore can't live in %TEMP% -> `directorioKeystore`
//   D30.2  the RPC has to be configurable    -> `REDES` / `redDe` / `abrir({rpc})`
//
// What did NOT change: the file format (VERSION is still 1), the derivation,
// the encryption, or the invariant that the seed never leaves the process that
// opens it. A keystore written before this still opens the same way.

import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import sodium from 'sodium-native'
import * as bip39 from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

// Bumped whenever the file's shape changes. One from another version doesn't
// open halfway: it warns and stops, because here "halfway" means a wrong
// payout address.
const VERSION = 1

const ARCHIVO = 'wallet.json'

// D15 — Plasma default, Stable fallback. Both identifiers pass the schema's
// kebab-case pattern UNCHANGED, which was D2's condition.
//
// NOTE: Plasma is NOT a testnet. It's real money, and the risk is bounded by
// amount (roadmap risk #2), not by environment.
export const CHAINS = ['plasma', 'stable']

// The settlement mode this node offers today. `batch-receipts` is what Phase
// 10 implements; Phase 9 charges with `exact` per request and doesn't change
// this field, which describes settlement to the provider, not the charge to
// the client.
export const SETTLEMENT = 'batch-receipts'

// 256 bits of entropy -> 24 words. 24 is chosen over 12 because the cost of
// writing twelve extra words once is zero and the safety margin is real.
const ENTROPIA_BYTES = 32

// The environment variable holding the passphrase. The NAME lives here; the
// value never touches the code or the repo, same as upstream credentials.
export const VAR_PASSPHRASE = 'PYRUS_WALLET_PASSPHRASE'

// -----------------------------------------------------------------------------
// D30.2 — THE NETWORK, AND WHY A CONSTANT WASN'T ENOUGH
// -----------------------------------------------------------------------------
//
// This used to be a `RPC_DEFAULT = 'https://rpc.plasma.to'` and nothing else:
// no flag, no variable, no way to point elsewhere. `abrir()` accepted an `rpc`
// that nobody ever passed. So the node only knew how to talk to MAINNET, and
// D30 — which decides nothing gets a first run there — couldn't be honored no
// matter what.
//
// **And it's not that "the testnet is the same network with a different
// URL."** Under EIP-155 the chainId is part of what gets signed: a
// transaction signed for 9745 isn't valid on 9746 and vice versa. They're two
// different networks and there has to be a way to say which one.
//
// The default does NOT change: D15 still picks Plasma mainnet, and D30
// doesn't say the node can't point there — it says it doesn't get its FIRST
// RUN there. What changes is that it can now be chosen, and that when the
// chosen one is mainnet, startup shouts about it instead of leaving it
// implicit in a constant.
//
// THE HONEST LIMIT: `chainId` here is what the table DECLARES, not what the
// chain answers. If someone sets `PYRUS_WALLET_RPC` pointing at another
// network's RPC, this module doesn't find out — it doesn't talk to the
// network on purpose (see `cuentaDesde`). What compares the declared value
// against what the chain actually answers is `npm run verificar-x402`, which
// is why that script exists before funding.
export const REDES = {
  plasma: {
    chainId: 9745,
    caip2: 'eip155:9745',
    rpc: 'https://rpc.plasma.to',
    explorer: 'https://plasmascan.to',
    mainnet: true
  },
  'plasma-testnet': {
    chainId: 9746,
    caip2: 'eip155:9746',
    rpc: 'https://testnet-rpc.plasma.to',
    explorer: 'https://testnet.plasmascan.to',
    mainnet: false
  }
}

// D15 unchanged: Plasma mainnet is the default.
export const RED_DEFAULT = 'plasma'

export const VAR_RED = 'PYRUS_WALLET_RED'
export const VAR_RPC = 'PYRUS_WALLET_RPC'

// Which network this node uses, resolved from the environment. Pure function:
// it takes `env` instead of reading it, so it can be tested without touching
// the real process.
//
// `VAR_RPC` overrides ONLY the URL, never the chainId. A manually pointed RPC
// can't silently change which network gets signed for: if you want another
// network, you name it.
export function redDe(env = {}) {
  const nombre = String(env[VAR_RED] || RED_DEFAULT).trim()
  const red = REDES[nombre]
  if (!red) {
    throw new Error(
      `wallet: ${VAR_RED}=${JSON.stringify(nombre)} is not a known network. ` +
        `Available: ${Object.keys(REDES).join(', ')}`
    )
  }
  const rpc = String(env[VAR_RPC] || '').trim() || red.rpc
  return { nombre, ...red, rpc, rpcPropio: rpc !== red.rpc }
}

// -----------------------------------------------------------------------------
// D30.1 — WHERE THE KEYSTORE LIVES, AND WHY IT CAN'T BE %TEMP%
// -----------------------------------------------------------------------------
//
// `swarmStorageDir()` used to send ALL storage to `os.tmpdir()` when the node
// runs under `bare` — i.e. in development, which is exactly where funding is
// going to get tested. For a Corestore that can be re-downloaded that's fine.
// For a wallet it isn't: **Windows cleans temp**, and losing what's in there
// isn't losing a cache, it's losing the only copy of a seed that maybe nobody
// wrote down. It's a precondition for funding anything, testnet included.
//
// The rule is simple: the keystore goes in the PERSISTENT directory, always,
// even if the rest of storage is in temp. An explicit `--storage` is
// honored — that's the operator's decision, not ours — but if it falls inside
// temp it warns, instead of letting it be discovered the day the file isn't
// there.
//
// It's kept separate from the rest of storage on purpose: these are two
// things with different lifetimes, and mixing them is what created the
// problem in the first place.
export function directorioKeystore({
  storage = null,
  persistente = null,
  app = '',
  temporal
} = {}) {
  const temp = temporal || os.tmpdir()

  if (storage) {
    const dir = path.resolve(String(storage))
    return {
      dir,
      volatil: estaAdentroDe(dir, temp),
      motivo: estaAdentroDe(dir, temp)
        ? `--storage points inside ${temp}, which the OS cleans up`
        : null
    }
  }

  if (!persistente) {
    throw new Error('wallet: no persistent directory to put the keystore in')
  }

  // NEVER temp. Not even in dev. That's the whole fix in D30.1.
  const dir = app ? path.join(persistente, app) : path.resolve(String(persistente))
  return {
    dir,
    volatil: estaAdentroDe(dir, temp),
    motivo: estaAdentroDe(dir, temp)
      ? `this platform's persistent directory falls inside ${temp}`
      : null
  }
}

// Windows compares paths case-insensitively, and this check has to fail
// towards "yes, it's temp" rather than "no, it isn't": the cost of a false
// positive is one extra line on screen, and the cost of a false negative is a
// deleted wallet.
function estaAdentroDe(dir, contenedor) {
  if (!contenedor) return false
  const norm = (p) => {
    const r = path.resolve(String(p)).replace(/[\\/]+$/, '')
    return os.platform() === 'win32' ? r.toLowerCase() : r
  }
  const d = norm(dir)
  const c = norm(contenedor)
  return d === c || d.startsWith(c + path.sep) || d.startsWith(c + '/')
}

function rutaDe(dir) {
  return path.join(dir, ARCHIVO)
}

// Derives the encryption key from the passphrase. Argon2id via sodium, with
// MODERATE parameters: ~0.5s per derivation on the reference machine.
//
// That half second is deliberate and is the only thing that makes a short
// passphrase worth anything: without an expensive KDF, running a whole
// dictionary against the keystore is instant. It's paid once per startup.
function derivarClave(passphrase, salt) {
  const clave = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_pwhash(
    clave,
    Buffer.from(String(passphrase), 'utf8'),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_DEFAULT
  )
  return clave
}

// Generates a fresh BIP-39 phrase. The entropy comes from sodium, not from
// `bip39.generateMnemonic`, which doesn't run under Bare: see the header.
export function generarFrase() {
  const entropia = Buffer.alloc(ENTROPIA_BYTES)
  sodium.randombytes_buf(entropia)
  const frase = bip39.entropyToMnemonic(entropia, wordlist)
  // Validate what we just generated. Not free-floating paranoia: a
  // malformed checksum would only be discovered the day someone tries to
  // restore the wallet from the paper they wrote it on — the worst possible
  // moment.
  if (!bip39.validateMnemonic(frase, wordlist)) {
    throw new Error('wallet: the generated phrase does not validate against BIP-39')
  }
  return frase
}

export function fraseValida(frase) {
  try {
    return bip39.validateMnemonic(String(frase).trim(), wordlist)
  } catch {
    return false
  }
}

// -----------------------------------------------------------------------------
// The keystore
// -----------------------------------------------------------------------------

export function existe(dir) {
  try {
    return fs.statSync(rutaDe(dir)).isFile()
  } catch {
    return false
  }
}

// Writes the keystore. Atomic — temp file then rename over it — for the same
// reason as budget.json and apikeys.json: a file cut off halfway here is a
// lost wallet, not a lost counter.
function guardar(dir, sobre) {
  const destino = rutaDe(dir)
  const tmp = destino + '.tmp'
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(sobre, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, destino)
}

// Encrypts a phrase with the passphrase and returns the envelope that goes to disk.
function cifrar(frase, passphrase) {
  const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)
  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  const claro = Buffer.from(frase, 'utf8')
  const cifrado = Buffer.alloc(claro.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cifrado, claro, nonce, derivarClave(passphrase, salt))

  return {
    version: VERSION,
    kdf: 'argon2id-moderate',
    cipher: 'xsalsa20-poly1305',
    salt: salt.toString('hex'),
    nonce: nonce.toString('hex'),
    // The encrypted phrase. There's no plaintext field that gives it away, and
    // in particular the address is NOT stored: storing it would let someone
    // without the passphrase read where this node gets paid anyway, which is
    // exactly what the signed manifest is supposed to be the only thing that
    // says.
    sealed: cifrado.toString('hex')
  }
}

function descifrar(sobre, passphrase) {
  const salt = Buffer.from(sobre.salt, 'hex')
  const nonce = Buffer.from(sobre.nonce, 'hex')
  const cifrado = Buffer.from(sobre.sealed, 'hex')

  const claro = Buffer.alloc(cifrado.length - sodium.crypto_secretbox_MACBYTES)
  const abrio = sodium.crypto_secretbox_open_easy(
    claro,
    cifrado,
    nonce,
    derivarClave(passphrase, salt)
  )
  // Fail closed: see the header. Opening with garbage would mean announcing
  // an address nobody controls.
  if (!abrio) return null
  return claro.toString('utf8')
}

// -----------------------------------------------------------------------------
// The account
// -----------------------------------------------------------------------------

// The address is derived WITHOUT the network. This is verified in the spike
// and is the condition for the node to be able to build its signed manifest
// without depending on a reachable RPC: if it needed one, a node without
// internet couldn't even announce itself.
//
// `provider` still gets passed because WDK requires it in the constructor;
// it's not used until someone sends a transaction, which is Phase 9 onward.
// D30.2 — the RPC is no longer a constant hidden in here. `red` is what
// `redDe()` resolved, and `rpc` can override it for a one-off case (the tests
// pass one that doesn't exist, specifically to prove it doesn't need to
// exist).
async function cuentaDesde(frase, rpc, red) {
  const elegida = red || redDe({})
  const url = rpc || elegida.rpc

  const mod = await import('@tetherto/wdk-wallet-evm')
  const WalletManagerEvm = mod.default || mod
  const manager = new WalletManagerEvm(frase, { provider: url })
  const cuenta = await manager.getAccount()
  const address = await cuenta.getAddress()
  // The same pattern the frozen schema requires. If WDK changed its format,
  // this says so here rather than three hops later when validating the
  // manifest.
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('wallet: WDK returned an address that does not match the schema: ' + address)
  }
  // The network travels back so whoever opened the wallet can STATE it: a
  // node charging against 9745 and one charging against 9746 can't look the
  // same on screen.
  return { manager, cuenta, address, rpc: url, red: elegida }
}

// -----------------------------------------------------------------------------
// The API startup uses
// -----------------------------------------------------------------------------

// Creates the node's wallet and leaves it encrypted at `<dir>/wallet.json`.
//
// Returns the phrase IN THE CLEAR exactly once, so the caller can show it to
// the operator to write down. It can't be read again without the passphrase,
// and that's the point.
export async function crear(dir, passphrase, { rpc = null, red = null, frase = null } = {}) {
  if (!passphrase) throw new Error('wallet: a passphrase is required to encrypt the seed')
  if (existe(dir)) throw new Error('wallet: there is already a wallet at ' + rutaDe(dir))

  // `frase` allows RESTORING from a backup, which is the other half of
  // showing the phrase once. Without this, losing the keystore would mean
  // losing the wallet even if the operator has the 24 words written down.
  const semilla = frase ? String(frase).trim() : generarFrase()
  if (frase && !fraseValida(semilla)) {
    throw new Error('wallet: the backup phrase does not validate against BIP-39')
  }

  const { address } = await cuentaDesde(semilla, rpc, red)
  guardar(dir, cifrar(semilla, passphrase))
  return { address, frase: semilla, restaurada: !!frase }
}

// Opens the existing wallet. Returns `null` if there isn't one — which is the
// NORMAL case for a node that doesn't charge yet, not an error.
//
// If there is a wallet but the passphrase is missing or doesn't open it, THAT
// is an error and it says so: someone configured a wallet and the node can't
// use it, and that difference from "no wallet" has to be visible.
export async function abrir(dir, passphrase, { rpc = null, red = null } = {}) {
  if (!existe(dir)) return null

  let sobre
  try {
    sobre = JSON.parse(fs.readFileSync(rutaDe(dir), 'utf8'))
  } catch (err) {
    throw new Error('wallet: ' + rutaDe(dir) + ' unreadable: ' + ((err && err.message) || err))
  }

  if (!sobre || sobre.version !== VERSION) {
    throw new Error('wallet: ' + rutaDe(dir) + ' is from another version and won\'t open halfway')
  }
  if (!passphrase) {
    throw new Error(
      'wallet: there is an encrypted wallet and the passphrase is missing: set the ' +
        VAR_PASSPHRASE + ' environment variable'
    )
  }

  const frase = descifrar(sobre, passphrase)
  if (frase === null) {
    throw new Error('wallet: the passphrase in ' + VAR_PASSPHRASE + ' does not open the keystore')
  }

  return cuentaDesde(frase, rpc, red)
}

// The manifest's `economic` block, built from a real address.
//
// It's built HERE and not in manifest.mjs so that manifest.mjs doesn't have to
// import WDK: the manifest is built and verified along paths that have no
// wallet — the tests, and any peer verifying ANOTHER node's manifest — and
// loading a wallet stack for that would mean paying for it everywhere.
export function economicDe(address, settlement = SETTLEMENT) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(address || ''))) {
    throw new Error('wallet: economicDe needs a valid EVM address')
  }
  if (!['prepaid-balance', 'batch-receipts', 'onchain-per-job'].includes(settlement)) {
    throw new Error('wallet: economicDe called with a settlement not in the schema')
  }
  return { walletAddress: address, chains: CHAINS, settlement }
}
