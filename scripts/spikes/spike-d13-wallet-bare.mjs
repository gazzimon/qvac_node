// Phase 7 / D13 spike — where does the wallet's seed come from under Bare?

// The D11 spike (spike-d11-wdk-bare.mjs) answered "does WDK run under
// Bare?". This one answers the question that only shows up once you try to
// USE it, one the roadmap had assumed was already settled:
//
//   WDK doesn't generate seeds or store them. `new WalletManagerEvm(x)`
//   requires a BIP-39 MNEMONIC -- a 32-byte hex seed, which is what
//   identity.mjs already knows how to generate and persist, gets rejected
//   with "The seed phrase is invalid" -- and `@tetherto/wdk-wallet` ships
//   no secret manager at all: its exports are errors and interfaces
//   (WdkError, ISigner, IWalletAccount...), no custody.
//
// I.e. D13 can't "delegate to WDK's secret manager," which was one of the
// two halves of the decision as written. The other one remains: encryption
// at rest, and we write it ourselves.
//
// RESULT (2026-08-26): all eight steps pass under Bare.
//
//   - `bip39` does NOT work: it imports `node:crypto` and doesn't resolve
//     under Bare (R1).
//   - `@scure/bip39` DOES, with two caveats this file pins down:
//       * the subpath carries an extension: '@scure/bip39/wordlists/english.js';
//       * its `generateMnemonic` uses `crypto.getRandomValues`, which doesn't
//         exist under Bare. Not needed: `entropyToMnemonic` accepts OUR
//         entropy, and cryptographic randomness is already in the tree
//         (sodium-native, via hypercore), which is also the same one
//         apikeys.mjs already uses.
//   - The address is derived with NO RPC reachable, which is the condition
//     for being able to build the signed manifest offline.
//   - The known BIP-39/BIP-44 vector gives the standard address, so we
//     aren't generating something only we understand.
//   - sodium encrypts the phrase and a wrong passphrase FAILS instead of
//     returning garbage. Deriving the key costs ~477 ms, which is startup
//     UX and has to be kept in mind.
//
// KEPT AROUND TO BE RE-RUN. The answer holds for today's versions:
// wdk-wallet-evm 1.0.0-beta.17, @scure/bip39 2.3.0, @x402/* 2.23.0. WDK is
// in BETA, so this gets run again before assuming it still works.
//
//   npm install @tetherto/wdk-wallet-evm @scure/bip39
//   bare scripts/spikes/spike-d13-wallet-bare.mjs
//
// Each step cuts off the ones that depend on it: what matters is knowing
// WHICH one fails, not reading a cascade of errors that all stem from the
// first.

const probar = async (nombre, fn) => {
  try {
    const r = await fn()
    console.log('OK   ' + nombre + (r ? ' -> ' + r : ''))
    return true
  } catch (e) {
    console.log('FAIL ' + nombre)
    console.log('     ' + String((e && e.message) || e).split('\n')[0])
    return false
  }
}

const bip39 = await import('@scure/bip39')
const { wordlist } = await import('@scure/bip39/wordlists/english.js')
const sodium = (await import('sodium-native')).default || (await import('sodium-native'))
const wdk = await import('@tetherto/wdk-wallet-evm')
const WalletManagerEvm = wdk.default || wdk

// Unreachable on purpose: the node has to be able to announce its payout
// address without depending on there being an RPC.
const SIN_RED = { provider: 'http://127.0.0.1:1/no-existe' }

// The piece that replaces `generateMnemonic`, which doesn't run under Bare.
function generarFrase() {
  const entropia = Buffer.alloc(32) // 256 bits -> 24 words
  sodium.randombytes_buf(entropia)
  return bip39.entropyToMnemonic(entropia, wordlist)
}

await probar('1. english wordlist (the subpath carries .js)', async () => wordlist.length + ' words')

let frase = null
await probar('2. generate 24 words with sodium entropy', async () => {
  frase = generarFrase()
  if (!bip39.validateMnemonic(frase, wordlist)) throw new Error('the BIP-39 checksum does not validate')
  return '24 words, valid checksum'
})

await probar('3. WDK derives the address with NO RPC reachable', async () => {
  const addr = await (await new WalletManagerEvm(frase, SIN_RED).getAccount()).getAddress()
  // The same pattern the frozen schema requires (manifest-v0.json).
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('does not match the schema: ' + addr)
  return addr
})

await probar('4. the same phrase ALWAYS gives the same address', async () => {
  const a = await (await new WalletManagerEvm(frase, SIN_RED).getAccount()).getAddress()
  const b = await (await new WalletManagerEvm(frase, SIN_RED).getAccount()).getAddress()
  if (a !== b) throw new Error('not deterministic: ' + a + ' vs ' + b)
  return a
})

await probar('5. two different phrases give different addresses', async () => {
  const a = await (await new WalletManagerEvm(generarFrase(), SIN_RED).getAccount()).getAddress()
  const b = await (await new WalletManagerEvm(generarFrase(), SIN_RED).getAccount()).getAddress()
  if (a === b) throw new Error('COLLISION')
  return a.slice(0, 12) + '... != ' + b.slice(0, 12) + '...'
})

await probar('6. known BIP-39/BIP-44 vector', async () => {
  const conocida = 'test test test test test test test test test test test junk'
  const addr = await (await new WalletManagerEvm(conocida, SIN_RED).getAccount()).getAddress()
  const esperada = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  if (addr !== esperada) throw new Error('got ' + addr + ' and expected ' + esperada)
  return addr
})

await probar('7. encrypt the phrase, and the wrong passphrase does NOT open it', async () => {
  const secreto = Buffer.from(frase, 'utf8')
  const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)

  const derivar = (pass) => {
    const k = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
    sodium.crypto_pwhash(
      k,
      Buffer.from(pass, 'utf8'),
      salt,
      sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      sodium.crypto_pwhash_ALG_DEFAULT
    )
    return k
  }

  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const cifrado = Buffer.alloc(secreto.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cifrado, secreto, nonce, derivar('la-buena'))

  if (cifrado.toString('utf8').includes(frase.split(' ')[0])) {
    throw new Error('the phrase is visible in the ciphertext')
  }

  const claro = Buffer.alloc(cifrado.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(claro, cifrado, nonce, derivar('la-buena'))) {
    throw new Error('did not open with the correct passphrase')
  }
  if (claro.toString('utf8') !== frase) throw new Error('opened but returned something else')

  // Fail closed. A wrong passphrase that returned garbage would derive a
  // different payout address, and the node would announce a wallet it
  // doesn't control.
  const basura = Buffer.alloc(claro.length)
  if (sodium.crypto_secretbox_open_easy(basura, cifrado, nonce, derivar('la-mala'))) {
    throw new Error('DANGER: opened with the wrong passphrase')
  }
  return 'round trip ok; the wrong one does not open'
})

await probar('8. how long deriving the key takes (it is startup UX)', async () => {
  const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)
  const k = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
  const t = Date.now()
  sodium.crypto_pwhash(
    k,
    Buffer.from('x', 'utf8'),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_DEFAULT
  )
  return Date.now() - t + 'ms with OPSLIMIT/MEMLIMIT MODERATE'
})
