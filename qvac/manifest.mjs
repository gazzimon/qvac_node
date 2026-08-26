// Manifiesto del nodo: que modelos sirve, a que precio, y la firma que prueba
// que lo dijo el dueno de esa clave. Fase 2-a del ROADMAP.
//
// No toca la red ni el disco: entra un objeto, sale un objeto. Todo lo que
// hace se puede testear sin dos maquinas (ver test/index.js), que es
// justamente por que esta pieza va primero.
//
// FIRMA: Ed25519 sobre la forma canonica JCS (RFC 8785) del manifiesto sin el
// campo `signature`. JCS y no `JSON.stringify` a secas porque el orden de las
// claves de un objeto de JS no es estable entre implementaciones ni entre
// versiones: dos nodos que serialicen el MISMO manifiesto en distinto orden
// producen bytes distintos, y la firma del otro no verifica nunca. Con JCS los
// bytes son una funcion del contenido, no del orden en que se armo el objeto.

import crypto from 'hypercore-crypto'

export const SCHEMA_VERSION = 0
// 0.2.0: el transporte pasa de FramedStream a un canal Protomux, se agrega
// `files:announce`, y `directory` deja de ser un mock. El schemaVersion NO
// cambia -- la forma del manifiesto es la misma, lo que cambio es el protocolo
// que lo transporta y el contenido de un campo que antes era relleno.
export const PROTOCOL_VERSION = '0.2.0'

// ---------------------------------------------------------------------------
// JCS — RFC 8785
// ---------------------------------------------------------------------------

// Serializacion canonica: claves ordenadas, sin espacios, numeros en la forma
// de ECMAScript. `JSON.stringify` de un primitivo ya cumple el RFC para
// strings y numeros finitos; lo que el RFC agrega es el orden de las claves y
// la prohibicion de NaN/Infinity, que es lo que se implementa aca.
export function canonicalize(value) {
  if (value === null) return 'null'

  const t = typeof value

  if (t === 'boolean') return value ? 'true' : 'false'

  if (t === 'number') {
    // JSON no tiene como representar estos, y `JSON.stringify` los convierte
    // en `null` en silencio: un manifiesto con un precio NaN se firmaria como
    // si el precio fuera null y verificaria perfecto. Mejor cortar.
    if (!Number.isFinite(value)) {
      throw new Error(`JCS: numero no finito (${value}), no se puede canonicalizar`)
    }
    return JSON.stringify(value)
  }

  if (t === 'string') return JSON.stringify(value)

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }

  if (t === 'object') {
    // El RFC ordena por las unidades de codigo UTF-16 de la clave, que es
    // exactamente lo que hace el `sort()` por default de JS sobre strings.
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined) // `undefined` no existe en JSON
      .sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }

  throw new Error(`JCS: tipo no serializable (${t})`)
}

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

// La identidad del nodo ES su par de claves del swarm: el mismo `publicKey`
// que aparece en el manifiesto es el que Hyperswarm anuncia. Sin eso, la firma
// probaria "alguien con esta clave escribio esto" pero no "el peer con el que
// estoy hablando escribio esto" (ver la nota de verifyManifest).
export function createIdentity(seed) {
  return crypto.keyPair(seed)
}

function isHex(s, bytes) {
  return typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s)
}

// ---------------------------------------------------------------------------
// Armado
// ---------------------------------------------------------------------------

// El `economic` DEJO DE SER UN MOCK cuando el nodo tiene wallet (Fase 7).
//
// Hasta la Fase 7 este bloque era un valor fijo con la direccion cero, marcado
// con `_mock` aca, en el README y en el propio manifiesto. Ahora, cuando el
// nodo abre su wallet, lo que se firma es la direccion de cobro REAL que
// devolvio WDK -- la arma `wallet.economicDe()`, que ademas es quien sabe de
// chains y de settlement (D15).
//
// El mock QUEDA, y no por comodidad: hay caminos legitimos sin wallet y tienen
// que poder anunciarse igual. Un nodo que solo consume, uno que todavia no
// creo su wallet, `peers` sin storage, y los tests del manifiesto, que no
// tienen por que cargar el stack de una wallet para probar una firma.
//
// Lo que NO puede pasar es que los dos casos se vean iguales. Por eso el mock
// sigue marcado: si alguien abre el manifiesto y ve una wallet con plata
// aparentemente real sin ninguna aclaracion, la lectura es peor que si el campo
// directamente no estuviera.
const ECONOMIC_MOCK = {
  _mock: 'SIN WALLET — este nodo no declaro direccion de cobro. Ver ROADMAP Fase 7.',
  walletAddress: '0x0000000000000000000000000000000000000000',
  chains: ['ethereum-sepolia'],
  settlement: 'batch-receipts'
}

// Se valida la forma antes de firmarla, por lo mismo que `directorySection`: un
// `economic` mal armado FIRMADO es peor que ninguno. Un consumidor lo verifica
// bien, le manda la plata a lo que diga, y el error aparece cuando ya se pago.
//
// El pattern es el del schema congelado (manifest-v0.json:84) y admite las dos
// familias que soporta el stack: EVM y Tron. Se chequea aca igual que alla
// porque este es el ultimo punto antes de la firma.
function economicSection(economic) {
  if (!economic) return ECONOMIC_MOCK

  const { walletAddress, chains, settlement } = economic
  const evm = /^0x[a-fA-F0-9]{40}$/.test(String(walletAddress || ''))
  const tron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(walletAddress || ''))
  if (!evm && !tron) {
    throw new Error('buildManifest: economic.walletAddress no es una direccion EVM ni Tron')
  }
  // La direccion cero pasa el pattern y no es una direccion: es el valor que
  // tenia el mock. Firmarla seria mandar a pagar a un pozo.
  if (/^0x0{40}$/.test(String(walletAddress))) {
    throw new Error('buildManifest: economic.walletAddress es la direccion cero')
  }
  if (!Array.isArray(chains) || chains.length === 0) {
    throw new Error('buildManifest: economic.chains necesita al menos una red')
  }
  for (const c of chains) {
    if (typeof c !== 'string' || !/^[a-z0-9-]{3,40}$/.test(c)) {
      throw new Error('buildManifest: economic.chains tiene un identificador invalido: ' + c)
    }
  }
  if (!['prepaid-balance', 'batch-receipts', 'onchain-per-job'].includes(settlement)) {
    throw new Error('buildManifest: economic.settlement no es uno de los del schema')
  }

  return { walletAddress, chains: [...chains], settlement }
}

// El directorio DEJO de ser un mock cuando el nodo abre su Hyperbee: la clave
// que se firma aca es la que el par usa para replicarlo (ver directory.mjs).
// El mock queda para los caminos que no montan almacenamiento -- `peers` sin
// storage, y los tests del manifiesto, que no tienen por que abrir un disco.
const DIRECTORY_MOCK = {
  _mock: 'NO IMPLEMENTADO — valores fijos para validar el schema. Ver ROADMAP D2.',
  writerPublicKey: '00'.repeat(32),
  discoveryKey: '00'.repeat(32),
  sequence: 0
}

// Se valida la forma antes de firmarla. Un descriptor mal armado firmado es
// peor que ninguno: el par lo verifica bien, intenta replicar una clave que no
// existe, y el error aparece a tres saltos de donde se origino.
function directorySection(directory) {
  if (!directory) return DIRECTORY_MOCK

  const { writerPublicKey, discoveryKey, sequence } = directory
  if (!isHex(writerPublicKey, 32) || !isHex(discoveryKey, 32)) {
    throw new Error('buildManifest: el directorio necesita claves hex de 32 bytes')
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error('buildManifest: directory.sequence tiene que ser un entero >= 0')
  }

  return { writerPublicKey, discoveryKey, sequence }
}

// Un manifiesto SIN firmar. `signManifest` es el unico que le agrega
// `signature`, para que no exista un camino en el que un manifiesto se arme y
// se mande sin pasar por la firma.
export function buildManifest({
  publicKey,
  models = [],
  operator = 'Nodo QVAC',
  tags = [],
  region = 'sa-east',
  directory = null,
  // La direccion de cobro de ESTE nodo, o null si todavia no tiene wallet.
  // La arma wallet.economicDe(); aca solo se valida y se firma.
  economic = null,
  ttlMs = 24 * 60 * 60 * 1000,
  now = Date.now()
}) {
  const hex = Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : publicKey
  if (!isHex(hex, 32)) {
    throw new Error('buildManifest: publicKey tiene que ser 32 bytes (hex de 64 chars)')
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('buildManifest: hace falta al menos un modelo')
  }

  for (const m of models) {
    if (!m || typeof m.modelId !== 'string' || m.modelId === '') {
      throw new Error('buildManifest: cada modelo necesita un modelId')
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    publishedAt: now,
    expiresAt: now + ttlMs,
    node: {
      hyperswarmPublicKey: hex,
      // D1 decidio que el transporte es FramedStream sobre la conexion de
      // Hyperswarm, NO HTTP: no hay baseUrl al que apuntar. El campo queda por
      // compatibilidad de schema con `openaiCompatible: false` para que nadie
      // intente pegarle a un puerto que no existe en la otra maquina.
      endpoint: { baseUrl: '', openaiCompatible: false },
      region
    },
    economic: economicSection(economic),
    models: models.map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName || m.modelId,
      capabilities: {
        streaming: m.streaming !== false,
        tools: false,
        structuredOutput: ['text']
      },
      qos: {
        maxConcurrentRequests: Number.isFinite(m.maxConcurrentRequests)
          ? m.maxConcurrentRequests
          : 4
      },
      pricing: m.pricing || []
    })),
    security: {
      toolCallPolicy: 'allowlist',
      allowedTools: [],
      maxToolCallsPerRequest: 0
    },
    directory: directorySection(directory),
    metadata: { operator, tags }
  }
}

// ---------------------------------------------------------------------------
// Firma y verificacion
// ---------------------------------------------------------------------------

// Los bytes que se firman: el manifiesto canonicalizado SIN `signature`. Se
// usa la misma funcion al firmar y al verificar, para que no puedan divergir.
function signedBytes(manifest) {
  const { signature, ...rest } = manifest // eslint-disable-line no-unused-vars
  return Buffer.from(canonicalize(rest), 'utf8')
}

export function signManifest(manifest, secretKey) {
  const sig = crypto.sign(signedBytes(manifest), secretKey)
  return { ...manifest, signature: sig.toString('hex') }
}

// Devuelve `{ ok, reason }` en vez de tirar o devolver un booleano pelado: en
// el camino del swarm hay que poder LOGUEAR por que se descarto el manifiesto
// de un peer, y "false" no se puede debuggear a las 3 de la manana.
//
// `expectedPublicKey` NO es opcional en la practica, aunque el argumento lo
// sea. La firma solo prueba que quien tiene la privada de
// `node.hyperswarmPublicKey` armo el manifiesto — y esa clave la elige el
// propio manifiesto. Sin atarla a la clave real de la conexion, cualquiera
// puede armar un manifiesto con SU clave, firmarlo bien, y anunciarse como el
// nodo que quiera: la firma verifica perfecto y no prueba nada util. Quien
// llama desde el swarm tiene que pasar la clave del peer que le dio el socket.
export function verifyManifest(manifest, { expectedPublicKey = null, now = Date.now() } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'el manifiesto no es un objeto' }
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion ${manifest.schemaVersion} desconocida` }
  }
  if (!isHex(manifest.signature, 64)) {
    return { ok: false, reason: 'falta la firma o no es hex de 64 bytes' }
  }

  const pk = manifest.node && manifest.node.hyperswarmPublicKey
  if (!isHex(pk, 32)) {
    return { ok: false, reason: 'node.hyperswarmPublicKey ausente o mal formada' }
  }

  if (expectedPublicKey) {
    const expected = Buffer.isBuffer(expectedPublicKey)
      ? expectedPublicKey.toString('hex')
      : expectedPublicKey
    if (expected !== pk) {
      return {
        ok: false,
        reason: `el manifiesto dice ser de ${pk.slice(0, 8)}… pero la conexion es de ${expected.slice(0, 8)}…`
      }
    }
  }

  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    return { ok: false, reason: 'el manifiesto no anuncia ningun modelo' }
  }

  let ok = false
  try {
    ok = crypto.verify(
      signedBytes(manifest),
      Buffer.from(manifest.signature, 'hex'),
      Buffer.from(pk, 'hex')
    )
  } catch (err) {
    return { ok: false, reason: `no se pudo verificar la firma: ${(err && err.message) || err}` }
  }

  if (!ok) return { ok: false, reason: 'la firma no corresponde al contenido' }

  // La expiracion se REPORTA pero no invalida por si sola: D3 decidio que un
  // candidato vive o muere por el estado del socket, no por un timestamp. Se
  // devuelve para poder loguearlo sin que el reloj desincronizado de una
  // laptop tire abajo un nodo que esta perfectamente vivo.
  const expired = Number.isFinite(manifest.expiresAt) && manifest.expiresAt < now

  return { ok: true, reason: null, expired, publicKey: pk }
}
