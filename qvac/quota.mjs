// The free quota this node gives away to each peer. Phase 6.6 / D23.
//
// It's the twin of budget.mjs and they're best read together, because the
// symmetry is the point:
//
//                     budget.mjs              quota.mjs
//   what it measures  dollars                 output tokens
//   of whom            the account consuming  the peer requesting
//   who tracks it       the gateway (consumer) the provider (who lends GPU)
//   window             calendar month          24h sliding
//   on exhaustion       degrades to local       rejects and the consumer degrades
//
// Both follow the D18 principle: THE COUNTER LIVES ON THE SIDE THAT PAYS.
// There, whoever pays is whoever spends dollars; here it's whoever lends the
// GPU and the electricity.
//
// -----------------------------------------------------------------------------
// WHY HERE AND NOT IN THE GATEWAY
//
// The gateway belongs to the consumer. Asking it to respect the provider's
// quota is putting the fox in charge of the henhouse: anyone who edits their
// own gateway consumes for free without limit, and the quota becomes
// decorative.
//
// The provider, on the other hand, knows who's asking it without having to
// take anyone's word for it: the peer's key is established by the Hyperswarm
// connection, not by the message content. It's the same property
// verifyManifest relies on to tie a manifest to a socket.
//
// -----------------------------------------------------------------------------
// WHY A SLIDING WINDOW AND NOT "PER DAY"
//
// A cutoff at midnight creates a traffic spike at 00:01 and punishes whoever
// started at 23:50: they burn their whole quota and ten minutes later get
// handed a fresh one. With a sliding window the quota refills gradually, on
// its own, and there's no privileged instant in the day.
//
// The window is implemented with HOURLY BUCKETS, not a list of every
// request. One bucket per hour means 24 numbers per peer -- bounded memory
// even if a peer sends a million requests. The price is granularity: the
// effective window is between 23 and 24 hours, not exactly 24. It's a
// deliberate choice, stated here instead of someone discovering it by
// measuring.
// -----------------------------------------------------------------------------

// D23: 100,000 OUTPUT tokens every 24h, per peer.
//
// Output and not input because those are what cost GPU: the prompt is
// processed once and is cheap, generation is token by token. Counting the
// input would complicate the number without changing who pays for what.
export const CUOTA_TOKENS = 100_000
export const VENTANA_HORAS = 24

const MS_POR_HORA = 60 * 60 * 1000

// peerKey (hex) -> Map<indiceDeHora, tokens>
const baldes = new Map()

let cuotaTokens = CUOTA_TOKENS
let ventanaHoras = VENTANA_HORAS

// The absolute index of the hour `now` falls into. Absolute and not "hour of
// the day": with 0..23 today's buckets and yesterday's would collide, and a
// peer that consumed yesterday at 15:00 would carry that number over to
// 15:00 today.
function horaDe(now) {
  return Math.floor(now / MS_POR_HORA)
}

function baldesDe(peerKey) {
  let m = baldes.get(peerKey)
  if (!m) {
    m = new Map()
    baldes.set(peerKey, m)
  }
  return m
}

// Pruned on read, not with a timer. A timer doesn't run if the process was
// off, and would also keep alive the Map of a peer that never comes back. By
// pruning on read, an inactive peer costs no CPU and its entry cleans itself
// up the next time it shows up.
function podar(m, now) {
  const corte = horaDe(now) - ventanaHoras
  for (const h of m.keys()) {
    if (h <= corte) m.delete(h)
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export function usado(peerKey, { now = Date.now() } = {}) {
  const m = baldesDe(peerKey)
  podar(m, now)
  let total = 0
  for (const v of m.values()) total += v
  return total
}

export function restante(peerKey, { now = Date.now() } = {}) {
  return Math.max(0, cuotaTokens - usado(peerKey, { now }))
}

// Returns { ok, reason, ... } instead of a boolean, for the same reason as
// verifyManifest: the provider needs to be able to send the consumer a
// message explaining what happened and when it refills.
export function check(peerKey, { now = Date.now() } = {}) {
  const usadoAhora = usado(peerKey, { now })
  const queda = Math.max(0, cuotaTokens - usadoAhora)

  if (queda > 0) return { ok: true, used: usadoAhora, remaining: queda, quota: cuotaTokens }

  return {
    ok: false,
    reason: `free quota exhausted: ${usadoAhora}/${cuotaTokens} tokens in the last ${ventanaHoras}h`,
    used: usadoAhora,
    remaining: 0,
    quota: cuotaTokens,
    // When there's something again. This is the actionable data: without it
    // the consumer only knows it can't, not when it could.
    resetsInMs: msHastaQueSeLibere(peerKey, now)
  }
}

// How long until the oldest bucket falls out of the window. It's the first
// instant the quota stops being zero.
function msHastaQueSeLibere(peerKey, now) {
  const m = baldesDe(peerKey)
  podar(m, now)
  if (m.size === 0) return 0
  const masViejo = Math.min(...m.keys())
  const saleEn = (masViejo + ventanaHoras + 1) * MS_POR_HORA
  return Math.max(0, saleEn - now)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// Called AFTER serving, with the tokens actually generated.
//
// Unlike budget.mjs there's no reservation: here you can't reject halfway
// through without cutting off someone's stream, and D4 says a started
// stream doesn't get cut off. The check happens before starting and the
// registration after finishing; a single request's overflow -- serving up
// to 4096 tokens while having 1 left of quota -- is accepted on purpose.
// It's bounded by `max_tokens`, and the alternative is cutting generations
// off midway, which looks like a bug and gives away the GPU that was
// already spent anyway.
export function registrar(peerKey, tokens, { now = Date.now() } = {}) {
  const n = Math.max(0, Math.floor(Number(tokens) || 0))
  if (n === 0) return 0

  const m = baldesDe(peerKey)
  podar(m, now)
  const h = horaDe(now)
  m.set(h, (m.get(h) || 0) + n)
  return n
}

// ---------------------------------------------------------------------------
// View and configuration
// ---------------------------------------------------------------------------

// What the provider's panel shows: how much it gave away and to whom.
export function listar({ now = Date.now() } = {}) {
  const filas = []
  for (const [peerKey, m] of baldes) {
    podar(m, now)
    if (m.size === 0) {
      // A peer that consumed nothing in the window takes up no room, in
      // memory or on screen.
      baldes.delete(peerKey)
      continue
    }
    let total = 0
    for (const v of m.values()) total += v
    filas.push({
      peerKey,
      used: total,
      remaining: Math.max(0, cuotaTokens - total),
      quota: cuotaTokens
    })
  }
  return filas.sort((a, b) => b.used - a.used)
}

export function configurar({ tokens = null, horas = null } = {}) {
  if (Number.isFinite(tokens) && tokens >= 0) cuotaTokens = Math.floor(tokens)
  if (Number.isFinite(horas) && horas > 0) ventanaHoras = Math.floor(horas)
  return { tokens: cuotaTokens, horas: ventanaHoras }
}

export function config() {
  return { tokens: cuotaTokens, horas: ventanaHoras }
}

export function reset() {
  baldes.clear()
  cuotaTokens = CUOTA_TOKENS
  ventanaHoras = VENTANA_HORAS
}
