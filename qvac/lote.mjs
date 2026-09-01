// Phase 10 — receipts and batching.
//
// -----------------------------------------------------------------------------
// WHAT A RECEIPT IS, AND WHY THE EIP-3009 SIGNATURE ALREADY IS ONE
//
// Phase 9 verifies a synchronous payment, serves, and settles LATER (D12). A
// receipt here is exactly that verified payment with DEFERRED settlement: the
// EIP-3009 authorization the client signed is an off-chain transfer order
// that doesn't require settling on the spot. Saving it and settling later
// —in bulk— is the same Phase 9 flow, not a new mechanism.
//
// This is what kills Phase 6: with deferred on-chain settlement there's no
// need for a homegrown multi-writer ledger. The real ledger is the chain.
//
// -----------------------------------------------------------------------------
// THE BATCH: ONE NETWORK, ONE WALLET
//
// A batch groups receipts that go to the SAME `payTo` on the SAME network,
// because that's what can be settled by walking `x402.liquidar()` once per
// entry against a single facilitator. Mixing networks or destinations in a
// batch would be an artifact that can't be processed in one single way.
//
// The batch is signed with the WALLET (not with the network key), same
// criterion as `atestacion.mjs` and `manifest-v0.json:84`: Ed25519 says "this
// node is this node", the wallet says "this address gets paid". A batch is a
// claim about charges, so it belongs to the second.
//
// -----------------------------------------------------------------------------
// THE BYTES THAT GET SIGNED
//
// JCS (RFC 8785) of the batch WITHOUT `signature`, with the SAME
// canonicalization function as the manifest and the attestation — the only
// way they can't diverge between signing and verifying. On top of that, a
// personal_sign EIP-191 with the wallet key (`account.sign` from WDK),
// recovered with `recoverMessageAddress`. Not EIP-712: there's no contract
// domain here, there's a canonical document.
//
// Each receipt's idempotency key is the `nonce` of the EIP-3009 authorization
// (D20): the same nonce settled twice only charges ONCE, on the token's side.
// That's why the accumulator is indexed by nonce and `marcarLiquidados` talks
// in nonces.

import fs from 'bare-fs'
import path from 'bare-path'
import { canonicalize } from './manifest.mjs'
import { hashDe } from './atestacion.mjs'
import * as x402 from './x402.mjs'

// Bumps when the SHAPE of the receipt or the batch changes. A verifier on
// another version doesn't have to guess whether a field is missing or means
// something else.
export const VERSION = 1

// -----------------------------------------------------------------------------
// The receipt
// -----------------------------------------------------------------------------

const es0x = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]+$/.test(s)

// A verified payment with deferred settlement. The order the fields are
// written in here doesn't mean anything: JCS sorts them.
//
// `requirements` is the `accepts[]` entry EXACTLY as offered in the 402
// (`x402.entradaAccepts`). Saved whole because it's against THOSE numbers
// that settlement has to happen: recomputing it at settlement time would mean
// settling against a different amount than the one the client signed.
export function construirRecibo({
  requestId,
  ts = Date.now(),
  red,
  network,
  asset,
  assetName,
  assetVersion,
  payTo,
  payer,
  amount,
  authorization,
  signature,
  requirements = null,
  atestacion = null,
  liquidacion = null
}) {
  if (!requestId) throw new Error('lote: the receipt has no requestId')
  if (!network) throw new Error('lote: the receipt has no network (CAIP-2)')
  if (!es0x(payTo)) throw new Error('lote: the receipt has no EVM payTo')
  if (!authorization || typeof authorization !== 'object') {
    throw new Error('lote: the receipt has no EIP-3009 authorization')
  }
  if (!authorization.nonce) throw new Error('lote: the authorization has no nonce')
  if (!es0x(signature)) throw new Error('lote: the receipt has no EIP-3009 signature')

  // The amount actually transferred is the authorization's `value` (paying
  // more is on the payer). If it wasn't given, the minimum that was asked for.
  const bruto = amount != null ? amount : requirements && requirements.amount
  let monto
  try {
    monto = BigInt(bruto).toString()
  } catch {
    throw new Error(`lote: the receipt's amount is not an integer: ${bruto}`)
  }

  return {
    v: VERSION,
    requestId,
    ts,
    // Short name (for grouping and logging) and CAIP-2 (what gets signed).
    red: red || null,
    network,
    asset: asset || (requirements && requirements.asset) || null,
    // The EIP-712 domain the authorization was signed with. Without this a
    // third party can't recover the receipt's signer.
    assetName: assetName || (requirements && requirements.extra && requirements.extra.name) || null,
    assetVersion:
      assetVersion || (requirements && requirements.extra && requirements.extra.version) || null,
    payTo,
    payer: payer || authorization.from || null,
    amount: monto,
    nonce: authorization.nonce,
    authorization,
    signature,
    requirements,
    // The D24 attestation, signed with the wallet of whoever served it. May
    // be missing (peer, no signer available): then the receipt proves the
    // payment and not the work.
    attestation: atestacion || null,
    // The result of Phase 9's immediate settlement, if there was one. `null`
    // or `{ success:false }` is a receipt that's still owed: that's what
    // `liquidarLote` retries.
    liquidacion: liquidacion || null
  }
}

// The key a receipt is deduplicated and marked settled by.
export function claveDe(recibo) {
  return recibo && recibo.nonce
}

// -----------------------------------------------------------------------------
// The batch
// -----------------------------------------------------------------------------

function mismoDestino(recibos) {
  const red = recibos[0].network
  const payTo = String(recibos[0].payTo).toLowerCase()
  for (const r of recibos) {
    if (r.network !== red) {
      // NOTE: kept in Spanish — test/index.js:3005 asserts on the exact regex
      // /red/ against this exception's message.
      throw new Error(`lote: un recibo es de la red ${r.network} y el lote es de la red ${red}`)
    }
    if (String(r.payTo).toLowerCase() !== payTo) {
      throw new Error('lote: a receipt pays a different wallet than the rest of the batch')
    }
  }
}

function sumar(recibos) {
  let total = 0n
  for (const r of recibos) total += BigInt(r.amount)
  return total.toString()
}

// The batch UNSIGNED. Kept separate from `firmarLote` so tests can look at
// the shape without needing a wallet.
export function construirLote({ recibos, ts = Date.now() }) {
  if (!Array.isArray(recibos) || recibos.length === 0) {
    // NOTE: kept in Spanish — test/index.js:3016 asserts on the exact regex
    // /no hay recibos/ against this exception's message.
    throw new Error('lote: no hay recibos que agrupar')
  }

  // De-dup by nonce: the same receipt twice is one. Two DIFFERENT receipts
  // with the same nonce is a program error —the nonce is the idempotency
  // key— and this cuts it off instead of picking one.
  const porNonce = new Map()
  for (const r of recibos) {
    const k = claveDe(r)
    const previo = porNonce.get(k)
    if (previo && canonicalize(previo) !== canonicalize(r)) {
      throw new Error(`lote: two different receipts with the same nonce ${k}`)
    }
    porNonce.set(k, r)
  }
  const unicos = [...porNonce.values()]
  mismoDestino(unicos)

  const nonces = [...porNonce.keys()].sort()
  return {
    v: VERSION,
    ts,
    red: unicos[0].red || null,
    network: unicos[0].network,
    payTo: unicos[0].payTo,
    count: unicos.length,
    totalAmount: sumar(unicos),
    nonces,
    // In `nonces` order so two batches built from the same receipts in a
    // different order canonicalize the same.
    recibos: nonces.map((n) => porNonce.get(n))
  }
}

// The bytes that get signed: the canonicalized batch WITHOUT `signature`.
// Same function when signing and verifying.
function bytesFirmados(lote) {
  const { signature, ...resto } = lote // eslint-disable-line no-unused-vars
  return canonicalize(resto)
}

// A stable identifier for the batch (hash of the unsigned content). For logs
// and so two ends can talk about the same batch without sending the whole
// thing.
export function idDeLote(lote) {
  return hashDe(bytesFirmados(lote))
}

// Signs with the wallet. `firmarMensaje` is the function bin.mjs injects,
// wrapping WDK's `account.sign`: no seed ever enters here.
//
// Doesn't throw if the signature fails: returns null and leaves it to the
// caller. An unsigned batch is NOT emitted — an artifact that looks like
// proof and isn't is worse than none at all.
export async function firmarLote(lote, firmarMensaje) {
  if (typeof firmarMensaje !== 'function') return null
  try {
    const signature = await firmarMensaje(bytesFirmados(lote))
    if (typeof signature !== 'string' || !signature.startsWith('0x')) return null
    return { ...lote, signature }
  } catch (err) {
    console.error(`[lote] could not sign: ${(err && err.stack) || (err && err.message) || err}`)
    return null
  }
}

// Verifies the whole batch: the wallet's signature over the content, the
// network/destination homogeneity, the total, and —receipt by receipt— that
// the EIP-3009 authorization recovers to whoever it claims is paying.
//
// Returns `{ ok, reason, firmante, recibosMal }` and not a boolean: needs to
// be able to log WHY it was rejected.
export async function verificarLote(lote) {
  if (!lote || typeof lote !== 'object') return { ok: false, reason: 'the batch is not an object' }
  if (lote.v !== VERSION) return { ok: false, reason: `unknown version ${lote.v}` }
  if (typeof lote.signature !== 'string' || !lote.signature.startsWith('0x')) {
    return { ok: false, reason: 'missing batch signature or not an EVM signature' }
  }
  if (!Array.isArray(lote.recibos) || lote.recibos.length === 0) {
    return { ok: false, reason: 'the batch has no receipts' }
  }

  // BEFORE `import('viem')`: `cargar()` installs the TextEncoder polyfill
  // that viem uses when it gets evaluated. Without this, a standalone
  // `verificar-lote` —with nobody having loaded WDK earlier in the process—
  // dies with a ReferenceError that says nothing about viem. See the header
  // of x402.mjs.
  const { evm } = await x402.cargar()
  const viem = await import('viem')

  let firmante
  try {
    firmante = await viem.recoverMessageAddress({
      message: bytesFirmados(lote),
      signature: lote.signature
    })
  } catch (err) {
    return {
      ok: false,
      reason: `could not recover the batch signer: ${(err && err.message) || err}`
    }
  }

  try {
    mismoDestino(lote.recibos)
  } catch (err) {
    return { ok: false, reason: err.message, firmante }
  }

  if (sumar(lote.recibos) !== String(lote.totalAmount)) {
    // NOTE: kept mentioning "totalAmount" on purpose — test/index.js:3051
    // asserts on the regex /suma|totalAmount/ against this reason.
    return { ok: false, reason: 'el totalAmount no es la suma de los recibos', firmante }
  }
  if (lote.count !== lote.recibos.length) {
    return { ok: false, reason: 'count does not match the number of receipts', firmante }
  }

  // `authorizationTypes` comes from the package, it isn't copied here.
  const recibosMal = []
  for (const r of lote.recibos) {
    const motivo = await verificarAutorizacion(r, viem, evm)
    if (motivo) recibosMal.push({ nonce: r.nonce, reason: motivo })
  }

  return {
    ok: recibosMal.length === 0,
    reason:
      recibosMal.length === 0 ? null : `${recibosMal.length} receipt(s) with a bad authorization`,
    firmante,
    recibosMal
  }
}

// That the receipt's EIP-3009 signature recovers to `authorization.from`.
// It's the same `recoverTypedDataAddress` that `x402.verificarPago` does
// live, against the EIP-712 domain the receipt stores.
async function verificarAutorizacion(recibo, viem, evm) {
  const a = recibo.authorization
  if (!a || !recibo.signature) return 'missing authorization and signature'
  if (!recibo.assetName || !recibo.asset) return 'missing the EIP-712 domain (assetName/asset)'

  const chainId = Number(String(recibo.network).split(':')[1])
  if (!Number.isFinite(chainId)) return `network with no chainId: ${recibo.network}`

  let firmante
  try {
    firmante = await viem.recoverTypedDataAddress({
      domain: {
        name: recibo.assetName,
        version: recibo.assetVersion || '1',
        chainId,
        verifyingContract: recibo.asset
      },
      types: evm.authorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from,
        to: a.to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce
      },
      signature: recibo.signature
    })
  } catch (err) {
    return `could not recover the signer: ${(err && err.message) || err}`
  }

  if (firmante.toLowerCase() !== String(a.from || '').toLowerCase()) {
    return `the signature is from ${firmante} and the authorization claims to pay from ${a.from}`
  }
  if (String(a.to || '').toLowerCase() !== String(recibo.payTo || '').toLowerCase()) {
    return 'the authorization pays a different address than the receipt\'s payTo'
  }
  return null
}

// -----------------------------------------------------------------------------
// Deferred settlement
// -----------------------------------------------------------------------------

// How each `x402.liquidar()` result gets classified when processing a batch.
// With D9 charging a fixed cap it barely mattered; here it DOES, because the
// batch settles on its own and these reasons call for incompatible actions
// (see 0-quinquies, point 1 of the Block 0 review):
//
//   liquidado     success, or `nonce_already_used` — a retry that's already
//                 charged on the token's side: idempotent, counted as good.
//   saldo         `insufficient_balance` — that's on the other side, not
//                 retried.
//   firma         `invalid_signature` — this isn't accounting, it's
//                 reputation.
//   reintentable  anything else: left in the batch for next time.
//
// NOTE: the four return values below ('liquidado', 'saldo', 'firma',
// 'reintentable') are enum-like classification values consumed
// programmatically — test/index.js:3136 asserts on the exact value 'saldo' —
// so they're kept in Spanish rather than translated.
function clasificar(res) {
  if (res && res.success) return 'liquidado'
  const motivo = String((res && (res.errorReason || res.errorMessage)) || '').toLowerCase()
  if (/nonce.*(already|used)|already.*used/.test(motivo)) return 'liquidado'
  if (/insufficient|balance|fondos|saldo/.test(motivo)) return 'saldo'
  if (/signature|firma|invalid.*sig/.test(motivo)) return 'firma'
  return 'reintentable'
}

// Walks the batch calling `liquidar` once per receipt. `liquidar` is
// `x402.liquidar` (injected so this module doesn't couple to the stack
// running under Bare, same as `atestacion.firmar` receives the signing
// function).
//
// Does NOT touch the accumulator: returns which nonces ended up settled and
// the caller decides via `marcarLiquidados`. That way a crash in the middle
// doesn't leave the accumulator in a half-done state nobody knows how to read.
export async function liquidarLote({ lote, liquidar }) {
  if (!lote || !Array.isArray(lote.recibos)) throw new Error('lote: no receipts to settle')
  if (typeof liquidar !== 'function') throw new Error('lote: missing the liquidar function')

  const liquidados = []
  const fallidos = []
  const detalle = []

  for (const r of lote.recibos) {
    let res
    try {
      res = await liquidar({
        pago: { autorizacion: r.authorization, firma: r.signature, requisito: r.requirements },
        requisito: r.requirements
      })
    } catch (err) {
      res = {
        success: false,
        errorReason: 'settlement_failed',
        errorMessage: (err && err.message) || String(err)
      }
    }
    const clase = clasificar(res)
    detalle.push({
      nonce: r.nonce,
      clase,
      transaction: res && res.transaction,
      motivo: res && (res.errorReason || res.errorMessage)
    })
    if (clase === 'liquidado') liquidados.push(r.nonce)
    else
      fallidos.push({ nonce: r.nonce, clase, motivo: res && (res.errorReason || res.errorMessage) })
  }

  return { liquidados, fallidos, detalle }
}

// -----------------------------------------------------------------------------
// The accumulator (process memory, not a ledger)
// -----------------------------------------------------------------------------

// Same as the gateway's `recibos` Map: this is NOT the ledger —the ledger is
// the chain— but the series of receipts this node can still gather into a
// batch. Pruned on insert, not on a timer.
const MAX_PENDIENTES = 500
const _pend = new Map() // nonce -> recibo

// -----------------------------------------------------------------------------
// Accumulator persistence (PHASE 10)
// -----------------------------------------------------------------------------
//
// `_pend` is process memory, and until now a crash between "served/verified"
// and "settled" gave away the work for free: the EIP-3009 authorization was
// signed and on no disk anywhere. It's mirrored to a JSONL —one JSON line per
// receipt— with the SAME atomic-write pattern as `apikeys.mjs` and
// `budget.mjs`: temp file and `rename` on top, because a `writeFileSync` cut
// in half leaves a file that doesn't parse, and losing this means losing
// signed charges.
//
// The file lives in the PERSISTENT dir (not `budgetDir`, which under `bare`
// is temp —D30.1—): `bin.mjs` opens it with `abrir()`, before the gateway,
// for the same reason as the ledger and the API keys. `null` => everything in
// memory, which is the path used by tests and by a node with no storage.
const ARCHIVO = 'lote-pendientes.jsonl'

// How many UNSETTLED receipts trigger a size-based flush. A node with
// traffic doesn't wait for the timer or for shutdown to gather the batch.
const FLUSH_POR_TAMANO = 50

// How often a flush is attempted even below the threshold. Set WAY below the
// 402's `maxTimeoutSeconds` (300s by default): an expired EIP-3009
// authorization can't be settled, so deferring too long means losing the
// charge. That's the honest limit of `batch-receipts` mode and it's noted in
// the roadmap.
const FLUSH_INTERVALO_MS = 90_000

let _archivo = null
let _firmar = null
let _liquidar = null
let _timer = null
let _flushEnCurso = null
let _umbral = FLUSH_POR_TAMANO

// Atomic write of the whole accumulator. Same as `apikeys.guardar`: if it
// fails, it's loudly reported and keeps running IN MEMORY —a crash right
// there DOES lose the receipt, and that has to be visible, not swallowed.
function persistir() {
  if (!_archivo) return
  const tmp = _archivo + '.tmp'
  try {
    const lineas = [..._pend.values()].map((r) => JSON.stringify(r)).join('\n')
    fs.writeFileSync(tmp, lineas ? lineas + '\n' : '', { mode: 0o600 })
    fs.renameSync(tmp, _archivo)
  } catch (err) {
    console.error(
      `[lote] could not persist the accumulator: ${(err && err.stack) || (err && err.message) || err}`
    )
    console.error(
      '[lote] pending receipts are running IN MEMORY: a crash between serving and settling loses them'
    )
    _archivo = null
  }
}

// Opens the accumulator against `dir` and injects what to sign and settle the
// batch with. Loads whatever's left from a previous run —a corrupted line is
// skipped, doesn't take the rest down with it— and sets up the periodic flush
// timer. Returns how many receipts were recovered.
export function abrir(
  dir,
  {
    firmar = null,
    liquidar = null,
    intervaloMs = FLUSH_INTERVALO_MS,
    umbral = FLUSH_POR_TAMANO
  } = {}
) {
  _archivo = dir ? path.join(dir, ARCHIVO) : null
  _firmar = typeof firmar === 'function' ? firmar : null
  _liquidar = typeof liquidar === 'function' ? liquidar : null
  _umbral = Number.isFinite(umbral) && umbral > 0 ? umbral : FLUSH_POR_TAMANO
  _pend.clear()

  if (_archivo) {
    try {
      for (const linea of fs.readFileSync(_archivo, 'utf8').split('\n')) {
        if (!linea.trim()) continue
        try {
          const r = JSON.parse(linea)
          const k = claveDe(r)
          if (k) _pend.set(k, r)
        } catch {
          // A line that doesn't parse is one that got corrupted on write; the
          // rest of the file is still good.
        }
      }
    } catch {
      // Doesn't exist yet: first boot.
    }
  }

  if (_timer) clearInterval(_timer)
  _timer = null
  if (_archivo && intervaloMs > 0) {
    _timer = setInterval(() => {
      flushTodo().catch(() => {})
    }, intervaloMs)
    _timer.unref?.()
  }

  return _pend.size
}

// The size-based flush. `agregar` calls it fire-and-forget; tests await it.
// Does nothing if the accumulator isn't open or is missing something to
// sign/settle with.
export async function flushSiSuperaUmbral() {
  if (!_archivo || !_firmar || !_liquidar) return null
  if (_flushEnCurso) return _flushEnCurso
  if (contar({ soloPendientes: true }) < _umbral) return null
  return flushTodo()
}

// Builds-signs-settles-marks ALL of what's pending, grouped by
// network+wallet (a batch is for ONE network and ONE wallet:
// `construirLote` enforces it). Does NOT retry here what failed: it stays in
// the accumulator for the next trigger. Returns a summary per group. Doesn't
// throw: a flush that blows up can't take `close` down with it.
export async function flushTodo({ firmar = _firmar, liquidar = _liquidar } = {}) {
  if (_flushEnCurso) return _flushEnCurso
  _flushEnCurso = (async () => {
    const resultados = []
    const grupos = new Set(
      pendientes({ soloPendientes: true }).map(
        (r) => `${r.network}|${String(r.payTo).toLowerCase()}`
      )
    )
    for (const g of grupos) {
      const sep = g.indexOf('|')
      const network = g.slice(0, sep)
      const payTo = g.slice(sep + 1)
      let firmado = null
      try {
        const l = armar({ network, payTo, soloPendientes: true })
        firmado = typeof firmar === 'function' ? await firmarLote(l, firmar) : null
      } catch (err) {
        resultados.push({ network, payTo, ok: false, motivo: (err && err.message) || String(err) })
        continue
      }
      if (!firmado) {
        resultados.push({ network, payTo, ok: false, motivo: 'could not sign the batch' })
        continue
      }
      if (typeof liquidar !== 'function') {
        resultados.push({ network, payTo, ok: false, motivo: 'no liquidar function available' })
        continue
      }
      const res = await liquidarLote({ lote: firmado, liquidar })
      marcarLiquidados(res.liquidados)
      resultados.push({
        network,
        payTo,
        ok: true,
        liquidados: res.liquidados.length,
        fallidos: res.fallidos.length
      })
    }
    persistir()
    return resultados
  })()
  try {
    return await _flushEnCurso
  } finally {
    _flushEnCurso = null
  }
}

// `bin.mjs`'s shutdown. Persists FIRST —if the flush hangs against a slow
// facilitator, the forced exit still cuts it off and nothing is lost—, then
// tries one last flush, and persists whatever's left again.
export async function cerrar({ flush = true } = {}) {
  if (_timer) clearInterval(_timer)
  _timer = null
  persistir()
  if (flush && _liquidar) {
    try {
      await flushTodo()
    } catch {
      // already reported inside; the accumulator stays persisted for next time.
    }
    persistir()
  }
  _archivo = null
  _firmar = null
  _liquidar = null
}

// -----------------------------------------------------------------------------

export function agregar(recibo) {
  const k = claveDe(recibo)
  if (!k) throw new Error('lote: cannot accumulate a receipt with no nonce')
  _pend.set(k, recibo)
  if (_pend.size > MAX_PENDIENTES) {
    const sobran = _pend.size - MAX_PENDIENTES
    let n = 0
    for (const key of _pend.keys()) {
      if (n++ >= sobran) break
      _pend.delete(key)
    }
  }
  persistir()
  flushSiSuperaUmbral().catch(() => {})
  return recibo
}

// The accumulated receipts, filterable by network/destination and by whether
// they're still owed.
export function pendientes({ red, network, payTo, soloPendientes = false } = {}) {
  const out = []
  for (const r of _pend.values()) {
    if (red && r.red !== red) continue
    if (network && r.network !== network) continue
    if (payTo && String(r.payTo).toLowerCase() !== String(payTo).toLowerCase()) continue
    if (soloPendientes && r.liquidacion && r.liquidacion.success) continue
    out.push(r)
  }
  return out
}

export function contar(filtro) {
  return pendientes(filtro).length
}

// Builds a batch out of the matching accumulated receipts. Throws if there
// are none: an empty batch isn't a batch.
export function armar({ red, network, payTo, soloPendientes = false, ts } = {}) {
  const recibos = pendientes({ red, network, payTo, soloPendientes })
  if (recibos.length === 0) throw new Error('lote: no accumulated receipts for that destination')
  return construirLote({ recibos, ts })
}

// Marks those nonces as settled (doesn't delete them: they stick around for
// auditing until pruning takes them).
export function marcarLiquidados(nonces, { transaction } = {}) {
  let toco = false
  for (const n of nonces || []) {
    const r = _pend.get(n)
    if (r) {
      r.liquidacion = {
        success: true,
        transaction: transaction || (r.liquidacion && r.liquidacion.transaction) || '',
        at: Date.now()
      }
      toco = true
    }
  }
  // So a process crash right after settling doesn't charge again: what's
  // settled has to end up marked on disk, not just in memory.
  if (toco) persistir()
}

// Tests only: empties the accumulator between cases.
export function limpiar() {
  _pend.clear()
}
