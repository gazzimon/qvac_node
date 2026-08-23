// Registro en memoria de API keys para consumir el gateway desde AFUERA del
// panel: tu propia terminal, OpenClaw (Telegram/WhatsApp), Hermes Agent, Open
// WebUI, o cualquier cliente OpenAI-compatible.
//
// Mismo criterio que store.mjs: sin persistencia, se resetea con el proceso.
// Para una demo alcanza y evita tener que limpiar estado entre corridas.
//
// El azar SI es criptografico: hypercore-crypto ya esta en el arbol de
// dependencias (lo usa swarm.mjs para la identidad del nodo), asi que no hay
// excusa para Math.random en algo que despues viaja como credencial en un
// header Authorization.

import crypto from 'hypercore-crypto'

const keys = new Map() // id -> { id, key, label, nodeId, createdAt, lastUsedAt }

// base64url sobre bytes aleatorios reales. Se evitan +/= para que la key se
// pueda pegar en una URL, en un YAML o en un JSON5 sin escaparla.
function randomToken(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function createKey({ label = 'sin nombre', nodeId = null } = {}) {
  const id = randomToken(6)
  const key = `qvac_sk_${randomToken(24)}`
  const entry = { id, key, label, nodeId, createdAt: Date.now(), lastUsedAt: null }
  keys.set(id, entry)
  return entry // el texto plano de "key" solo se devuelve ESTA vez
}

// Una key por nodo: apretar "Conectar" dos veces sobre la misma tarjeta tiene
// que devolver la MISMA credencial, no llenar el registro de keys huerfanas
// que el usuario ya pego en un config y no puede distinguir.
export function keyForNode(nodeId, label) {
  for (const entry of keys.values()) {
    if (entry.nodeId === nodeId) return entry
  }
  return createKey({ label, nodeId })
}

function mask(entry) {
  return {
    id: entry.id,
    label: entry.label,
    nodeId: entry.nodeId,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    preview: entry.key.slice(0, 12) + '…' + entry.key.slice(-4)
  }
}

export function listKeys() {
  return [...keys.values()].map(mask)
}

export function revokeKey(id) {
  return keys.delete(id)
}

// Comparacion en tiempo constante. Una key es una credencial y `===` corta en
// el primer byte distinto, o sea que el tiempo filtra el prefijo. Con pocas
// keys en memoria el riesgo es teorico, pero hacerlo bien cuesta seis lineas.
// (hypercore-crypto NO exporta constantTimeEqual -sus exports son keyPair,
// sign, verify, data, hash, randomBytes...-, asi que se hace a mano.)
function equalConstantTime(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function verifyKey(rawKey) {
  if (!rawKey) return null
  for (const entry of keys.values()) {
    if (equalConstantTime(entry.key, rawKey)) {
      entry.lastUsedAt = Date.now()
      return entry
    }
  }
  return null
}

export function reset() {
  keys.clear()
}
