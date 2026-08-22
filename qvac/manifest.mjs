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
export const PROTOCOL_VERSION = '0.1.0'

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

// MOCK MARCADO A PROPOSITO (D2 del ROADMAP).
//
// El schema congelado (manifest-v0.json) pide `economic` y `directory` como
// required, pero WDK/recibos/liquidacion y el directorio append-only estan
// FUERA DE ALCANCE de este track. Estos valores existen solo para que el
// manifiesto valide contra el schema: ni el nodo ni el gateway los leen nunca.
//
// Quedan marcados aca, en el README y en el propio manifiesto (el campo
// `_mock`) por la misma razon por la que el proyecto no tapa fallas del SDK con
// un stub silencioso: si el jurado abre el manifiesto y ve una wallet con plata
// aparentemente real sin ninguna aclaracion, la lectura es peor que si el campo
// directamente no estuviera.
const ECONOMIC_MOCK = {
  _mock: 'NO IMPLEMENTADO — valores fijos para validar el schema. Ver ROADMAP D2.',
  walletAddress: '0x0000000000000000000000000000000000000000',
  chains: ['ethereum-sepolia'],
  settlement: 'batch-receipts'
}

const DIRECTORY_MOCK = {
  _mock: 'NO IMPLEMENTADO — valores fijos para validar el schema. Ver ROADMAP D2.',
  writerPublicKey: '00'.repeat(32),
  discoveryKey: '00'.repeat(32),
  sequence: 0
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
    economic: ECONOMIC_MOCK,
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
    directory: DIRECTORY_MOCK,
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
