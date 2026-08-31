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
// `bip39` no sirve bajo Bare (importa `node:crypto`, R1). `@scure/bip39` sí, con
// una salvedad: su `generateMnemonic` usa `crypto.getRandomValues`, que Bare no
// tiene. No hace falta — `entropyToMnemonic` acepta NUESTRA entropía, y azar
// criptográfico ya hay en el árbol. Todo esto está medido en
// `scripts/spikes/spike-d13-wallet-bare.mjs`, que se repite cuando WDK suba de versión
// (está en beta).
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
// EL LIMITE HONESTO: `chainId` acá es lo que la tabla DECLARA, no lo que la
// cadena contesta. Si alguien pone `PYRUS_WALLET_RPC` apuntando al RPC de otra
// red, este módulo no se entera — no habla con la red a propósito (ver
// `cuentaDesde`). Quien compara lo declarado contra lo que responde la cadena es
// `npm run verificar-x402`, y por eso ese script existe antes que el fondeo.
// FASE 12 — `explorerApi` es OTRA COSA que `explorer`, y la diferencia se midió
// contra la red, no se supuso: `plasmascan.to` es de la familia Etherscan y su
// API pide una API key, mientras que la ruta `/api/v2/...` de Blockscout ahí
// devuelve un 302 a la página de 404. Quien sí contesta las dos cadenas sin
// credencial es Routescan, que es el backend que ese explorer usa.
//
// Así que `explorer` es a dónde se manda a una PERSONA (los links del panel) y
// `explorerApi` es a dónde le pregunta el nodo. Son dos hosts distintos y
// mezclarlos fue lo que hizo que el historial no leyera nada.
export const REDES = {
  plasma: {
    chainId: 9745,
    caip2: 'eip155:9745',
    rpc: 'https://rpc.plasma.to',
    explorer: 'https://plasmascan.to',
    explorerApi: 'https://api.routescan.io/v2/network/mainnet/evm/9745',
    mainnet: true
  },
  'plasma-testnet': {
    chainId: 9746,
    caip2: 'eip155:9746',
    rpc: 'https://testnet-rpc.plasma.to',
    explorer: 'https://testnet.plasmascan.to',
    explorerApi: 'https://api.routescan.io/v2/network/testnet/evm/9746',
    mainnet: false
  }
}

// D15 unchanged: Plasma mainnet is the default.
export const RED_DEFAULT = 'plasma'

export const VAR_RED = 'PYRUS_WALLET_RED'
export const VAR_RPC = 'PYRUS_WALLET_RPC'

// FASE 11 — el selector de red del panel escribe acá. Mismo criterio que
// `wallet.pass`: el entorno gana siempre, esto es el fallback persistente.
export const ARCHIVO_RED = 'wallet.red'

// Qué red usa este nodo. Función pura respecto del `env`; con `dir` además mira
// el archivo que dejó el panel. Orden: PYRUS_WALLET_RED > `<dir>/wallet.red` >
// el default de D15 (plasma mainnet).
//
// `VAR_RPC` pisa SOLO la URL, nunca el chainId. Un RPC apuntado a mano no puede
// cambiar en silencio la red para la que se firma: si querés otra red, se nombra.
export function redDe(env = {}, { dir = null } = {}) {
  let nombre = String((env && env[VAR_RED]) || '').trim()
  let fuente = nombre ? 'env' : null
  if (!nombre && dir) {
    try {
      const guardada = fs.readFileSync(path.join(dir, ARCHIVO_RED), 'utf8').trim()
      if (guardada) {
        nombre = guardada
        fuente = 'archivo'
      }
    } catch {
      // no hay archivo: sigue al default
    }
  }
  if (!nombre) {
    nombre = RED_DEFAULT
    fuente = 'default'
  }
  const red = REDES[nombre]
  if (!red) {
    throw new Error(
      `wallet: ${VAR_RED}=${JSON.stringify(nombre)} is not a known network. ` +
        `Available: ${Object.keys(REDES).join(', ')}`
    )
  }
  const rpc = String((env && env[VAR_RPC]) || '').trim() || red.rpc
  return { nombre, ...red, rpc, rpcPropio: rpc !== red.rpc, fuente, fijadaPorEnv: fuente === 'env' }
}

// Persiste la red elegida desde el panel. Valida contra `REDES` ANTES de tocar
// disco: un nombre que no existe dejaría al nodo sin arrancar en el próximo
// boot (`redDe` tira). Atómico y 0600, como el resto del keystore.
export function guardarRed(dir, nombre) {
  const n = String(nombre || '').trim()
  if (!REDES[n]) {
    throw new Error(
      `wallet: ${JSON.stringify(n)} no es una red conocida. ` +
        `Las que hay: ${Object.keys(REDES).join(', ')}`
    )
  }
  fs.mkdirSync(dir, { recursive: true })
  const ruta = path.join(dir, ARCHIVO_RED)
  const tmp = ruta + '.tmp'
  fs.writeFileSync(tmp, n, { mode: 0o600 })
  fs.renameSync(tmp, ruta)
  return { nombre: n, chainId: REDES[n].chainId, mainnet: !!REDES[n].mainnet }
}

// -----------------------------------------------------------------------------
// FASE 12 — LOS TOKENS QUE EL PANEL VIGILA, Y POR QUE VAN POR RED
// -----------------------------------------------------------------------------
//
// `/v1/wallet/balances` sabia leer UN token: el USD₮0 de Plasma mainnet, con la
// direccion escrita en `x402.mjs`. Cualquier otro —el `tUSD` de prueba que
// despliega `scripts/activo-prueba.sol`, por ejemplo— era invisible desde el
// panel aunque el nodo lo tuviera en la wallet.
//
// SE GUARDAN POR RED, y no es una comodidad: **una direccion de token no vale
// cross-chain**. El mismo 0x… en 9745 y en 9746 son dos contratos distintos que
// nadie prometio que sean el mismo activo, y mostrar el balance de uno bajo el
// simbolo del otro es exactamente la clase de numero inventado que este panel no
// dibuja. Asi que la clave del archivo es el CAIP-2 de la red.
//
// LIMITE HONESTO, y viaja hasta la pantalla: lo unico que se valida es la
// FORMA. Que la address sea 20 bytes no dice que ahi viva un ERC-20, ni que su
// `symbol` sea el que alguien escribio, ni que tenga esos decimales. Nadie
// pregunta nada a la cadena — igual que la direccion de USD₮0 de x402, estos
// tokens salen marcados `verificado:false` y la fila lo dice.
//
// El archivo sigue el patron de `ARCHIVO_RED`: 0600, escritura atomica
// temporal+rename, validacion ANTES de tocar disco, y va en `.gitignore` y en el
// ignore de `pear stage` junto a `wallet.json`.
export const ARCHIVO_TOKENS = 'wallet.tokens.json'

// Chequeo de FORMA de un token. Es el gemelo server-side de
// `tokenParecePlausible` de `panel-wallet.mjs`: la del panel evita mandar una
// obviedad, esta decide si algo entra al disco. Las dos tienen que decir lo
// mismo, y por eso la regla esta escrita igual en las dos.
export function tokenParaGuardar(tok) {
  const t = tok || {}
  const address = String(t.address == null ? '' : t.address).trim()
  const symbol = String(t.symbol == null ? '' : t.symbol).trim()
  const decimals = Number(t.decimals)

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null
  if (symbol.length < 1 || symbol.length > 12) return null
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null

  // La address se normaliza a minuscula: es la clave del dedupe, y dos
  // capitalizaciones distintas de la misma address son el mismo contrato.
  return { address: address.toLowerCase(), symbol, decimals }
}

// Lee `<dir>/wallet.tokens.json`. Un archivo ausente, ilegible o con una forma
// que no entendemos devuelve `{}` y NO tira: mismo criterio que `redDe` con
// `wallet.red` ausente. El panel sin tokens es el estado normal de un nodo
// recien instalado, no un error que tenga que romper el arranque.
export function leerTokens(dir) {
  let crudo
  try {
    crudo = JSON.parse(fs.readFileSync(path.join(dir, ARCHIVO_TOKENS), 'utf8'))
  } catch {
    return {}
  }
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return {}

  // Se filtra al LEER y no solo al escribir: un archivo editado a mano no puede
  // meter una fila rota en la lista que el panel dibuja.
  const salida = {}
  for (const caip2 of Object.keys(crudo)) {
    const lista = Array.isArray(crudo[caip2]) ? crudo[caip2] : []
    const vistas = new Set()
    const buenos = []
    for (const t of lista) {
      const limpio = tokenParaGuardar(t)
      if (!limpio || vistas.has(limpio.address)) continue
      vistas.add(limpio.address)
      buenos.push(limpio)
    }
    if (buenos.length) salida[caip2] = buenos
  }
  return salida
}

// Escribe la tabla entera. Valida TODO antes de tocar disco, igual que
// `guardarRed`: escribir a medias dejaria un archivo que el proximo arranque no
// entiende, y en ese caso el panel perderia los tokens en silencio.
//
// Tira con el motivo cuando algo no pasa la forma — el que llama (el endpoint)
// lo convierte en un 400 con el texto adentro, para que la persona sepa CUAL de
// los tres campos estaba mal.
export function guardarTokens(dir, tabla) {
  if (!tabla || typeof tabla !== 'object' || Array.isArray(tabla)) {
    throw new Error('wallet: guardarTokens espera un objeto { caip2: [tokens] }')
  }

  const limpia = {}
  for (const caip2 of Object.keys(tabla)) {
    if (!/^eip155:\d+$/.test(String(caip2))) {
      throw new Error(`wallet: ${JSON.stringify(caip2)} no es un CAIP-2 de una red EVM`)
    }
    const lista = tabla[caip2]
    if (!Array.isArray(lista)) {
      throw new Error(`wallet: los tokens de ${caip2} tienen que venir en un array`)
    }
    const vistas = new Set()
    const buenos = []
    for (const t of lista) {
      const limpio = tokenParaGuardar(t)
      if (!limpio) {
        throw new Error(
          'wallet: token invalido: la address tiene que ser 0x + 40 hex, el simbolo ' +
            '1 a 12 caracteres y los decimales un entero de 0 a 36'
        )
      }
      // El dedupe NO es un error: agregar dos veces el mismo token es una
      // pulsacion de mas, no algo que tenga que fallar.
      if (vistas.has(limpio.address)) continue
      vistas.add(limpio.address)
      buenos.push(limpio)
    }
    if (buenos.length) limpia[caip2] = buenos
  }

  fs.mkdirSync(dir, { recursive: true })
  const ruta = path.join(dir, ARCHIVO_TOKENS)
  const tmp = ruta + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(limpia, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, ruta)
  return limpia
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
// FASE 11 — DE DONDE SALE LA PASSPHRASE, Y POR QUE PUEDE SALIR DE UN ARCHIVO
// -----------------------------------------------------------------------------
//
// Onboarding from the panel (create the wallet without `pyrusllm wallet --create`)
// necesita una passphrase, y necesita que el MISMO valor esté disponible en
// cada arranque para que `abrir()` funcione sin que nadie vuelva a tipear nada.
// El env var solo no alcanza: obligaba a editar el entorno y reiniciar antes de
// poder tocar el botón.
//
// Orden de resolución:
//   1. PYRUS_WALLET_PASSPHRASE en el entorno — el operador que la quiere
//      manejar a mano gana siempre, y nada de esto le cambia el flujo.
//   2. `<dir>/wallet.pass` — lo que dejó un arranque anterior o el onboarding.
//   3. con `generar:true` y ninguna de las dos: se genera una aleatoria, se
//      guarda 0600 en ese archivo, y se devuelve. Con `generar:false`: null.
//
// LIMITE HONESTO — es el mismo del encabezado, no uno nuevo. Con la passphrase
// en `wallet.pass` AL LADO de `wallet.json`, el cifrado en reposo protege un
// keystore COPIADO —un backup, el repo, un `pear stage`— pero no a alguien que
// puede leer el directorio entero. El respaldo real siguen siendo las 24
// palabras: perder la passphrase no pierde la wallet, restaurar desde la frase
// sí la recupera. `wallet.pass` va en .gitignore y en el ignore de `pear stage`
// junto a `wallet.json`.
export const ARCHIVO_PASS = 'wallet.pass'

export function resolverPassphrase(dir, { env = {}, generar = false } = {}) {
  const desdeEnv = String((env && env[VAR_PASSPHRASE]) || '').trim()
  if (desdeEnv) return { passphrase: desdeEnv, fuente: 'env' }

  const ruta = path.join(dir, ARCHIVO_PASS)
  try {
    const guardada = fs.readFileSync(ruta, 'utf8').trim()
    if (guardada) return { passphrase: guardada, fuente: 'archivo' }
  } catch {
    // no existe todavía: se sigue
  }

  if (!generar) return { passphrase: null, fuente: null }

  const bytes = Buffer.alloc(32)
  sodium.randombytes_buf(bytes)
  const nueva = bytes.toString('base64')
  fs.mkdirSync(dir, { recursive: true })
  // Atómico y 0600, igual que el keystore: un archivo cortado acá dejaría una
  // wallet que no se puede volver a abrir.
  const tmp = ruta + '.tmp'
  fs.writeFileSync(tmp, nueva, { mode: 0o600 })
  fs.renameSync(tmp, ruta)
  return { passphrase: nueva, fuente: 'generada' }
}

// -----------------------------------------------------------------------------
// El keystore
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
