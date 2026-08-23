// Login demo por rol para el panel (Cliente/Proveedor/Admin). Gate REAL de
// las rutas del navegador -- no confundir con apikeys.mjs, que emite
// credenciales para consumir el gateway OpenAI-compatible desde AFUERA del
// panel (Telegram, terminal, etc.).
//
// 3 combos fijos, sin base de datos: son credenciales de demo, publicas en
// el repo (ver docs/superpowers/specs/2026-08-23-login-demo-roles-design.md,
// seccion "Seguridad"). Lo que SI es real es el manejo de sesion: token
// aleatorio criptografico y comparacion de password en tiempo constante,
// mismo patron que ya usa apikeys.mjs.
//
// Sesiones en memoria, se resetean con el proceso -- para una demo alcanza y
// evita tener que limpiar estado entre corridas.

import crypto from 'hypercore-crypto'

const USERS = {
  cliente: { password: 'demo123', role: 'cliente' },
  proveedor: { password: 'demo123', role: 'proveedor' },
  admin: { password: 'demo123', role: 'admin' }
}

const sessions = new Map() // token -> { role, createdAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h, alcanza y sobra para una demo

function randomToken(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Compara en tiempo constante: una password es una credencial y `===` corta
// en el primer byte distinto, o sea que el tiempo filtra el prefijo.
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
