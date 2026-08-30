// Demo login by role for the panel (Cliente/Proveedor/Admin). REAL gate for
// the browser routes -- not to be confused with apikeys.mjs, which issues
// credentials to consume the OpenAI-compatible gateway from OUTSIDE the panel
// (Telegram, terminal, etc.).
//
// 3 fixed combos, no database: they're demo credentials, public in the repo
// (see docs/superpowers/specs/2026-08-23-login-demo-roles-design.md, section
// "Seguridad"). What IS real is the session handling: cryptographic random
// token and constant-time password comparison, same pattern apikeys.mjs
// already uses.
//
// In-memory sessions, reset with the process -- plenty for a demo and avoids
// having to clean up state between runs.

import crypto from 'hypercore-crypto'

const USERS = {
  cliente: { password: 'demo123', role: 'cliente' },
  proveedor: { password: 'demo123', role: 'proveedor' },
  admin: { password: 'demo123', role: 'admin' }
}

const sessions = new Map() // token -> { role, createdAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h, more than enough for a demo

function randomToken(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Constant-time comparison: a password is a credential and `===` short-circuits
// on the first differing byte, meaning timing leaks the prefix.
function equalConstantTime(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function login(usuario, password) {
  const entry = USERS[usuario]
  if (!entry || !equalConstantTime(entry.password, String(password || ''))) return null
  const token = randomToken(24)
  sessions.set(token, { role: entry.role, createdAt: Date.now() })
  return token
}

export function verifySession(token) {
  const s = token && sessions.get(token)
  if (!s) return null
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token)
    return null
  }
  return s.role
}

export function logout(token) {
  sessions.delete(token)
}
