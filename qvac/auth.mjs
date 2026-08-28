// Demo login by role for the panel (Client/Provider/Admin). REAL gate for the
// browser routes -- not to be confused with apikeys.mjs, which issues
// credentials to consume the OpenAI-compatible gateway from OUTSIDE the panel
// (Telegram, terminal, etc.).
//
// 3 fixed combos, no database: these are demo credentials, public in the repo
// (see docs/superpowers/specs/2026-08-23-login-demo-roles-design.md, section
// "Security"). What IS real is the session handling: cryptographically random
// token and constant-time password comparison, the same pattern apikeys.mjs
// already uses.
//
// Sessions live in memory and reset with the process -- good enough for a demo
// and it avoids having to clean state between runs.

import crypto from 'hypercore-crypto'

const USERS = {
  client: { password: 'demo123', role: 'client' },
  provider: { password: 'demo123', role: 'provider' },
  admin: { password: 'demo123', role: 'admin' }
}

const sessions = new Map() // token -> { role, createdAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h, plenty for a demo

function randomToken(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Compares in constant time: a password is a credential and `===` bails out at
// the first differing byte, which means the timing leaks the prefix.
function equalConstantTime(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function login(username, password) {
  const entry = USERS[username]
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
