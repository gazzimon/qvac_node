// How much a request costs. A usage goes in, an integer number comes out.
//
// It's the "knows about prices" half of Phase 6.5; the other half -- who
// tracks the balance and cuts off -- is budget.mjs. They're kept separate on
// purpose: the ledger doesn't need to know how much a token costs, and the
// price table doesn't need to know that an account exists.
//
// Doesn't touch the network or the disk, same as manifest.mjs: an object goes
// in, a number comes out. That's why it can be tested without two machines,
// without a loaded model, and without a single API call -- which is why this
// piece comes first within the phase.
//
// -----------------------------------------------------------------------------
// MICROS, NOT FLOATS. Every amount in this file -- and in budget.mjs -- is an
// INTEGER of micro-dollars: 1 USD = 1_000_000 micros. Never a float.
//
// The reason is old and well-known: 0.1 + 0.2 !== 0.3 in floating point. A
// USD 20 cap accumulated in floats over thousands of requests drifts, and it
// drifts RIGHT AT THE EDGE, which is the one place the number matters. With
// integers the cap compares exactly and "spent + this request <= cap" is a
// true-or-false statement, not an approximation.
// -----------------------------------------------------------------------------

export const MICROS_POR_USD = 1_000_000

// Claude API prices in micro-dollars per 1M tokens, checked on 2026-08-25.
//
// THE STANDARD PRICE IS USED ON PURPOSE, NOT THE PROMOTIONAL ONE. Sonnet 5
// has an introductory price (USD 2 / USD 10) that expires 2026-08-31.
// Calibrating the cap with the promotional price is risk #8 of the ROADMAP:
// on September 1st the cost per turn jumps 50% on its own, with nobody
// touching a single line, and a cap calibrated with the old number lets
// through more spend than agreed.
//
// Using the standard price while the promotional one is in effect
// OVERESTIMATES the cost. That cuts off a bit earlier than necessary, which is
// the right side to be wrong on: the cap exists to protect whoever's paying.
export const PRECIOS = {
  'claude-sonnet-5': { entrada: 3_000_000, salida: 15_000_000 },
  'claude-haiku-4-5': { entrada: 1_000_000, salida: 5_000_000 },
  'claude-opus-5': { entrada: 5_000_000, salida: 25_000_000 }
}

// The default external model. D19 leaves it as an open business decision
// (Sonnet 5 gets ~1,480 turns out of the USD 20 cap; Haiku 4.5 gets ~4,400),
// so it lives in ONE constant instead of scattered through the code.
export const MODELO_EXTERNO_DEFAULT = 'claude-sonnet-5'

// Local inference and inference from a peer on the network don't cost
// dollars. Returning an explicit zero -- instead of not calling this function
// on those paths -- means the consumption counter has ONE single entry point
// for every target, and adding Phase 8's pricing later is just changing this
// file and nothing else.
const GRATIS = { entrada: 0, salida: 0 }

// Upstream prices CANNOT live in the table above: which APIs this node uses
// is decided by the operator in their `upstreams.json`, and each account has
// its own list of models and its own rate. They get registered at startup,
// from the config, and stay here so `estimar` and `real` don't need to know
// where the price came from.
//
// An external model with NO declared price doesn't enter this table, and so
// `conocido()` returns false and it estimates zero. That's deliberate and
// dangerous: spend the counter doesn't see is a cap that doesn't cut off.
// That's why the upstream registration (bin.mjs) requires the price before
// letting it go online, instead of letting this table forgive it.
const PRECIOS_EXTERNOS = new Map()

// `entrada`/`salida` in micro-dollars per 1M tokens, the same unit as
// PRECIOS. Returns false if the price isn't usable: whoever registers it
// decides what to do about that, no rate gets invented here.
export function registrarPrecio(modelId, { entrada = 0, salida = 0 } = {}) {
  if (typeof modelId !== 'string' || modelId === '') return false
  const e = Number(entrada)
  const s = Number(salida)
  if (!Number.isFinite(e) || !Number.isFinite(s) || e < 0 || s < 0) return false
  if (e === 0 && s === 0) return false
  PRECIOS_EXTERNOS.set(modelId, { entrada: Math.ceil(e), salida: Math.ceil(s) })
  return true
}

// For tests and for a config reload: the external table is process state, not
// a constant.
export function olvidarPreciosExternos() {
  PRECIOS_EXTERNOS.clear()
}

export function precioDe(modelId) {
  return PRECIOS[modelId] || PRECIOS_EXTERNOS.get(modelId) || GRATIS
}

export function conocido(modelId) {
  return Object.prototype.hasOwnProperty.call(PRECIOS, modelId) || PRECIOS_EXTERNOS.has(modelId)
}

// ALWAYS round up. A request that comes out to 0.4 micros is charged 1: over
// thousands of requests, rounding down accumulates spend the counter never
// sees, and the cap gets exceeded on the side that isn't measured. Rounding
// up errs against us, which is the only safe side.
function porMillon(tokens, precioPorMillon) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.ceil((tokens * precioPorMillon) / 1_000_000)
}

// UPPER BOUND of the cost of a request that hasn't happened yet.
//
// Assumes the model is going to generate the full `maxTokens`, even though it
// almost never does. That's on purpose: this feeds the RESERVATION (see
// budget.mjs), and a reservation that falls short is a cap that gets
// exceeded. The worst case gets reserved and then the real cost gets settled;
// the difference goes back to the balance.
//
// R3 of the ROADMAP says the real cost is known only after responding. This
// function is the answer to that: the cost isn't guessed, it's bounded.
export function estimar({ model, promptTokens = 0, maxTokens = 0 } = {}) {
  const precio = precioDe(model)
  return porMillon(promptTokens, precio.entrada) + porMillon(maxTokens, precio.salida)
}

// REAL cost, with the tokens actually generated. This is what gets settled
// against the reservation.
export function real({ model, promptTokens = 0, completionTokens = 0 } = {}) {
  const precio = precioDe(model)
  return porMillon(promptTokens, precio.entrada) + porMillon(completionTokens, precio.salida)
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

// For the panel and the logs. Four decimals because a typical turn comes out
// to USD 0.0135: with two decimals every request would show "USD 0.01" and
// the number would stop telling a short chat apart from a long one.
export function formatUSD(micros) {
  const usd = (Number(micros) || 0) / MICROS_POR_USD
  return `USD ${usd.toFixed(4)}`
}

// USD -> micros, for reading caps written by a person ("20", "0.10"). Rounds
// down: a cap of 20 is exactly 20_000_000 micros, and if someone writes a cap
// with more precision than a micro, the effective cap is the lower one. A cap
// is never rounded up.
export function usdAMicros(usd) {
  const n = Number(usd)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n * MICROS_POR_USD)
}
