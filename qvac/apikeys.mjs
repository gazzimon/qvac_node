// Registro en memoria de API keys para consumir el gateway desde afuera del
// panel -tu propia terminal, Hermes Agent, cualquier cliente OpenAI-
// compatible-. Mismo criterio que store.mjs: sin persistencia, se resetea
// con el proceso. El azar es Math.random (demo), no criptografico -si esto
// sale de la demo hay que pasarlo a algo del propio runtime (sodium-native
// ya esta en el arbol de dependencias via hyperswarm).

const keys = new Map() // id -> { id, key, label, createdAt, lastUsedAt }

function randomToken(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export function createKey(label = 'sin nombre') {
  const id = randomToken(8)
  const key = `qvac_sk_${randomToken(32)}`
  const entry = { id, key, label, createdAt: Date.now(), lastUsedAt: null }
  keys.set(id, entry)
  return entry // el texto plano de "key" solo se devuelve ESTA vez
}

function mask(entry) {
  return {
    id: entry.id,
    label: entry.label,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    preview: entry.key.slice(0, 11) + '…' + entry.key.slice(-4)
  }
}

export function listKeys() {
  return [...keys.values()].map(mask)
}

export function revokeKey(id) {
  return keys.delete(id)
}

export function verifyKey(rawKey) {
  if (!rawKey) return null
  for (const entry of keys.values()) {
    if (entry.key === rawKey) {
      entry.lastUsedAt = Date.now()
      return entry
    }
  }
  return null
}
