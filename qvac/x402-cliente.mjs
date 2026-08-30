// The CLIENT role of x402: this node paying ANOTHER one. It's the exact
// mirror of `qvac/x402.mjs`, which is the server role — `desafio()` builds the
// 402, `verificarPago()` checks the incoming one, `liquidar()` charges it —.
// This is the other end: receiving a 402, signing the EIP-3009 authorization
// with the node's wallet, and retrying with `X-PAYMENT` set.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A MODULE AND NOT LOOSE CODE AT THE CALL SITE
//
// The signing itself was already solved and tested —`test/integracion.js` has
// done it inline with `evm.ExactEvmScheme` since Phase 9—. What was missing,
// and what lives here, are the three things a real payer can't improvise at
// every call site:
//
//   1. A SPENDING CAP, mandatory. The amount is set by the 402, i.e. the
//      OTHER side. A client that signs whatever `amount` it's sent is a
//      client handing its wallet to a stranger. The roadmap says this for the
//      Phase 11 agent and it applies just the same here: "an agent that goes
//      over budget is worse than one that doesn't start." The cap is checked
//      TWICE — when picking the entry and when signing it — on purpose.
//
//   2. CHOOSING BETWEEN NETWORKS. A 402 from this project carries an
//      `accepts[]` with one entry per network (Plasma, its testnet, Stable).
//      Blindly taking `accepts[0]` pays on whichever the server put first;
//      here D15's preference order is walked and it does NOT pay on a
//      network that isn't on the list — signing against a chain we don't
//      recognize is EIP-155 in someone else's hands.
//
//   3. THE FULL DANCE, with only ONE retry. Request → 402 → pay → retry ONCE.
//      No loop: if the second attempt also returns a 402, it's returned as-is
//      and the caller decides. Looping retries against a 402 is how a
//      pricing bug turns into an empty wallet.
//
// -----------------------------------------------------------------------------
// WHAT CROSSES FROM THE CALLER IS A SIGNING CAPABILITY, NOT A WALLET
//
// `firmante` is `{ address, signTypedData }` — the same thing `bin.mjs`
// already does with its `firmar` closure: "the gateway asks for signatures,
// not keys." The WDK account and the seed never enter this module. The
// typical setup, at the call site:
//
//     const abierta = await wallet.abrir(dir, passphrase, { red })
//     const firmante = {
//       address: abierta.address,
//       signTypedData: (td) => abierta.cuenta.signTypedData(td)
//     }
//
// -----------------------------------------------------------------------------
// WHAT IT DOESN'T DO
//
// It doesn't touch the chain and doesn't settle: whoever pays signs an
// off-chain authorization and leaves it to the provider, who charges it (or
// defers it, Phase 10). It doesn't check balance — same as `verificarPago` on
// the other side, for the same D12 reason: what's proven here is that the
// signature says what it has to say. A signer with no funds produces a valid
// `X-PAYMENT` that only fails once the provider settles it.

import { cargar, CAIP2, montoEnUnidades } from './x402.mjs'

// The order in which the network to pay on is chosen. It's D15's preference,
// the same one `redesDisponibles()` uses server-side: Plasma first, its
// testnet next, Stable as fallback. A network not on this list does NOT get
// paid.
export const ORDEN_PREFERENCIA = ['plasma', 'plasma-testnet', 'stable']

// -----------------------------------------------------------------------------
// The cap
// -----------------------------------------------------------------------------
//
// NOTE: the `motivo` (reason) strings and thrown `Error` messages in this
// file are asserted by `test/index.js` via keyword matching on the Spanish
// text (e.g. `/techo/`, `/reconocemos/`). They're deliberately left in
// Spanish — translating them here without updating those test assertions in
// the same pass would break the suite.

// Micro-dollars -> minimum units of the asset, to compare a cap against the
// 402's `amount`, which comes in units. Delegates to the SAME function
// `x402.mjs` uses to build and verify the amount: a cap that scales
// differently from the amount would reject payments that are within budget.
export function techoEnUnidades(techoMicros, decimals = 6) {
  return BigInt(montoEnUnidades(techoMicros, { decimals }))
}

// Resolves the cap to units (BigInt), requiring ONE of the two to be given.
// No cap, no payment: there's no "no limit" default.
function resolverTecho({ techoMicros, techoUnidades, decimals = 6 }) {
  if (techoUnidades != null) {
    const u = BigInt(techoUnidades)
    if (u <= 0n) throw new Error('x402-cliente: el techo de gasto tiene que ser > 0')
    return u
  }
  if (techoMicros != null) {
    const m = Number(techoMicros)
    if (!Number.isFinite(m) || m <= 0) {
      throw new Error('x402-cliente: techoMicros tiene que ser un número > 0')
    }
    return techoEnUnidades(m, decimals)
  }
  throw new Error(
    'x402-cliente: falta el techo de gasto (techoMicros o techoUnidades). ' +
      'Un pagador sin límite no arranca — es la regla de la Fase 11.'
  )
}

// -----------------------------------------------------------------------------
// The selection
// -----------------------------------------------------------------------------

// From a 402 body (`{ x402Version, accepts: [...] }`), picks ONE entry by
// network preference and within the cap. Returns `{ entrada, motivo }`:
// `entrada` is null if none work, and `motivo` says why — the caller has to
// be able to tell "all too expensive" apart from "no known network" —.
export function elegirEntrada(
  desafio,
  { redesPreferidas = ORDEN_PREFERENCIA, techoUnidades } = {}
) {
  const accepts = desafio && Array.isArray(desafio.accepts) ? desafio.accepts : null
  if (!accepts || accepts.length === 0) {
    return { entrada: null, motivo: 'el 402 no trae accepts[]' }
  }
  if (techoUnidades == null) {
    return { entrada: null, motivo: 'elegirEntrada necesita un techo en unidades' }
  }

  const techo = BigInt(techoUnidades)
  let habiaCandidata = false
  let masBarata = null

  for (const nombre of redesPreferidas) {
    const caip2 = CAIP2[nombre]
    if (!caip2) continue
    const entrada = accepts.find(
      (a) => a && a.network === caip2 && (!a.scheme || a.scheme === 'exact')
    )
    if (!entrada) continue

    let monto
    try {
      monto = BigInt(entrada.amount)
    } catch {
      continue // an `amount` that isn't an integer doesn't get signed
    }
    habiaCandidata = true
    if (masBarata === null || monto < masBarata) masBarata = monto

    if (monto <= techo) {
      return { entrada, motivo: `red ${nombre}, ${monto} unidades (techo ${techo})` }
    }
  }

  if (!habiaCandidata) {
    return {
      entrada: null,
      motivo:
        'ninguna red del 402 está en la preferencia (' +
        redesPreferidas.join(', ') +
        '): no se paga en una cadena que no reconocemos'
    }
  }
  return {
    entrada: null,
    motivo: `todas las entradas superan el techo: la más barata pide ${masBarata}, el techo es ${techo}`
  }
}

// -----------------------------------------------------------------------------
// The signature
// -----------------------------------------------------------------------------

// Signs the EIP-3009 authorization for ONE `accepts[]` entry and returns the
// envelope + the header ready for the `x-payment` header (base64 of a JSON,
// the same format `verificarPago` decodes on the other side).
//
// `x402Version` comes from the 402's body and travels back in the envelope:
// `verificarPago` rejects the payment if it doesn't match its own.
export async function crearPago({ entrada, firmante, x402Version, techoUnidades = null }) {
  if (!entrada) throw new Error('x402-cliente: no hay entrada de accepts[] para firmar')
  if (!firmante || typeof firmante.signTypedData !== 'function' || !firmante.address) {
    throw new Error('x402-cliente: firmante inválido (se espera { address, signTypedData })')
  }
  if (!entrada.extra || !entrada.extra.name || !entrada.extra.version) {
    throw new Error(
      'x402-cliente: la entrada no trae extra.{name,version} — sin el dominio EIP-712 ' +
        'del token no hay qué firmar'
    )
  }

  // The cap, again, right here. Even if the caller picked the entry by hand
  // and skipped `elegirEntrada`, signing is the point of no return: this is
  // where the check CANNOT be skipped.
  if (techoUnidades != null && BigInt(entrada.amount) > BigInt(techoUnidades)) {
    throw new Error(
      `x402-cliente: la entrada pide ${entrada.amount} y el techo es ${techoUnidades} — no se firma`
    )
  }

  const { evm } = await cargar()

  // The SAME path `test/integracion.js` has exercised since Phase 9:
  // `ExactEvmScheme` builds the authorization (nonce, validAfter/Before) and
  // signs it via `firmante.signTypedData`. Using the package's own scheme —
  // instead of building the typed data by hand — is what makes it so that if
  // `@x402/evm` changes the signature's shape, the client moves with it, the
  // same way `verificarPago` uses `evm.authorizationTypes` instead of a copy.
  const esquema = new evm.ExactEvmScheme(firmante)
  const p = await esquema.createPaymentPayload(x402Version, entrada)

  const sobre = {
    x402Version: p.x402Version,
    scheme: 'exact',
    network: entrada.network,
    payload: p.payload
  }

  return {
    cabecera: Buffer.from(JSON.stringify(sobre), 'utf8').toString('base64'),
    sobre,
    autorizacion: p.payload.authorization,
    firma: p.payload.signature
  }
}

// -----------------------------------------------------------------------------
// The receipt coming back
// -----------------------------------------------------------------------------

// Decodes the `X-PAYMENT-RESPONSE` the provider sends after settling. Doesn't
// throw if it's missing or malformed: a payment served without a readable
// receipt is still a served payment, and the caller has to be able to tell
// the cases apart.
export async function decodificarRecibo(valorHeader) {
  if (!valorHeader) return null
  try {
    const { decodePaymentResponseHeader } = await import('@x402/core/http')
    return decodePaymentResponseHeader(valorHeader)
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------
// The full dance
// -----------------------------------------------------------------------------

// Makes the request and, if it comes back 402, pays and retries ONCE.
//
//   const { res, pagado, recibo } = await pedirConPago(url, {
//     method: 'POST',
//     headers: { 'content-type': 'application/json' },
//     body: JSON.stringify(cuerpo)
//   }, { firmante, techoMicros: 500 })
//
// Returns `{ res, pagado, pago?, recibo?, entrada?, motivo? }`:
//   - `pagado: false` + `motivo` -> there was no 402, or there was and it
//     couldn't/wouldn't be paid (cap, unknown network, 402 without JSON).
//     `res` is the raw response.
//   - `pagado: true` -> it was signed and retried. `res` is the SECOND
//     response; it can still be non-2xx (e.g. the provider rejects the
//     signature), and in that case `res.status` says so. `recibo` is the
//     decoded `X-PAYMENT-RESPONSE` or null.
//
// `opciones.body` is resent as-is on the retry; if it's a single-use stream,
// pass a string instead. `opciones.headers` can be a plain object or Headers.
export async function pedirConPago(
  url,
  opciones = {},
  {
    firmante,
    techoMicros = null,
    techoUnidades = null,
    redesPreferidas = ORDEN_PREFERENCIA,
    decimalsTecho = 6,
    fetchImpl = null
  } = {}
) {
  const techo = resolverTecho({ techoMicros, techoUnidades, decimals: decimalsTecho })

  const fetch = fetchImpl || (await cargarFetch())
  const headersBase = normalizarHeaders(opciones.headers)

  const res1 = await fetch(url, opciones)
  if (res1.status !== 402) {
    return { res: res1, pagado: false, motivo: 'sin 402: no hay nada que pagar' }
  }

  let desafio
  try {
    desafio = await res1.json()
  } catch {
    return { res: res1, pagado: false, motivo: 'el 402 no trae un cuerpo JSON' }
  }

  const sel = elegirEntrada(desafio, { redesPreferidas, techoUnidades: techo })
  if (!sel.entrada) {
    return { res: res1, pagado: false, motivo: sel.motivo, desafio }
  }

  const pago = await crearPago({
    entrada: sel.entrada,
    firmante,
    x402Version: desafio.x402Version,
    techoUnidades: techo
  })

  const res2 = await fetch(url, {
    ...opciones,
    headers: { ...headersBase, 'x-payment': pago.cabecera }
  })

  const recibo = await decodificarRecibo(leerHeader(res2, 'x-payment-response'))

  return { res: res2, pagado: true, pago, recibo, entrada: sel.entrada }
}

// -----------------------------------------------------------------------------

// Under Bare `fetch` isn't global (see `qvac/upstream.mjs`). Resolved the same
// way as there and in `embeddings.mjs`.
async function cargarFetch() {
  const mod = await import('bare-fetch')
  return mod.default || mod.fetch || mod
}

function normalizarHeaders(h) {
  if (!h) return {}
  if (typeof h.entries === 'function') return Object.fromEntries(h.entries())
  return { ...h }
}

function leerHeader(res, nombre) {
  const h = res && res.headers
  if (!h) return null
  if (typeof h.get === 'function') return h.get(nombre)
  return h[nombre] || h[nombre.toLowerCase()] || null
}
