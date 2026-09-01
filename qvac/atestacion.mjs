// D24 — the provider's attestation: what it served, signed by whoever served it.
//
// -----------------------------------------------------------------------------
// WHAT PROBLEM THIS CLOSES, AND WHICH ONE IT DOESN'T
//
// The x402 receipt that already exists proves that SOMEONE PAID. The EIP-3009
// signature is put there by the client authorizing the transfer, so it only
// covers one direction of the exchange. On the other side there was nothing:
// no artifact where the provider commits to what it delivered.
//
// The attack this closes is NOT Token Inflation as such — here the pair
// doesn't report the number it bills, `costoDelIntento` (gateway.mjs) bills
// with the gateway's own count. It's the same attack with a different vector:
// **it's the provider who decides how the stream gets chunked**, and the
// gateway counts one delta at a time. A provider that emits one character per
// delta instead of one token per delta inflates the counter's count without
// lying in any field and without breaking any validation. It doesn't falsify
// the number: it falsifies the signal.
//
// Against that, `outputHash` is what closes the hole, and it's the whole
// reason this file exists: **the hash is over the full text, and the text
// doesn't depend on how many pieces it traveled in**. Anyone can recount the
// tokens from the attested text, using whichever tokenizer matches the
// `modelId`.
//
// What this does NOT prove, and it needs to be said out loud:
//
//   - that the declared model is the one that actually ran. That's probes,
//     and that's Phase 10.5.
//   - that the declared QUANTIZATION is the one that actually ran. D26 closes
//     this with the literature in hand: there's no published black-box
//     solution. `quantization` and `runtime` here are DECLARATIONS, backed by
//     stake and arbitration, not by a measurement. They're signed precisely
//     so there's something to arbitrate against.
//   - nothing about what ANOTHER node served. See `PAR` below.
//
// -----------------------------------------------------------------------------
// THE SIGNATURE IS THE WALLET'S, NOT THE NETWORK'S
//
// Same criterion as Phase 10 and `manifest-v0.json:84`, which has declared the
// two separate keys from day one: the network Ed25519 says "this node is this
// node", and the wallet says "this address gets paid". An attestation of what
// was served belongs to the second: it's the input later used to settle.
//
// The gateway NEVER sees the seed. bin.mjs opens the keystore and injects a
// FUNCTION that signs; only that gets called here. Same invariant already
// written in gateway.mjs, and this doesn't loosen it.
//
// -----------------------------------------------------------------------------
// THE BYTES THAT GET SIGNED
//
// JCS (RFC 8785) of the artifact WITHOUT `signature`, exactly the same
// pattern as `signManifest` — and with the SAME function when signing and
// when verifying, which is the only way they can't diverge. The key order of
// a JS object isn't stable across implementations; with JCS the bytes are a
// function of the content, not of the order the object was built in.
//
// Over those bytes the signature is a personal_sign EIP-191 with the wallet
// key (`account.sign` from WDK), verified with `recoverMessageAddress`. It's
// deliberately not EIP-712: there's no contract domain to type against here,
// there's a canonical document, and JCS already is the canonicalization.

import sodium from 'sodium-native'
import { canonicalize } from './manifest.mjs'

// Bumps when the artifact's SHAPE changes. A verifier on another version
// doesn't have to guess whether a field is missing or means something else.
export const VERSION = 1

// The hash carries the algorithm name glued to the value, not in a separate
// field.
//
// A bare `promptHash: "3a5f…"` isn't verifiable by a third party: you'd need
// to know what to recompute it with. And in a separate field, name and value
// can drift out of sync; glued together, they can't. BLAKE2b-256 and not
// SHA-256 because sodium is already a direct dependency of this tree
// (`wallet.mjs` uses it) and runs under Bare without dynamic import: SHA-256
// would come from `@noble/hashes`, which today is here only as a transitive
// dep of viem and isn't declared.
const ALG = 'blake2b-256'

export function hashDe(texto) {
  const out = Buffer.alloc(sodium.crypto_generichash_BYTES)
  sodium.crypto_generichash(out, Buffer.from(String(texto), 'utf8'))
  return ALG + ':' + out.toString('hex')
}

// The prompt hash is over the CANONICALIZED messages, not over the text of
// the last turn: what the provider received is the whole conversation, and
// that's what the client can recompute on its side to verify.
export function hashDeMensajes(messages) {
  return hashDe(canonicalize(messages || []))
}

export function nonce() {
  const b = Buffer.alloc(16)
  sodium.randombytes_buf(b)
  return b.toString('hex')
}

// The bytes that get signed: the canonicalized artifact WITHOUT `signature`.
// Same function when signing and verifying — see the header.
function bytesFirmados(atestacion) {
  const { signature, ...resto } = atestacion // eslint-disable-line no-unused-vars
  return canonicalize(resto)
}

// The unsigned artifact. Kept separate from `firmar` so tests can inspect the
// shape without needing a wallet.
//
// The order the fields are written in here doesn't mean anything: JCS sorts
// them.
export function construir({
  requestId,
  ts = Date.now(),
  modelId,
  quantization,
  runtime,
  promptHash,
  outputHash,
  tokensPrefill,
  tokensDecode,
  finishReason,
  providerPubkey,
  nonce: n = nonce()
}) {
  if (!requestId) throw new Error('atestacion: missing requestId')
  if (!providerPubkey) throw new Error('atestacion: missing providerPubkey')

  return {
    v: VERSION,
    requestId,
    nonce: n,
    ts,
    modelId: modelId || null,
    // DECLARED, not measured. See D26 and the header: there's no published
    // black-box way to verify quantization, so what backs these two fields is
    // that they're signed and that there's stake behind them — not a
    // measurement.
    quantization: quantization || 'unknown',
    runtime: runtime || 'unknown',
    promptHash,
    outputHash,
    // D25 — the two dimensions kept separate. `tokensDecode` can come from the
    // provider's `usage` or from the deltas counted by the gateway, and they
    // aren't the same thing: that's why the gateway writes `tokensFuente` in
    // its trace. What goes here are the numbers the provider commits to
    // standing behind.
    tokensPrefill: Number.isFinite(tokensPrefill) ? tokensPrefill : 0,
    tokensDecode: Number.isFinite(tokensDecode) ? tokensDecode : 0,
    // Own vocabulary, wider than OpenAI's: besides `stop` and `length` there's
    // `client_cancelled` (D27, case 1). Flattening a client-side cutoff to
    // `stop` would claim the response finished, which is the one thing this
    // field must not do.
    finishReason: finishReason || 'stop',
    // The BILLING address, which is the one that signs. It's called
    // `providerPubkey` because that's how D24 names it; what it carries is the
    // wallet, not the network key.
    providerPubkey
  }
}

// Signs with the wallet. `firmar` is the function bin.mjs injects, wrapping
// WDK's `account.sign`: no seed ever enters here.
//
// Doesn't throw if the signature fails: returns null and leaves it to the
// caller. An attestation that couldn't be signed is NOT emitted unsigned — an
// artifact that looks like proof and isn't is worse than none at all.
export async function firmar(atestacion, firmarMensaje) {
  if (typeof firmarMensaje !== 'function') return null
  try {
    const signature = await firmarMensaje(bytesFirmados(atestacion))
    if (typeof signature !== 'string' || !signature.startsWith('0x')) return null
    return { ...atestacion, signature }
  } catch (err) {
    // The request id and a stack: the reason surfaced in the receipt is
    // generic ("the wallet could not sign the attestation"), so this is the
    // only place the real cause is recorded.
    const rid = (atestacion && atestacion.requestId) || '?'
    console.error(
      `[atestacion] ${rid}: could not sign: ${(err && err.stack) || (err && err.message) || err}`
    )
    return null
  }
}

// Verifies that the signature matches the content AND matches whoever claims
// to have served it.
//
// Returns `{ ok, reason }` instead of a boolean for the same reason as
// `verifyManifest`: you need to be able to log WHY it was rejected, and
// "false" doesn't debug itself.
//
// Both halves matter separately. That the signature validates proves that
// someone with that key signed that content; that the signer MATCHES
// `providerPubkey` is what stops anyone from building an attestation with
// their own wallet and presenting it as another node's.
export async function verificar(atestacion) {
  if (!atestacion || typeof atestacion !== 'object') {
    return { ok: false, reason: 'la atestacion no es un objeto' }
  }
  if (atestacion.v !== VERSION) {
    return { ok: false, reason: `version ${atestacion.v} desconocida` }
  }
  if (typeof atestacion.signature !== 'string' || !atestacion.signature.startsWith('0x')) {
    return { ok: false, reason: 'falta la firma o no es una firma EVM' }
  }

  const viem = await import('viem')
  let firmante
  try {
    firmante = await viem.recoverMessageAddress({
      message: bytesFirmados(atestacion),
      signature: atestacion.signature
    })
  } catch (err) {
    return { ok: false, reason: `no se pudo recuperar el firmante: ${(err && err.message) || err}` }
  }

  if (firmante.toLowerCase() !== String(atestacion.providerPubkey || '').toLowerCase()) {
    return {
      ok: false,
      // NOTE: kept in Spanish — test/index.js:2698 asserts on the exact
      // substring 'dice ser de' in this reason string.
      reason: `firmo ${firmante} y la atestacion dice ser de ${atestacion.providerPubkey}`
    }
  }

  return { ok: true, reason: null, firmante }
}

// Why this node CANNOT sign an attestation for this request, or `null` if it
// can. Lives here and not in the gateway so the rule can be tested on its
// own: it's what decides whether the artifact exists, and the easiest one to
// loosen later.
//
// THE CASE THAT MATTERS MOST IS THE PEER'S, AND IT'S THE ONE THAT DOESN'T GET
// SIGNED. D24 asks for the PROVIDER to attest. When it was another node that
// served, this gateway isn't the provider: it didn't run the model, and on
// top of that the 402's `payTo` pointed at the PEER's wallet (D10), not ours.
// Signing an attestation here about someone else's work would be exactly the
// kind of artifact that looks like proof and isn't. The peer's attestation is
// signed by the peer and travels over Protomux: that's Phase 10.
export function porQueNoSeFirma({ node, walletAddress, tieneFirmante }) {
  if (!node) return 'no candidate answered'
  if (node.kind === 'peer') {
    // NOTE: kept in Spanish — test/index.js:4049 asserts on this exact string.
    return 'el que sirvio fue otro nodo: su atestacion la firma el, y viaja por Protomux (Fase 10)'
  }
  // NOTE: kept in Spanish — test/index.js:4371 asserts on this exact string.
  if (!walletAddress) return 'este nodo no tiene wallet con que firmar'
  if (!tieneFirmante) {
    return 'the keystore did not expose a signer: no attestation is emitted unsigned'
  }
  return null
}

// The quantization the node DECLARES, pulled from the model name.
//
// QVAC registry names carry it inside (`…Q4_K_M`, `…q8_0`, `…Q4_0`), so there's
// no need to invent a new field or touch the frozen manifest schema — which D2
// forbids and which B19 already showed clashes with `additionalProperties:
// false`.
//
// It's a DECLARATION derived from another declaration: if a node lies about
// the model name, this lies too. D26 decides that's covered by stake and
// arbitration and not by a probe, because today nobody knows how to detect it
// black-box. Returns 'unknown' when the name says nothing, which is more
// honest than assuming F16.
export function cuantizacionDe(modelId) {
  const s = String(modelId || '')
  const q = s.match(/\b(Q\d+(?:_[A-Za-z0-9]+)*|IQ\d+(?:_[A-Za-z0-9]+)*|BF16|F16|F32)\b/i)
  return q ? q[1].toUpperCase() : 'unknown'
}
