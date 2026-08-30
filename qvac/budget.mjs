// The consumption counter with a cutoff. Phase 6.5 of ROADMAP_FASE7-X402.
//
// Tracks, per account and per month, how much was spent and how much of the
// cap remains. It's the "knows about balances" half of the phase; the one
// that knows about prices is costs.mjs.
//
// -----------------------------------------------------------------------------
// WHY RESERVATION AND NOT ACCOUNTING
//
// R5.3 of the ROADMAP: a cap applied at billing time is a discount, because
// the spend already happened and someone already paid it. For it to be a CAP
// it has to be evaluated before the request is sent.
//
// But before the request you don't know how much it'll cost -- R3: cost
// depends on the tokens generated, which don't exist yet. The way out of that
// bind is the two-step pattern:
//
//   1. reserve()  sets aside the UPPER BOUND of the cost (costs.estimar) and
//                 persists it. If it doesn't fit what's left, it's rejected
//                 HERE and the request never goes out.
//   2. settle()   the request finished: the reservation is swapped for the
//                 REAL cost (costs.real) and the difference goes back to the
//                 balance.
//
// Between the two moments the balance is committed, so two simultaneous
// requests can't spend the same dollars.
//
// -----------------------------------------------------------------------------
// WHY IT WRITES ON RESERVE AND NOT ON SETTLE
//
// If only the settled spend were persisted, a power outage mid-request would
// lose that consumption: the process comes back, the counter never saw it,
// and the cap lets through more than agreed. That's why the reservation is
// written to disk BEFORE the request goes out (write-ahead).
//
// And on open, a reservation left over from a previous run gets charged IN
// FULL, at the estimate, because there's no way to know what it actually
// cost. That overcharges and cuts off early. It's deliberate: the cap exists
// to protect whoever's paying, so when there's a choice of which way to be
// wrong, it errs on the side of spending less.
// -----------------------------------------------------------------------------

import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { usdAMicros } from './costs.mjs'

// The default cap, in costs.mjs's unit. USD 20 per account per month.
export const TOPE_DEFAULT_MICROS = usdAMicros(20)

// B13 — THE NODE CAP, and it's the one that actually bounds the bill.
//
// The cap above is PER ACCOUNT, and the account is the API key. That's fine
// as a granularity -- you want to be able to cut off one bot without cutting
// off another -- but it doesn't bound what actually gets paid: the external
// provider's bill is a SINGLE one, against the operator's single credential.
// With N keys issued, the real ceiling was N x USD 20 of real money, and keys
// get issued on their own (one per node when you click "Connect").
//
// So there are two caps and BOTH get evaluated: the account one says how much
// THAT client can spend, the node one says how much this machine can spend in
// total. A request passes if it fits within both. Keys end up as SUB-CAPS of
// this one, which is the shape the roadmap was already promising when it said
// "the USD 20 cap".
export const TOPE_NODO_DEFAULT_MICROS = usdAMicros(20)

const VERSION = 1

let estado = null // { version, period, accounts, pending, history }
let archivo = null // path to the JSON, or null if running in-memory only

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

// The calendar month in UTC. UTC and not local time because the cutoff has to
// land at the same instant for every node in the network: with local time,
// two machines in different timezones close the month at different moments
// and the end-of-month split doesn't add up.
export function periodoDe(now = Date.now()) {
  const d = new Date(now)
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mes}`
}

function estadoVacio(now) {
  return {
    version: VERSION,
    period: periodoDe(now),
    accounts: {},
    pending: {},
    history: [],
    nodeCap: TOPE_NODO_DEFAULT_MICROS
  }
}

// Called on EVERY operation, not on a timer. A timer doesn't run if the
// process was down for all of March 1st, and then the first request of April
// would get charged against March's balance. Checking on use can't be late.
function rotarSiCambioElMes(now) {
  const actual = periodoDe(now)
  if (estado.period === actual) return false

  // The period that's closing gets saved: it's what feeds the end-of-month
  // split. Without this, at 00:00 UTC on the 1st the month that needs
  // billing disappears.
  estado.history.unshift({
    period: estado.period,
    accounts: estado.accounts,
    closedAt: now
  })
  estado.history = estado.history.slice(0, 12)

  estado.period = actual
  // Caps survive the month change; spend doesn't. That's the definition of
  // "monthly cap".
  const topes = {}
  for (const [id, cuenta] of Object.entries(estado.accounts)) {
    topes[id] = { spent: 0, cap: cuenta.cap }
  }
  estado.accounts = topes
  estado.pending = {}
  return true
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// Atomic write: a temp file is written and renamed on top. A direct
// writeFileSync cut in half leaves an invalid JSON, and this file is the one
// that says how much money was spent -- losing it to a power outage means the
// cap starts from zero at the worst possible moment.
function guardar() {
  if (!archivo) return
  const tmp = archivo + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2))
    fs.renameSync(tmp, archivo)
  } catch (err) {
    // The process doesn't get killed: a node that can't write the ledger can
    // still serve local inference, which is free. But it's said out loud,
    // because it changes what the cap guarantees.
    console.error(`[budget] could not save the ledger: ${(err && err.message) || err}`)
    console.error('[budget] the cap is running IN MEMORY: it resets with the process')
    archivo = null
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// `dir` null => everything in memory (tests, and the no-storage path).
// Returns how many orphan reservations it found, because that needs to be
// logged: those are requests that went out and nobody knows how they ended.
export function open(dir, { now = Date.now() } = {}) {
  archivo = dir ? path.join(dir, 'budget.json') : null
  estado = estadoVacio(now)

  if (archivo) {
    try {
      const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'))
      if (crudo && crudo.version === VERSION) {
        estado = {
          version: VERSION,
          period: typeof crudo.period === 'string' ? crudo.period : periodoDe(now),
          accounts: crudo.accounts && typeof crudo.accounts === 'object' ? crudo.accounts : {},
          pending: crudo.pending && typeof crudo.pending === 'object' ? crudo.pending : {},
          history: Array.isArray(crudo.history) ? crudo.history : [],
          // A ledger written before B13 doesn't have the field. The default
          // is used instead of treating it as "no cap": an old file can't
          // mean the machine spends without a ceiling.
          nodeCap: Number.isFinite(Number(crudo.nodeCap))
            ? Math.max(0, Math.floor(Number(crudo.nodeCap)))
            : TOPE_NODO_DEFAULT_MICROS
        }
      } else if (crudo) {
        console.error(`[budget] ${archivo} is from another version, starting fresh`)
      }
    } catch {
      // Doesn't exist yet: first boot.
    }
  }

  // Reservations from a previous run: charged in full. See the note in the
  // header -- there's no way to know what they actually cost, and the safe
  // side is to charge the estimate.
  const huerfanas = Object.values(estado.pending)
  for (const r of huerfanas) {
    const cuenta = cuentaDe(r.account)
    cuenta.spent += r.micros
  }
  estado.pending = {}

  rotarSiCambioElMes(now)
  if (huerfanas.length) {
    console.error(
      `[budget] ${huerfanas.length} unsettled reservation(s) from a previous run: charged at the estimate`
    )
    guardar()
  }
  return huerfanas.length
}

export function close() {
  if (estado) guardar()
  estado = null
  archivo = null
}

// For tests: clean memory, no disk.
export function reset({ now = Date.now() } = {}) {
  archivo = null
  estado = estadoVacio(now)
}

function asegurarAbierto() {
  if (!estado) estado = estadoVacio(Date.now())
  return estado
}

function cuentaDe(accountId) {
  const s = asegurarAbierto()
  if (!s.accounts[accountId]) {
    s.accounts[accountId] = { spent: 0, cap: TOPE_DEFAULT_MICROS }
  }
  return s.accounts[accountId]
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export function setCap(accountId, micros) {
  const n = Math.floor(Number(micros))
  cuentaDe(accountId).cap = Number.isFinite(n) && n >= 0 ? n : 0
  guardar()
}

export function capOf(accountId) {
  return cuentaDe(accountId).cap
}

// B13 — the machine's aggregate cap. Read and set separately from the account
// one because they're two different things: one bounds a client, the other
// bounds the bill.
export function setNodeCap(micros) {
  const n = Math.floor(Number(micros))
  asegurarAbierto().nodeCap = Number.isFinite(n) && n >= 0 ? n : 0
  guardar()
  return estado.nodeCap
}

export function nodeCap() {
  const s = asegurarAbierto()
  return Number.isFinite(s.nodeCap) ? s.nodeCap : TOPE_NODO_DEFAULT_MICROS
}

// What's spent and committed by ALL accounts on the node. It's the number
// compared against the node cap, and the one that resembles the bill.
export function nodeUsage({ now = Date.now() } = {}) {
  asegurarAbierto()
  if (rotarSiCambioElMes(now)) guardar()

  let spent = 0
  for (const c of Object.values(estado.accounts)) spent += Number(c.spent) || 0
  let reserved = 0
  for (const r of Object.values(estado.pending)) reserved += Number(r.micros) || 0

  const cap = nodeCap()
  return {
    period: estado.period,
    spent,
    reserved,
    cap,
    remaining: Math.max(0, cap - spent - reserved)
  }
}

// How much is committed right now by in-flight requests of this account.
function reservadoDe(accountId) {
  let total = 0
  for (const r of Object.values(asegurarAbierto().pending)) {
    if (r.account === accountId) total += r.micros
  }
  return total
}

export function usage(accountId, { now = Date.now() } = {}) {
  asegurarAbierto()
  if (rotarSiCambioElMes(now)) guardar()

  const cuenta = cuentaDe(accountId)
  const reserved = reservadoDe(accountId)
  return {
    period: estado.period,
    account: accountId,
    spent: cuenta.spent,
    reserved,
    cap: cuenta.cap,
    // Never negative: if an orphan reservation pushed spend above the cap,
    // what's left is zero, not a debt.
    remaining: Math.max(0, cuenta.cap - cuenta.spent - reserved)
  }
}

// ---------------------------------------------------------------------------
// Reservation and settlement
// ---------------------------------------------------------------------------

// Returns { ok, id } or { ok:false, reason, ... }, not a bare boolean or an
// exception. Same reason as verifyManifest in manifest.mjs: the caller has to
// be able to TELL THE USER why they can't spend, and "false" doesn't explain
// itself to anyone.
export function reserve(accountId, micros, { now = Date.now() } = {}) {
  asegurarAbierto()
  if (rotarSiCambioElMes(now)) guardar()

  const monto = Math.max(0, Math.ceil(Number(micros) || 0))

  // Zero cost -- local inference or a peer's -- doesn't touch the ledger or
  // disk. It's the common path and has to be free in every sense. Still
  // returns a valid reservation, so the gateway has ONE single flow and not
  // an `if` around every call.
  if (monto === 0) return { ok: true, id: null, micros: 0 }

  // The TWO caps, and the request passes only if it fits both (B13). The
  // order doesn't change the result but it does change the message: the one
  // that actually ran out gets reported, because "you can't afford it"
  // without saying which ceiling you hit isn't actionable -- lowering a
  // key's cap doesn't fix a node with no balance.
  const estadoCuenta = usage(accountId, { now })
  if (monto > estadoCuenta.remaining) {
    return {
      ok: false,
      // NOTE: kept in Spanish — test/index.js:913 asserts on this exact
      // string, and gateway.mjs reuses the same literal.
      reason: 'presupuesto agotado',
      scope: 'cuenta',
      remaining: estadoCuenta.remaining,
      cap: estadoCuenta.cap,
      needed: monto
    }
  }

  const estadoNodo = nodeUsage({ now })
  if (monto > estadoNodo.remaining) {
    return {
      ok: false,
      // NOTE: kept in Spanish — gateway.mjs reuses this same literal.
      reason: 'presupuesto del nodo agotado',
      scope: 'nodo',
      remaining: estadoNodo.remaining,
      cap: estadoNodo.cap,
      needed: monto
    }
  }

  const id = 'r_' + crypto.randomBytes(8).toString('hex')
  estado.pending[id] = { account: accountId, micros: monto, startedAt: now }
  guardar() // write-ahead: to disk BEFORE the request goes out
  return { ok: true, id, micros: monto }
}

// The request finished. `realMicros` is what it actually cost; the
// difference against the reservation goes back to the balance.
//
// Charges the LESSER of the real cost and what was reserved. If the real cost
// came out higher than the upper bound, the mistake is in the estimate, not
// the user's: charging them more than what was set aside for them would blow
// past the cap through the back window, which is exactly what this phase
// exists to prevent.
export function settle(id, realMicros) {
  if (!id) return 0
  const s = asegurarAbierto()
  const r = s.pending[id]
  if (!r) return 0

  const real = Math.max(0, Math.ceil(Number(realMicros) || 0))
  const cobrado = Math.min(real, r.micros)

  cuentaDe(r.account).spent += cobrado
  delete s.pending[id]
  guardar()
  return cobrado
}

// The request never spent anything (it failed before going out, or got
// cancelled). The full reservation is released.
export function release(id) {
  if (!id) return false
  const s = asegurarAbierto()
  if (!s.pending[id]) return false
  delete s.pending[id]
  guardar()
  return true
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

// Consumption attributed per account. Without `period` it returns the current
// month; with a closed period, what was saved in the history.
//
// This is the answer to "at the end of the month, split the tokens among all
// the users": the split isn't computed at the end, it's ACCUMULATED all month
// long, and this function only reads it. A split computed at closing time
// from a log depends on the log being complete; this number is the same one
// that cut things off.
export function report({ period = null, now = Date.now() } = {}) {
  asegurarAbierto()
  if (rotarSiCambioElMes(now)) guardar()

  let cuentas = estado.accounts
  let cual = estado.period
  if (period && period !== estado.period) {
    const viejo = estado.history.find((h) => h.period === period)
    if (!viejo) return { period, total: 0, accounts: [], found: false }
    cuentas = viejo.accounts
    cual = period
  }

  const filas = Object.entries(cuentas)
    .map(([account, c]) => ({ account, spent: c.spent, cap: c.cap }))
    .filter((f) => f.spent > 0)
    .sort((a, b) => b.spent - a.spent)

  return {
    period: cual,
    total: filas.reduce((acc, f) => acc + f.spent, 0),
    accounts: filas,
    found: true
  }
}

export function periodoActual() {
  return asegurarAbierto().period
}
