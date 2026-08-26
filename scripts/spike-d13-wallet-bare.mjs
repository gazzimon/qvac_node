// Spike de la Fase 7 / D13 — ¿de dónde sale la seed de la wallet bajo Bare?
//
// El spike de D11 (spike-d11-wdk-bare.mjs) contestó "¿corre WDK bajo Bare?".
// Éste contesta la pregunta que aparece recién cuando uno intenta USARLO, y que
// el roadmap daba por resuelta:
//
//   WDK no genera seeds ni las guarda. `new WalletManagerEvm(x)` exige un
//   MNEMONIC BIP-39 -- una seed hex de 32 bytes, que es lo que identity.mjs ya
//   sabe generar y persistir, se rechaza con "The seed phrase is invalid" -- y
//   `@tetherto/wdk-wallet` no trae ningún secret manager: sus exports son
//   errores e interfaces (WdkError, ISigner, IWalletAccount...), nada de
//   custodia.
//
// O sea que D13 no se puede "delegar al secret manager de WDK", que era una de
// las dos mitades de la decisión escrita. Queda la otra: cifrado en reposo, y
// lo escribimos nosotros.
//
// RESULTADO (2026-08-26): los ocho pasos pasan bajo Bare.
//
//   - `bip39` NO sirve: importa `node:crypto` y no resuelve bajo Bare (R1).
//   - `@scure/bip39` SÍ, con dos salvedades que este archivo deja fijadas:
//       * el subpath lleva extensión: '@scure/bip39/wordlists/english.js';
//       * su `generateMnemonic` usa `crypto.getRandomValues`, que bajo Bare no
//         existe. No hace falta: `entropyToMnemonic` acepta NUESTRA entropía, y
//         azar criptográfico ya hay en el árbol (sodium-native, vía hypercore),
//         que además es el mismo que ya usa apikeys.mjs.
//   - La dirección se deriva SIN RPC alcanzable, que es la condición para poder
//     armar el manifiesto firmado offline.
//   - El vector conocido de BIP-39/BIP-44 da la dirección estándar, así que no
//     estamos generando algo que sólo entendemos nosotros.
//   - sodium cifra la frase y la passphrase equivocada FALLA en vez de devolver
//     basura. Derivar la clave cuesta ~477 ms, que es UX de arranque y hay que
//     tenerlo presente.
//
// SE GUARDA PARA REPETIRLO. La respuesta vale para las versiones de hoy:
// wdk-wallet-evm 1.0.0-beta.17, @scure/bip39 2.3.0, @x402/* 2.23.0. WDK está en
// BETA, así que esto se vuelve a correr antes de asumir que sigue andando.
//
//   npm install @tetherto/wdk-wallet-evm @scure/bip39
//   bare scripts/spike-d13-wallet-bare.mjs
//
// Cada paso corta a los que dependen de él: interesa saber CUÁL falla, no leer
// una cascada de errores que salen todos del primero.

const probar = async (nombre, fn) => {
  try {
    const r = await fn()
    console.log('OK   ' + nombre + (r ? ' -> ' + r : ''))
    return true
  } catch (e) {
    console.log('FALL ' + nombre)
    console.log('     ' + String((e && e.message) || e).split('\n')[0])
    return false
  }
}

const bip39 = await import('@scure/bip39')
const { wordlist } = await import('@scure/bip39/wordlists/english.js')
const sodium = (await import('sodium-native')).default || (await import('sodium-native'))
const wdk = await import('@tetherto/wdk-wallet-evm')
const WalletManagerEvm = wdk.default || wdk

// A propósito inalcanzable: el nodo tiene que poder anunciar su dirección de
// cobro sin depender de que haya RPC.
const SIN_RED = { provider: 'http://127.0.0.1:1/no-existe' }

// La pieza que reemplaza al `generateMnemonic` que no corre bajo Bare.
function generarFrase() {
  const entropia = Buffer.alloc(32) // 256 bits -> 24 palabras
  sodium.randombytes_buf(entropia)
  return bip39.entropyToMnemonic(entropia, wordlist)
}

await probar('1. wordlist inglés (el subpath lleva .js)', async () => wordlist.length + ' palabras')

let frase = null
await probar('2. generar 24 palabras con entropía de sodium', async () => {
  frase = generarFrase()
  if (!bip39.validateMnemonic(frase, wordlist)) throw new Error('el checksum BIP-39 no valida')
  return '24 palabras, checksum válido'
})

await probar('3. WDK deriva la dirección SIN RPC alcanzable', async () => {
  const addr = await (await new WalletManagerEvm(frase, SIN_RED).getAccount()).getAddress()
  // El mismo pattern que exige el schema congelado (manifest-v0.json).
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('no matchea el schema: ' + addr)
  return addr
})

await probar('4. la misma frase da SIEMPRE la misma dirección', async () => {
  const a = await (await new WalletManagerEvm(frase, SIN_RED).getAccount()).getAddress()
  const b = await (await new WalletManagerEvm(frase, SIN_RED).getAccount()).getAddress()
  if (a !== b) throw new Error('no determinística: ' + a + ' vs ' + b)
  return a
})

await probar('5. dos frases distintas dan direcciones distintas', async () => {
  const a = await (await new WalletManagerEvm(generarFrase(), SIN_RED).getAccount()).getAddress()
  const b = await (await new WalletManagerEvm(generarFrase(), SIN_RED).getAccount()).getAddress()
  if (a === b) throw new Error('COLISIÓN')
  return a.slice(0, 12) + '... != ' + b.slice(0, 12) + '...'
})

await probar('6. vector conocido BIP-39/BIP-44', async () => {
  const conocida = 'test test test test test test test test test test test junk'
  const addr = await (await new WalletManagerEvm(conocida, SIN_RED).getAccount()).getAddress()
  const esperada = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  if (addr !== esperada) throw new Error('dio ' + addr + ' y se esperaba ' + esperada)
  return addr
})

await probar('7. cifrar la frase, y que la passphrase equivocada NO abra', async () => {
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
    throw new Error('la frase se ve en el cifrado')
  }

  const claro = Buffer.alloc(cifrado.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(claro, cifrado, nonce, derivar('la-buena'))) {
    throw new Error('no abrió con la passphrase correcta')
  }
  if (claro.toString('utf8') !== frase) throw new Error('abrió pero devolvió otra cosa')

  // Fallar cerrado. Una passphrase equivocada que devuelve basura derivaría una
  // dirección de cobro distinta, y el nodo anunciaría una wallet que no controla.
  const basura = Buffer.alloc(claro.length)
  if (sodium.crypto_secretbox_open_easy(basura, cifrado, nonce, derivar('la-mala'))) {
    throw new Error('PELIGRO: abrió con la passphrase equivocada')
  }
  return 'ida y vuelta ok; la equivocada no abre'
})

await probar('8. cuánto tarda derivar la clave (es UX de arranque)', async () => {
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
  return Date.now() - t + 'ms con OPSLIMIT/MEMLIMIT MODERATE'
})
