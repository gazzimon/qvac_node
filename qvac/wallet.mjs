// La wallet de COBRO del nodo. Fase 7 del ROADMAP_FASE7-X402 (D13, D15).
//
// -----------------------------------------------------------------------------
// SON DOS CLAVES DISTINTAS, Y ESTE ARCHIVO EXISTE POR ESO
//
// `identity.mjs` guarda la clave de RED: la Ed25519 con la que el nodo firma su
// manifiesto y se presenta en el swarm. Vive EN CLARO en `identity.json`, y para
// lo que es está bien: comprometerla permite suplantar a un nodo, no llevarse
// plata.
//
// Esta es la identidad de COBRO. El schema congelado ya las declaraba separadas
// (manifest-v0.json:84) y D13 decide que esa separación **también existe en
// disco**: seed propia, nunca derivada de la de red, y cifrada en reposo.
//
// El manifiesto firmado es justamente lo que ata una a la otra: un consumidor
// verifica la firma con la clave de red y, si valida, sabe que ESE nodo declaró
// ESA dirección de cobro.
//
// -----------------------------------------------------------------------------
// POR QUE UN MNEMONIC Y NO LA SEED DE 32 BYTES QUE YA SABEMOS GUARDAR
//
// No es una preferencia: WDK no acepta otra cosa. `new WalletManagerEvm(hex)`
// falla con "The seed phrase is invalid" — sólo entra un mnemonic BIP-39. Y WDK
// tampoco exporta con qué generarlo, así que la generación es nuestra.
//
// `bip39` no sirve bajo Bare (importa `node:crypto`, R1). `@scure/bip39` sí, con
// una salvedad: su `generateMnemonic` usa `crypto.getRandomValues`, que Bare no
// tiene. No hace falta — `entropyToMnemonic` acepta NUESTRA entropía, y azar
// criptográfico ya hay en el árbol. Todo esto está medido en
// `scripts/spikes/spike-d13-wallet-bare.mjs`, que se repite cuando WDK suba de versión
// (está en beta).
//
// -----------------------------------------------------------------------------
// LIMITE HONESTO DE LO QUE PROTEGE ESTE CIFRADO
//
// La passphrase sale de una variable de entorno, típicamente puesta en el `.env`
// del directorio de trabajo. Si ese `.env` vive al lado del keystore, entonces
// **el cifrado protege de un backup, de un repo y de un `pear stage`, no de
// alguien que ya tiene acceso a esa máquina**. Es una decisión tomada a ojos
// abiertos: la alternativa —pedirla por consola en cada arranque— rompe el
// arranque desatendido y la promesa de "doble clic y abre en el navegador".
//
// Se dice acá, en el README y en `.env.example`, en vez de dejar que alguien
// suponga que "cifrado en reposo" quiere decir más de lo que quiere decir.
//
// -----------------------------------------------------------------------------
// FALLAR CERRADO
//
// Una passphrase equivocada NO puede devolver basura: derivaría OTRA dirección,
// y el nodo anunciaría en un manifiesto firmado una wallet que no controla —
// o sea, mandaría a pagar a una dirección de la que nadie tiene la clave.
// `crypto_secretbox_open_easy` autentica antes de descifrar, así que eso no
// pasa: o abre lo que se guardó, o no abre.

// -----------------------------------------------------------------------------
// D30.1 / D30.2 — LA FASE 7 SE REABRIO ACA, Y SE VOLVIO A CERRAR
//
// Este archivo es superficie de la Fase 7, que estaba cerrada. D30 la reabrio
// por dos precondiciones suyas que no se pueden cumplir desde afuera:
//
//   D30.1  el keystore no puede vivir en %TEMP% -> `directorioKeystore`
//   D30.2  el RPC tiene que ser configurable    -> `REDES` / `redDe` / `abrir({rpc})`
//
// Lo que NO cambio: el formato del archivo (VERSION sigue en 1), la derivacion,
// el cifrado, ni la invariante de que la seed no sale del proceso que la abre.
// Un keystore escrito antes de esto se abre igual.

import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import sodium from 'sodium-native'
import * as bip39 from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

// Sube cuando cambie la forma del archivo. Uno de otra versión no se abre a
// medias: se avisa y se corta, porque acá "a medias" es una dirección de cobro
// equivocada.
const VERSION = 1

const ARCHIVO = 'wallet.json'

// D15 — Plasma default, Stable fallback. Los dos identificadores pasan el
// pattern kebab-case del schema SIN tocarlo, que era la condición de D2.
//
// OJO: Plasma NO es una testnet. Es plata real, y el riesgo se acota por el
// monto (riesgo #2 del roadmap), no por el entorno.
export const CHAINS = ['plasma', 'stable']

// El modo de liquidación que este nodo ofrece hoy. `batch-receipts` es lo que
// implementa la Fase 10; la Fase 9 cobra con `exact` por request y no cambia
// este campo, que describe la liquidación al proveedor y no el cobro al cliente.
export const SETTLEMENT = 'batch-receipts'

// 256 bits de entropía -> 24 palabras. Se elige 24 y no 12 porque el costo de
// escribir doce palabras más una única vez es cero y el margen es real.
const ENTROPIA_BYTES = 32

// La variable de entorno con la passphrase. El NOMBRE vive acá; el valor no
// toca el código ni el repo, igual que las credenciales de upstream.
export const VAR_PASSPHRASE = 'PYRUS_WALLET_PASSPHRASE'

// -----------------------------------------------------------------------------
// D30.2 — LA RED, Y POR QUE NO ALCANZABA CON UNA CONSTANTE
// -----------------------------------------------------------------------------
//
// Acá había un `RPC_DEFAULT = 'https://rpc.plasma.to'` y nada más: ni flag, ni
// variable, ni forma de apuntar a otro lado. `abrir()` aceptaba un `rpc` que
// nadie le pasaba. O sea que el nodo sólo sabía hablarle a MAINNET, y D30 —que
// decide que nada se estrena ahí— no se podía cumplir ni queriendo.
//
// **Y no es que "la testnet sea la misma red con otra URL".** Por EIP-155 el
// chainId entra en lo que se firma: una transacción firmada para 9745 no vale en
// 9746 y viceversa. Son dos redes distintas y hay que poder decir cuál.
//
// El default NO cambia: D15 sigue eligiendo Plasma mainnet, y D30 no dice que el
// nodo no pueda apuntar ahí — dice que no se ESTRENA ahí. Lo que cambia es que
// ahora se puede elegir, y que cuando la elegida es mainnet el arranque lo grita
// en vez de dejarlo implícito en una constante.
//
// EL LIMITE HONESTO: `chainId` acá es lo que la tabla DECLARA, no lo que la
// cadena contesta. Si alguien pone `PYRUS_WALLET_RPC` apuntando al RPC de otra
// red, este módulo no se entera — no habla con la red a propósito (ver
// `cuentaDesde`). Quien compara lo declarado contra lo que responde la cadena es
// `npm run verificar-x402`, y por eso ese script existe antes que el fondeo.
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

// D15 sin cambios: Plasma mainnet es el default.
export const RED_DEFAULT = 'plasma'

export const VAR_RED = 'PYRUS_WALLET_RED'
export const VAR_RPC = 'PYRUS_WALLET_RPC'

// Qué red usa este nodo, resuelta desde el entorno. Función pura: recibe el
// `env` en vez de leerlo, para que se pueda probar sin ensuciar el proceso.
//
// `VAR_RPC` pisa SOLO la URL, nunca el chainId. Un RPC apuntado a mano no puede
// cambiar en silencio la red para la que se firma: si querés otra red, se nombra.
export function redDe(env = {}) {
  const nombre = String(env[VAR_RED] || RED_DEFAULT).trim()
  const red = REDES[nombre]
  if (!red) {
    throw new Error(
      `wallet: ${VAR_RED}=${JSON.stringify(nombre)} no es una red conocida. ` +
        `Las que hay: ${Object.keys(REDES).join(', ')}`
    )
  }
  const rpc = String(env[VAR_RPC] || '').trim() || red.rpc
  return { nombre, ...red, rpc, rpcPropio: rpc !== red.rpc }
}

// -----------------------------------------------------------------------------
// D30.1 — DONDE VIVE EL KEYSTORE, Y POR QUE NO PUEDE SER %TEMP%
// -----------------------------------------------------------------------------
//
// `swarmStorageDir()` mandaba TODO el storage a `os.tmpdir()` cuando el nodo
// corre bajo `bare` —o sea, en desarrollo, que es exactamente donde se va a
// probar el fondeo—. Para un Corestore que se puede volver a bajar eso es
// aceptable. Para una wallet no: **Windows limpia temp**, y ahí adentro la
// pérdida no es de caché sino de la única copia de una seed que quizá nadie
// anotó. Es precondición de fondear cualquier cosa, testnet incluida.
//
// La regla es simple: el keystore va al directorio PERSISTENTE, siempre, aunque
// el resto del storage esté en temp. Un `--storage` explícito se respeta —es una
// decisión del operador y no nuestra— pero si cae adentro de temp se avisa, en
// vez de dejar que se descubra el día que el archivo no está.
//
// Se separa del resto del storage a propósito: son dos cosas con vidas útiles
// distintas y juntarlas fue lo que creó el problema.
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
        ? `el --storage apunta adentro de ${temp}, que el sistema operativo limpia`
        : null
    }
  }

  if (!persistente) {
    throw new Error('wallet: no hay directorio persistente donde poner el keystore')
  }

  // NUNCA temp. Ni en dev. Ese es todo el arreglo de D30.1.
  const dir = app ? path.join(persistente, app) : path.resolve(String(persistente))
  return {
    dir,
    volatil: estaAdentroDe(dir, temp),
    motivo: estaAdentroDe(dir, temp)
      ? `el directorio persistente de esta plataforma cae adentro de ${temp}`
      : null
  }
}

// Windows compara rutas sin distinguir mayúsculas, y este chequeo tiene que
// fallar hacia "sí es temp" y no hacia "no lo es": el costo de un aviso de más
// es una línea en pantalla, y el de uno de menos es una wallet borrada.
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

// Deriva la clave de cifrado desde la passphrase. Argon2id vía sodium, con los
// parámetros MODERATE: ~0,5 s por derivación en la máquina de referencia.
//
// Ese medio segundo es a propósito y es lo único que hace que una passphrase
// corta valga algo: sin un KDF caro, probar un diccionario entero contra el
// keystore es instantáneo. Se paga UNA vez por arranque.
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

// Genera una frase BIP-39 nueva. La entropía sale de sodium y no de
// `bip39.generateMnemonic`, que bajo Bare no corre: ver el encabezado.
export function generarFrase() {
  const entropia = Buffer.alloc(ENTROPIA_BYTES)
  sodium.randombytes_buf(entropia)
  const frase = bip39.entropyToMnemonic(entropia, wordlist)
  // Se valida lo que acabamos de generar. No es paranoia gratuita: un checksum
  // mal armado se descubriría recién el día que alguien intente restaurar la
  // wallet desde el papel donde la anotó, que es el peor momento posible.
  if (!bip39.validateMnemonic(frase, wordlist)) {
    throw new Error('wallet: la frase generada no valida contra BIP-39')
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
// El onboarding desde el panel (crear la wallet sin `pyrusllm wallet --crear`)
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

// Escribe el keystore. Atómico —temporal y rename encima— por la misma razón
// que budget.json y apikeys.json: un archivo cortado a la mitad acá es una
// wallet perdida, no un contador perdido.
function guardar(dir, sobre) {
  const destino = rutaDe(dir)
  const tmp = destino + '.tmp'
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(sobre, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, destino)
}

// Cifra una frase con la passphrase y devuelve el sobre que va a disco.
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
    // La frase cifrada. NO hay ningún campo en claro que la delate, y en
    // particular NO se guarda la dirección: guardarla dejaría que alguien sin la
    // passphrase leyera igual a dónde cobra este nodo, que es justo lo que el
    // manifiesto firmado tiene que ser el único en decir.
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
  // Fallar cerrado: ver el encabezado. Abrir con basura sería anunciar una
  // dirección que nadie controla.
  if (!abrio) return null
  return claro.toString('utf8')
}

// -----------------------------------------------------------------------------
// La cuenta
// -----------------------------------------------------------------------------

// La dirección se deriva SIN red. Está medido en el spike y es la condición para
// que el nodo pueda armar su manifiesto firmado sin depender de que haya un RPC
// alcanzable: si hiciera falta, un nodo sin internet no podría ni anunciarse.
//
// El `provider` se le pasa igual porque WDK lo pide en el constructor; no se usa
// hasta que alguien mande una transacción, que es Fase 9 en adelante.
// D30.2 — el RPC ya no es una constante escondida acá. `red` es lo que resolvió
// `redDe()`, y `rpc` puede pisarlo para un caso puntual (los tests le pasan uno
// que no existe, justamente para probar que no hace falta que exista).
async function cuentaDesde(frase, rpc, red) {
  const elegida = red || redDe({})
  const url = rpc || elegida.rpc

  const mod = await import('@tetherto/wdk-wallet-evm')
  const WalletManagerEvm = mod.default || mod
  const manager = new WalletManagerEvm(frase, { provider: url })
  const cuenta = await manager.getAccount()
  const address = await cuenta.getAddress()
  // El mismo pattern que exige el schema congelado. Si WDK cambiara de formato,
  // esto lo dice acá y no al validar el manifiesto tres saltos más adelante.
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('wallet: WDK devolvio una direccion que no matchea el schema: ' + address)
  }
  // La red viaja de vuelta para que quien abrió pueda DECIRLA: un nodo que cobra
  // contra 9745 y uno que cobra contra 9746 no se pueden ver igual en pantalla.
  return { manager, cuenta, address, rpc: url, red: elegida }
}

// -----------------------------------------------------------------------------
// La API que usa el arranque
// -----------------------------------------------------------------------------

// Crea la wallet del nodo y la deja cifrada en `<dir>/wallet.json`.
//
// Devuelve la frase EN CLARO una única vez, para que quien llama pueda
// mostrársela al operador y que la anote. No se vuelve a poder leer sin la
// passphrase, y ese es el punto.
export async function crear(dir, passphrase, { rpc = null, red = null, frase = null } = {}) {
  if (!passphrase) throw new Error('wallet: hace falta una passphrase para cifrar la seed')
  if (existe(dir)) throw new Error('wallet: ya hay una wallet en ' + rutaDe(dir))

  // `frase` permite RESTAURAR desde un respaldo, que es la otra mitad de que la
  // frase se muestre una vez. Sin esto, perder el keystore sería perder la
  // wallet aunque el operador tenga las 24 palabras anotadas.
  const semilla = frase ? String(frase).trim() : generarFrase()
  if (frase && !fraseValida(semilla)) {
    throw new Error('wallet: la frase de respaldo no valida contra BIP-39')
  }

  const { address } = await cuentaDesde(semilla, rpc, red)
  guardar(dir, cifrar(semilla, passphrase))
  return { address, frase: semilla, restaurada: !!frase }
}

// Abre la wallet existente. Devuelve `null` si no hay ninguna — que es el caso
// NORMAL de un nodo que todavía no cobra, no un error.
//
// Si hay wallet pero la passphrase falta o no abre, eso SÍ es un error y se
// dice: alguien configuró una wallet y el nodo no la puede usar, y la diferencia
// con "no hay wallet" tiene que verse.
export async function abrir(dir, passphrase, { rpc = null, red = null } = {}) {
  if (!existe(dir)) return null

  let sobre
  try {
    sobre = JSON.parse(fs.readFileSync(rutaDe(dir), 'utf8'))
  } catch (err) {
    throw new Error('wallet: ' + rutaDe(dir) + ' ilegible: ' + ((err && err.message) || err))
  }

  if (!sobre || sobre.version !== VERSION) {
    throw new Error('wallet: ' + rutaDe(dir) + ' es de otra version y no se abre a medias')
  }
  if (!passphrase) {
    throw new Error(
      'wallet: hay una wallet cifrada y falta la passphrase: pone la variable de entorno ' +
        VAR_PASSPHRASE
    )
  }

  const frase = descifrar(sobre, passphrase)
  if (frase === null) {
    throw new Error('wallet: la passphrase de ' + VAR_PASSPHRASE + ' no abre el keystore')
  }

  return cuentaDesde(frase, rpc, red)
}

// El bloque `economic` del manifiesto, armado desde una dirección real.
//
// Se arma ACA y no en manifest.mjs para que manifest.mjs no tenga que importar
// WDK: el manifiesto se construye y se verifica en caminos que no tienen wallet
// —los tests, y cualquier par verificando el manifiesto de OTRO— y cargar el
// stack de una wallet para eso sería pagarlo en todos lados.
export function economicDe(address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(address || ''))) {
    throw new Error('wallet: economicDe necesita una direccion EVM valida')
  }
  return { walletAddress: address, chains: CHAINS, settlement: SETTLEMENT }
}
