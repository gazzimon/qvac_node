// In-memory registry of API keys to use the gateway from OUTSIDE the
// panel: your own terminal, OpenClaw (Telegram/WhatsApp), Hermes Agent, Open
// WebUI, or any OpenAI-compatible client.
//
// It PERSISTS, and since Phase 6.5 that's NOT a nicety: it's the condition for
// the spending cap to exist at all.
//
// The ledger charges consumption to the account, and the account IS the key
// (gateway.mjs, `cuentaDe`). With an in-memory registry that id didn't survive
// the process: the client reconnected, got handed a new key, and started over
// with the full cap again -- while `budget.json` piled up orphan accounts that
// nobody would ever claim. A cap that resets on restart isn't a cap.
//
// And it fixes something that wasn't a declared bug but felt like one: every
// node restart invalidated the config of EVERY client -- the Telegram bot,
// Open WebUI, the terminal -- which then had to go fetch a new key from the
// panel.
//
// THE KEY IS STORED IN PLAINTEXT, and that's a decision, not an oversight. The
// same directory already stores the network seed in plaintext (identity.mjs),
// the gateway only listens on 127.0.0.1, and the panel exists precisely so you
// can copy a key again weeks later (see `listKeysFull`). Hashing it would force
// rotating the credential every time someone failed to save it, which is worse
// for this threat model. What CANNOT go in plaintext is the wallet seed: that's
// D13 and a different matter.
//
// The randomness IS cryptographic though: hypercore-crypto is already in the
// dependency tree (swarm.mjs uses it for the node identity), so there's no
// excuse for Math.random on something that later travels as a credential in an
// Authorization header.

import crypto from 'hypercore-crypto'
import fs from 'bare-fs'
import path from 'bare-path'

// Bumps when the shape of a row changes. A file from another version gets
// discarded wholesale, with a warning, instead of loading half-baked rows.
const VERSION = 1

const keys = new Map() // id -> { id, key, label, nodeId, createdAt, lastUsedAt }

// Monotonic: only goes up, never decremented by revokeKey. `keys.size` alone
// would undercount "how many clients have ever connected" once someone
// revokes a key -- this is the lifetime count that survives that.
let totalEverIssued = 0

// base64url over real random bytes. +/= are avoided so the key can be pasted
// into a URL, a YAML, or a JSON5 without escaping it.
function randomToken(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// `null` => everything in memory. That's the path used by tests and by a node
// with no storage directory.
let archivo = null

// Atomic write, same as budget.mjs: temp file then rename on top. A
// writeFileSync cut in half leaves an invalid JSON, and losing this file means
// losing the identity of the accounts -- i.e. resetting every cap.
function guardar() {
  if (!archivo) return
  const tmp = archivo + '.tmp'
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: VERSION, keys: [...keys.values()], totalEverIssued }, null, 2),
      {
        // Owner only. On Windows this is a no-op (the mode is ignored), but the
        // file still ends up under the user's %LOCALAPPDATA%.
        mode: 0o600
      }
    )
    fs.renameSync(tmp, archivo)
  } catch (err) {
    console.error(`[apikeys] could not save the registry: ${(err && err.message) || err}`)
    console.error('[apikeys] keys are running IN MEMORY: the spending cap resets with the process')
    archivo = null
  }
}

// Opened BEFORE the gateway, for the same reason as the ledger: a key that
// arrives before the registry is loaded would be an unknown key.
export function open(dir) {
  archivo = dir ? path.join(dir, 'apikeys.json') : null
  keys.clear()
  totalEverIssued = 0
  if (!archivo) return 0

  try {
    const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'))
    if (!crudo || crudo.version !== VERSION) {
      if (crudo) console.error(`[apikeys] ${archivo} is from another version, starting fresh`)
      return 0
    }
    for (const e of Array.isArray(crudo.keys) ? crudo.keys : []) {
      // A row with no id or no key is useless and would break `verifyKey`,
      // which compares lengths.
      if (!e || typeof e.id !== 'string' || typeof e.key !== 'string') continue
      keys.set(e.id, {
        id: e.id,
        key: e.key,
        label: typeof e.label === 'string' ? e.label : 'unnamed',
        nodeId: typeof e.nodeId === 'string' ? e.nodeId : null,
        createdAt: Number(e.createdAt) || Date.now(),
        lastUsedAt: Number(e.lastUsedAt) || null
      })
    }
    // A file from before this counter existed has no way to know how many
    // keys were issued and later revoked: `keys.size` is the best available
    // floor, not a lie -- it just can't see revocations from the past.
    totalEverIssued = Number.isFinite(Number(crudo.totalEverIssued))
      ? Math.max(Number(crudo.totalEverIssued), keys.size)
      : keys.size
  } catch {
    // Doesn't exist yet: first boot.
  }
  return keys.size
}

// Persists the accumulated `lastUsedAt`. `verifyKey` touches it on EVERY
// request and doesn't save: an fsync per request to write a cosmetic
// timestamp would mean paying disk latency on the hot path. The account and
// the cap don't depend on that field -- they depend on the id, which only
// changes on create or revoke, and those DO save right away.
export function close() {
  guardar()
  archivo = null
}

export function createKey({ label = 'unnamed', nodeId = null } = {}) {
  const id = randomToken(6)
  const key = `qvac_sk_${randomToken(24)}`
  const entry = { id, key, label, nodeId, createdAt: Date.now(), lastUsedAt: null }
  keys.set(id, entry)
  totalEverIssued += 1
  guardar()
  return entry
}

// One key per node: clicking "Connect" twice on the same card has to return
// the SAME credential, not fill the registry with orphan keys that the user
// already pasted into a config and can no longer tell apart.
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

// Same as listKeys but with the credential in plaintext.
//
// Local panel only: the gateway listens only on 127.0.0.1 and the whole point
// of that screen is to be able to copy a key again into a bot's config weeks
// later. Masking it there would force rotating it every time someone forgets
// to save it, which is worse than showing it on a page only reachable from
// this machine. `mask()` still exists for any consumer that isn't local.
export function listKeysFull() {
  return [...keys.values()].map((e) => ({
    id: e.id,
    label: e.label,
    key: e.key,
    createdAt: e.createdAt,
    lastUsedAt: e.lastUsedAt
  }))
}

export function count() {
  return keys.size
}

// Windowed activity off `lastUsedAt` -- same criterion as
// network-stats.mjs's getNetworkStats: computed on read, not kept as
// separate counters that could drift out of sync with the field they
// describe. A key that was issued but never used has `lastUsedAt: null` and
// doesn't count toward any window, only toward `totalEverIssued`.
export function getKeyStats({ now = Date.now() } = {}) {
  const DIA_MS = 24 * 60 * 60 * 1000
  const SEMANA_MS = 7 * DIA_MS
  const MES_MS = 30 * DIA_MS

  let active24h = 0
  let active7d = 0
  let active30d = 0

  for (const entry of keys.values()) {
    if (!Number.isFinite(entry.lastUsedAt)) continue
    const edad = now - entry.lastUsedAt
    if (edad <= DIA_MS) active24h++
    if (edad <= SEMANA_MS) active7d++
    if (edad <= MES_MS) active30d++
  }

  return {
    active24h,
    active7d,
    active30d,
    totalCurrent: keys.size,
    totalEverIssued
  }
}

export function revokeKey(id) {
  const habia = keys.delete(id)
  if (habia) guardar()
  return habia
}

// Constant-time comparison. A key is a credential and `===` short-circuits on
// the first differing byte, meaning timing leaks the prefix. With few keys in
// memory the risk is theoretical, but doing it right costs six lines.
// (hypercore-crypto does NOT export constantTimeEqual -its exports are
// keyPair, sign, verify, data, hash, randomBytes...-, so it's done by hand.)
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

// Returns how many it revoked. Without that number the UI could only say "the
// current key was revoked", which is a lie when several have been issued.
export function reset() {
  const n = keys.size
  keys.clear()
  guardar()
  return n
}
