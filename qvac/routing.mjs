// Choosing WHICH candidate a request gets sent to. Closes D6.
//
// Lives apart from store.mjs and gateway.mjs on purpose: the store is state
// (who exists and how they're doing), the gateway is HTTP (how it gets
// answered), and this is a decision. Pulling it out makes it testable
// without spinning up a swarm or a server -- which is the only thing that
// lets you test "with two peers, one at 90% and another at 10%, the second
// one wins" without two machines.
//
// Everything in here is PURE: it doesn't read the registry, doesn't check
// the clock unless it's passed one, has no side effects. It receives the
// candidate list that `store.findAllByModelId` already filtered by model
// and by online status.
//
// Until now the gateway took `candidatos[0]` and the order came from a fixed
// rank by `kind` put there so --demo mode would exercise the P2P path
// (store.mjs:435-443). That's kept as a TIEBREAKER, not as a criterion: with
// even load the order is the usual one, and the demo still shows what it
// used to show.

// The --demo mode mocks fluctuate randomly (store.startFluctuation) because
// they need to look alive in the video without anyone sending them anything.
// That load is theater, and comparing it against a peer's real load would be
// comparing a number to a fiction: a mock "at 10%" isn't less busy than a
// peer at 50%, it isn't busy at all.
//
// That's why the mock doesn't compete on load: it ALWAYS stays after any
// real candidate. It's the only way for load-based routing not to eat the
// one guarantee demo mode needs.
const RANK_KIND = { peer: 0, real: 1, upstream: 2, mock: 3 }

function rankKind(node) {
  return RANK_KIND[node.kind] ?? 9
}

function esMock(node) {
  return node.kind === 'mock'
}

// Normalized load 0..1. A node with no declared capacity is treated as full:
// you can't claim it has room.
export function cargaDe(node) {
  const max = Number(node.maxConcurrentRequests)
  if (!Number.isFinite(max) || max <= 0) return 1
  const activos = Number(node.activeRequests) || 0
  return Math.min(Math.max(activos / max, 0), 1)
}

export function estaSaturado(node) {
  const max = Number(node.maxConcurrentRequests)
  if (!Number.isFinite(max) || max <= 0) return true
  return (Number(node.activeRequests) || 0) >= max
}

// PHASE 8 — how much THIS request would cost on THIS candidate, in
// micro-dollars.
//
// Received injected for the same reason as `statsFor`: this is a pure
// decision and has no reason to know costs.mjs exists, or the prompt, or the
// output cap it's estimated with. The gateway, which does know all three,
// passes in a function already bound to the request.
//
// The unit is whole micro-dollars, the same as costs.mjs and budget.mjs, and
// that's what makes it COMPARABLE across candidates of different classes --
// which was half the point of this phase. A peer and the local engine give
// ZERO, and that zero isn't a placeholder: it's today's truth, because P2P
// payment is Phase 9. An upstream gives the price the operator declared in
// their config.
function precioDeCandidato(node, precioDe) {
  if (typeof precioDe !== 'function') return 0
  try {
    const n = Number(precioDe(node))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    // A price that can't be computed can't take down routing: it routes
    // without it, same as with broken history.
    return 0
  }
}

// The per-peer history that `directory.recordStat` has already been saving
// on every request and that until now fed no decision (see
// NOTES-SATURACION.md). Received injected as a function so as not to couple
// this to the Hyperbee: the gateway knows where to get it from, this doesn't
// need to.
//
// Expected shape: { requests, errors, lastMs } | null
function penalidadHistorica(node, statsFor) {
  if (typeof statsFor !== 'function') return { errorRate: 0, lastMs: null }
  let s = null
  try {
    s = statsFor(node)
  } catch {
    // Broken history can't take down routing: it routes without it.
    return { errorRate: 0, lastMs: null }
  }
  if (!s) return { errorRate: 0, lastMs: null }

  const requests = Number(s.requests) || 0
  const errors = Number(s.errors) || 0
  const errorRate = requests > 0 ? Math.min(errors / requests, 1) : 0
  const lastMs = Number.isFinite(Number(s.lastMs)) ? Number(s.lastMs) : null
  return { errorRate, lastMs }
}

// Sorts the candidates from best to worst. Returns new objects with the
// detail of why they ended up where they did -- this is what ends up in the
// routing log afterward, so the decision can be audited instead of guessed
// at.
export function scoreCandidates(
  candidatos,
  { statsFor = null, precioDe = null, random = Math.random } = {}
) {
  const scored = candidatos.map((node, i) => {
    const { errorRate, lastMs } = penalidadHistorica(node, statsFor)
    return {
      node,
      id: node.id,
      kind: node.kind,
      operator: node.operator,
      orden: i, // original position: backs the stable tiebreaker
      saturado: estaSaturado(node),
      mock: esMock(node),
      carga: cargaDe(node),
      loadPct: Math.round(cargaDe(node) * 100),
      precio: precioDeCandidato(node, precioDe),
      errorRate,
      lastMs,
      rank: rankKind(node),
      // EXACT load ties are the rule, not the exception: an idle network has
      // everyone at 0. Without random tiebreaking, every consumer deciding
      // in the same 2s window -- node:status's interval, swarm.mjs:48 --
      // picks the same peer and saturates it between all of them. The
      // jitter breaks the stampede without anyone having to coordinate with
      // anyone (S4 in NOTES-SATURACION.md).
      jitter: random()
    }
  })

  scored.sort((a, b) => {
    // 1. Whoever can serve right now, before the full ones.
    if (a.saturado !== b.saturado) return a.saturado ? 1 : -1
    // 2. Any real candidate before any mock.
    if (a.mock !== b.mock) return a.mock ? 1 : -1
    // 3. Whoever has the most room. THIS is D6.
    if (a.carga !== b.carga) return a.carga - b.carga
    // 4. PHASE 8 — with even load, the CHEAPEST wins.
    //
    // Goes AFTER load and not before, and that's the whole phase: price
    // can't beat "can serve right now". Sending a request to the cheap
    // option that's full is trading dollars for latency nobody asked for,
    // and the answer that never arrives isn't cheap: it's nothing.
    //
    // Goes BEFORE errorRate and latency, which is what the DoD asks for
    // ("with even load, the cheapest wins"), and in practice that costs less
    // than it looks like: today ALL peers and the local engine are worth
    // zero, so this comparison only separates free from paid. Among peers --
    // which is where errorRate and latency matter -- they're still tied on
    // price and decide it themselves, same as before.
    //
    // And this replaces an accident with a criterion. "The local one beats
    // the one that charges" already happened, but it was produced by the
    // `kind` tiebreaker in step 7 -- which the file itself declares "demo
    // mode preference, no longer a criterion". It ran on the order someone
    // happened to write an object in.
    if (a.precio !== b.precio) return a.precio - b.precio
    // 5. With load and price even, whoever's been failing less.
    if (a.errorRate !== b.errorRate) return a.errorRate - b.errorRate
    // 6. And then whoever's been answering faster.
    if (a.lastMs !== b.lastMs) {
      if (a.lastMs === null) return 1
      if (b.lastMs === null) return -1
      return a.lastMs - b.lastMs
    }
    // 7. Historical order by kind: demo mode preference, no longer a criterion.
    if (a.rank !== b.rank) return a.rank - b.rank
    // 8. Exact tie: random, so as not to send everyone to the same one.
    return a.jitter - b.jitter
  })

  return scored
}

// Micro-dollars for the human eye reading the log. `gratis` and not
// `USD 0.0000` because they're different things: one says it costs no
// money, the other that it costs a little. And the difference between a
// network peer and an API that charges is exactly that.
//
// NOTE (translation pass): the `reason`/`motivo` strings this function feeds
// into are asserted on verbatim (Spanish substrings) by test/index.js and
// test/integracion.js, which are outside this task's file list — left
// untranslated on purpose, see final report.
function formatMicros(micros) {
  const n = Number(micros) || 0
  if (n <= 0) return 'free'
  return 'USD ' + (n / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

// The reason that goes into the log. It is not decoration: the Phase 8 DoD
// requires the log to say WHY a node was chosen, and "first candidate" -all
// that could be said before- is not a why.
function motivoDe(mejor, scored) {
  if (!mejor) return 'no candidates'
  if (scored.length === 1) return 'only candidate'

  const libres = scored.filter((s) => !s.saturado)
  if (libres.length === 0) return `all ${scored.length} candidates are saturated`

  const segundo = scored[1]
  if (mejor.carga !== segundo.carga) {
    return `lower load (${mejor.loadPct}% vs ${segundo.loadPct}%) among ${scored.length} candidates`
  }
  if (segundo.saturado) {
    return `only candidate with room, of ${scored.length}`
  }
  // PHASE 8 — the DoD asks that the log say WHY, and "cheapest" is a why
  // that couldn't be given before. Both numbers are named: without the
  // second one's, "the cheapest" can't be audited against anything.
  //
  // Compared with `<` and not `!==`, and that's not a theoretical precaution:
  // with `!==` this branch would claim "cheaper" for the sole fact that the
  // prices differed, ASSUMING the sort had already ordered by price. Pull the
  // criterion out of the sort and the log would keep saying "cheaper" while
  // naming the MORE EXPENSIVE one as the winner -- a reason that contradicts
  // its own number. A reason has to state a fact, not repeat what the sort
  // was supposed to have done.
  if (mejor.precio < segundo.precio) {
    return (
      `even load (${mejor.loadPct}%), cheaper: ` +
      `${formatMicros(mejor.precio)} vs ${formatMicros(segundo.precio)} estimated`
    )
  }
  if (mejor.errorRate !== segundo.errorRate) {
    return `even load (${mejor.loadPct}%), fewer historical errors`
  }
  if (mejor.lastMs !== segundo.lastMs && mejor.lastMs !== null) {
    return `even load (${mejor.loadPct}%), better historical latency (${mejor.lastMs}ms)`
  }
  if (mejor.rank !== segundo.rank) {
    return `even load (${mejor.loadPct}%), preference by kind (${mejor.kind})`
  }
  return `even load (${mejor.loadPct}%) among ${scored.length} candidates, random tie-break`
}

// The API the gateway uses.
//
//   pickCandidate(candidatos)  ->  { node, reason, orden, scored, decision }
//
// `orden` is the already-sorted node list: handleRemoteChat's retry loop
// walks it as-is, so the second attempt also respects load instead of
// falling back to arrival order.
//
// `pin` pins a specific machine (the /v1/chat/completions `node` extension).
// If the pinned node isn't among the candidates, node:null is returned with
// the reason -- it does NOT fall back to the best available: picking a
// machine and getting an answer from a different one without knowing empties
// the function of meaning.
export function pickCandidate(
  candidatos,
  { statsFor = null, precioDe = null, random = Math.random, pin = null } = {}
) {
  const lista = Array.isArray(candidatos) ? candidatos : []

  if (lista.length === 0) {
    return { node: null, reason: 'no candidates', orden: [], scored: [], decision: null, pin }
  }

  if (pin) {
    const fijado = lista.find((n) => n.id === pin)
    if (!fijado) {
      return {
        node: null,
        reason: `the pinned node (${pin}) is not among the candidates`,
        orden: [],
        scored: [],
        decision: null,
        pin
      }
    }
    const saturado = estaSaturado(fijado)
    return {
      node: fijado,
      // A saturated pin is returned ANYWAY, with the warning: whoever pins a
      // machine is asking for that machine, and the gateway decides whether to
      // try it or bail.
      reason: saturado
        ? `node pinned by the client (saturated: ${fijado.activeRequests}/${fijado.maxConcurrentRequests})`
        : 'node pinned by the client',
      orden: [fijado],
      scored: [],
      decision: { elegido: fijado.id, pin: true, saturado, alternativas: [] },
      pin
    }
  }

  const scored = scoreCandidates(lista, { statsFor, precioDe, random })
  const mejor = scored[0]
  const reason = motivoDe(mejor, scored)

  return {
    node: mejor.node,
    reason,
    orden: scored.map((s) => s.node),
    scored,
    decision: {
      elegido: mejor.id,
      pin: false,
      loadPct: mejor.loadPct,
      alternativas: scored.slice(1, 4).map((s) => ({
        id: s.id,
        operator: s.operator,
        kind: s.kind,
        loadPct: s.loadPct,
        saturado: s.saturado
      }))
    },
    pin: null
  }
}
