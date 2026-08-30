// The x402 stack, loaded the only way that works under Bare.
// Phase 9 of ROADMAP_FASE7-X402 (D8, D9, D10, D14, D15).
//
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS, AND WHY IT ISN'T A LOOSE `import`
//
// `@x402/evm` DOES NOT IMPORT UNDER BARE ON ITS OWN, and the cause has been
// diagnosed: **viem uses `TextEncoder`, which Bare doesn't have as a global.**
//
//     before importing WDK:   typeof globalThis.TextEncoder === 'undefined'
//     after:                  'function'
//
// WDK installs them (`TextEncoder` and `TextDecoder`) when it loads, and
// viem — which sits underneath `@x402/evm` — uses them in
// `utils/encoding/toHex.js`. Without that polyfill, the import dies with
// `ReferenceError: TextEncoder is not defined`.
//
// Just IMPORTING WDK is enough: there's no need to derive an account or open
// a wallet. What matters is that the polyfill gets installed first.
//
// (There was a second problem, already fixed elsewhere: `@noble/hashes`
// picked its `node:crypto` variant under the packer. That broke the BINARY,
// not the runtime, and `scripts/parche-noble-bare.js` fixes it.)
//
// Depending on a polyfill installed by another package is still fragile, so
// instead of leaving it as a top-of-file `import` that someone will reorder
// in an import refactor — and the failure would show up three hops
// later — it lives here, with the why right next to it, watched over by two
// things:
//
//   - step 5 of `scripts/spike-d11-wdk-bare.mjs`, which measures whether
//     `@x402/evm` imports IN ISOLATION by spawning a clean bare process
//     (fails today, and it's fine that it does: the spike fails, not the
//     phase);
//   - a test in the suite that loads THIS module in a clean process.
//
// The day `@noble/hashes` or Bare change, one of the two breaks and says
// exactly what broke.
//
// -----------------------------------------------------------------------------
// D15 — THE CHAINS, AND THE ONE X402 DOESN'T KNOW
//
// D15 decided on Plasma (`eip155:9745`) as the default and Stable
// (`eip155:988`) as fallback. But `@x402/evm` only ships Stable out of the
// box:
//
//     getDefaultAsset('eip155:988')   -> USDT0, 6 decimals
//     getDefaultAsset('eip155:9745')  -> throw: "No default asset configured"
//
// So we have to declare Plasma's asset ourselves, and that's exactly the kind
// of data you don't make up: it's the address of a contract that real money
// is going to be sent to. See `ACTIVOS` below.

import env from 'bare-env'

// -----------------------------------------------------------------------------
// The chains
// -----------------------------------------------------------------------------

// CAIP-2 for each network this node can accept, in D15's order of preference.
// The short names are what travels in the manifest's `economic.chains`
// (kebab-case, see wallet.mjs).
//
// `plasma-testnet` (9746) is added by Phase 10 and REOPENS Phase 9: D30
// decided nothing gets a first run on mainnet, so the `curl` that actually
// charges does it on 9746 first. The chainId isn't a config detail — under
// EIP-155 it's part of what gets signed — so 9745 and 9746 are two different
// networks, not one with a flag.
export const CAIP2 = {
  plasma: 'eip155:9745',
  'plasma-testnet': 'eip155:9746',
  stable: 'eip155:988'
}

// The asset each network charges in.
//
// Stable's is NOT written here: it's requested from `@x402/evm`, which ships
// it out of the box. Duplicating a contract address the package already knows
// would create a second source of truth for a value that, if it drifts,
// sends money somewhere else.
//
// Plasma's does have to be declared, because x402 doesn't have it. And here's
// the honest limit: the address below is the one the D11 spike used
// (`scripts/spike-d11-wdk-bare.mjs`, the signature's EIP-712 domain), and
// **it is not verified against the chain**. That's why `activoDe()` doesn't
// just hand it out: it requires the operator to confirm, because the failure
// mode is sending USD₮ to the wrong contract, and that has no undo.
const PLASMA_USDT0_SIN_VERIFICAR = {
  asset: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
  name: 'USDT0',
  version: '1',
  decimals: 6,
  symbol: 'USDT0'
}

// The variable the operator uses to declare they've verified Plasma's address
// against the explorer. Without this, Plasma stays disabled and charging
// falls back to Stable.
export const VAR_PLASMA_OK = 'PYRUS_X402_PLASMA_ASSET_VERIFICADO'

// -----------------------------------------------------------------------------
// Plasma TESTNET (9746) — where D30 says first runs happen
// -----------------------------------------------------------------------------

// On 9746 there is NO stablecoin: the faucets only give out XPL, which is
// native gas and has no contract. The EIP-3009 asset gets deployed by the
// operator (`npm run desplegar-activo`, `scripts/activo-prueba.sol` → tUSD)
// and each deployment has its own address, so — unlike Plasma mainnet —
// there's no canonical constant to hardcode here: it's declared via
// environment variable.
//
// These are the SAME names `scripts/verificar-x402.js` reads, which is what
// checks AGAINST THE CHAIN that the contract implements EIP-3009 and that its
// EIP-712 domain matches what we're about to sign. Nothing gets verified
// here: declaring `ASSET` and `NAME` is the operator saying "I already ran it
// and it checked out." Without both, the network isn't offered — the default
// is not charging on a network nobody declared an asset for.
export const VAR_PLASMA_TESTNET_ASSET = 'PYRUS_X402_PLASMA_TESTNET_ASSET'
export const VAR_PLASMA_TESTNET_NAME = 'PYRUS_X402_PLASMA_TESTNET_NAME'
export const VAR_PLASMA_TESTNET_SYMBOL = 'PYRUS_X402_PLASMA_TESTNET_SYMBOL'
export const VAR_PLASMA_TESTNET_VERSION = 'PYRUS_X402_PLASMA_TESTNET_VERSION'
export const VAR_PLASMA_TESTNET_DECIMALS = 'PYRUS_X402_PLASMA_TESTNET_DECIMALS'

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

let cache = null

// Loads the stack, in order. Returns `{ core, evm }`.
//
// It's async and cached: importing WDK is expensive, and this gets called on
// the request path. The second time it comes from memory.
export async function cargar() {
  if (cache) return cache

  // THIS IMPORT DOES NOT MOVE AND DOES NOT GET DELETED. See the header: it
  // installs the `TextEncoder`/`TextDecoder` globals viem needs, and without
  // it the one below dies with a ReferenceError that doesn't mention x402
  // anywhere.
  await import('@tetherto/wdk-wallet-evm')

  const core = await import('@x402/core')
  const evm = await import('@x402/evm')

  cache = { core, evm }
  return cache
}

// The asset charged on `red` ('plasma' | 'stable'), or null if that network
// can't be used yet.
//
// Returning null instead of throwing is deliberate: Plasma being unavailable
// isn't a program error, it's incomplete configuration, and the caller has to
// be able to fall back to Stable — which is exactly what D15 calls the
// fallback — instead of being unable to charge at all.
export async function activoDe(red) {
  const { evm } = await cargar()
  const id = CAIP2[red]
  if (!id) return null

  if (red === 'plasma') {
    // Without the operator's explicit confirmation, Plasma isn't used. The
    // default is not charging on a network whose contract address nobody
    // verified.
    if (env[VAR_PLASMA_OK] !== '1') return null
    return { network: id, ...PLASMA_USDT0_SIN_VERIFICAR }
  }

  if (red === 'plasma-testnet') {
    // Same as Plasma but with no out-of-the-box address: the operator sets
    // it after running `npm run verificar-x402`. Without `ASSET` and `NAME`
    // the network doesn't enter `accepts[]` — a client can't sign an EIP-712
    // against a half-declared domain.
    const asset = env[VAR_PLASMA_TESTNET_ASSET]
    const name = env[VAR_PLASMA_TESTNET_NAME]
    if (!asset || !name) return null
    const dec = Number(env[VAR_PLASMA_TESTNET_DECIMALS] || 6)
    return {
      network: id,
      asset,
      name,
      version: env[VAR_PLASMA_TESTNET_VERSION] || '1',
      decimals: Number.isFinite(dec) ? dec : 6,
      symbol: env[VAR_PLASMA_TESTNET_SYMBOL] || name
    }
  }

  try {
    return { network: id, ...evm.getDefaultAsset(id) }
  } catch {
    return null
  }
}

// The networks this node can accept TODAY, in order of preference. Can be
// shorter than `wallet.CHAINS`: the manifest declares which networks the node
// wants to charge on, this says which ones it actually can.
export async function redesDisponibles() {
  const out = []
  for (const red of ['plasma', 'plasma-testnet', 'stable']) {
    if (await activoDe(red)) out.push(red)
  }
  return out
}

// -----------------------------------------------------------------------------
// The 402
// -----------------------------------------------------------------------------

// An `accepts[]` entry: what's accepted, how much, to whom, and on which
// network.
//
// D9(a) — `exact` scheme: a FIXED amount declared before generating. An LLM
// doesn't know how many tokens it's going to produce, so the honest thing is
// what the DoD asks for literally: that the 402 declare the cap. `accepts[]`
// says "up to N output tokens for $X" and the gateway enforces that
// `max_tokens` even if the client doesn't send one. Charging a fixed price
// without declaring the cap would be charging for something the client can't
// bound.
//
// `maxTimeoutSeconds` is how long the signed authorization is valid for: past
// that, the client can sign again without risk of the old one being charged
// late.
export function entradaAccepts({
  payTo,
  activo,
  micros,
  maxTokens,
  recurso,
  descripcion,
  maxTimeoutSeconds = 300
}) {
  if (!payTo) throw new Error('x402: no one to pay')
  if (!activo) throw new Error('x402: no asset for that network')

  // Micro-dollars -> minimum units of the asset. USD₮0 has 6 decimals, so 1
  // micro-dollar IS one minimum unit; it's calculated anyway instead of
  // assumed, because `decimals` comes from the asset and not everything in
  // x402's table is 6 (some are 18).
  const amount = montoEnUnidades(micros, activo)

  return {
    scheme: 'exact',
    network: activo.network,
    // `amount`, not `maxAmountRequired`. The latter is x402 v1's name and
    // it's the one that shows up in half the docs; the v2 client reads
    // `amount` (`createEIP3009Payload` in @x402/evm), so with the old name
    // the client signs `BigInt(undefined)` and doesn't even get to send us
    // anything. Checked against the package, not guessed.
    amount,
    resource: recurso,
    description: descripcion,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds,
    asset: activo.asset,
    // `extra` is where EVM's `exact` scheme expects the token's EIP-712
    // domain, which is what the client needs to sign the authorization.
    extra: { name: activo.name, version: activo.version },
    // NOT part of the x402 spec: this is ours, and it's the honest half of
    // D9(a). The client has to be able to know how much work that fixed
    // amount is paying for, and "up to N output tokens" is that number.
    outputTokenLimit: maxTokens
  }
}

// The full body of a 402, with one entry per available network.
//
// Ordered by D15's preference, and the client picks. If no usable network is
// left, returns null: the caller has to be able to tell "payment required"
// apart from "this node can't charge," which end up as different responses.
export async function desafio({ payTo, micros, maxTokens, recurso, descripcion }) {
  const { core } = await cargar()
  const accepts = []
  for (const red of await redesDisponibles()) {
    accepts.push(
      entradaAccepts({
        payTo,
        activo: await activoDe(red),
        micros,
        maxTokens,
        recurso,
        descripcion
      })
    )
  }
  if (accepts.length === 0) return null
  return { x402Version: core.x402Version, error: 'X-PAYMENT header is required', accepts }
}

// -----------------------------------------------------------------------------
// Verification (D12)
// -----------------------------------------------------------------------------

// D12 decides: synchronous VERIFY, serve, SETTLE later. This is the first
// part, and it's what protects the provider from spending GPU for free.
//
// It doesn't touch the chain, and that's not an optimization: putting an
// on-chain transaction in front of the first token would put its latency in
// front of TTFT, which is the number the project measures and publishes.
// What gets verified here is that the authorization is PROPERLY SIGNED and
// says what it has to say. Whether the wallet has balance is found out at
// settlement time, and that's what the facilitator is for.
//
// What this does NOT prove, and it has to be said: that the payer has funds,
// and that the nonce hasn't already been used. A signer with no balance
// passes this verification and fails at settlement. That's exactly the risk
// D12 accepts in exchange for TTFT, and it's why Phase 10 (batched receipts)
// exists.
//
// NOTE: the `motivo` (reason) strings returned by this function are asserted
// verbatim by tests (e.g. `test/index.js`, `test/integracion.js` check for
// exact substrings like "red equivocada" / "firma no corresponde"). They are
// left in Spanish deliberately — translating them here without updating the
// corresponding test assertions in the same pass would break the test suite.
export async function verificarPago(cabecera, { payTo, activo, micros, red }) {
  const no = (motivo) => ({ ok: false, motivo })

  if (!cabecera) return no('falta el header X-PAYMENT')
  if (!activo) return no('no hay activo para esa red')

  let sobre
  try {
    sobre = JSON.parse(Buffer.from(String(cabecera), 'base64').toString('utf8'))
  } catch {
    return no('el X-PAYMENT no es base64 de un JSON')
  }

  const { core } = await cargar()
  if (sobre.x402Version !== core.x402Version) {
    return no(`version de x402 no soportada: ${sobre.x402Version}`)
  }
  if (sobre.scheme && sobre.scheme !== 'exact') return no(`esquema no soportado: ${sobre.scheme}`)
  if (sobre.network && sobre.network !== activo.network) {
    return no(`red equivocada: pago en ${sobre.network}, se pidio ${activo.network}`)
  }

  const a = sobre.payload && sobre.payload.authorization
  const firma = sobre.payload && sobre.payload.signature
  if (!a || !firma) return no('el payload no trae authorization y signature')

  // WHO TO. Compared lowercase because EVM addresses travel with uppercase
  // checksums, and two forms of the SAME value can't be read as two different
  // addresses.
  if (String(a.to || '').toLowerCase() !== String(payTo).toLowerCase()) {
    return no('la autorizacion paga a otra direccion')
  }

  // HOW MUCH. Greater than or equal: overpaying is the payer's business,
  // underpaying isn't.
  let valor
  try {
    valor = BigInt(a.value)
  } catch {
    return no('el monto de la autorizacion no es un entero')
  }
  const requerido = BigInt(montoEnUnidades(micros, activo))
  if (valor < requerido) {
    return no(`el pago es de ${valor} y se pidieron ${requerido}`)
  }

  // WHEN. An expired authorization isn't accepted even if it's properly
  // signed, and neither is one that hasn't started yet.
  const ahora = BigInt(Math.floor(Date.now() / 1000))
  try {
    if (BigInt(a.validBefore) <= ahora) return no('la autorizacion ya vencio')
    if (BigInt(a.validAfter) > ahora) return no('la autorizacion todavia no es valida')
  } catch {
    return no('validAfter/validBefore no son enteros')
  }

  // WHO SIGNED. It's the only thing that can't be forged, which is why it's
  // last: if anything above is wrong, there's no need to spend an ecrecover.
  const { evm } = await cargar()
  const viem = await import('viem')
  const chainId = Number(String(activo.network).split(':')[1])
  let firmante
  try {
    firmante = await viem.recoverTypedDataAddress({
      domain: {
        name: activo.name,
        version: activo.version,
        chainId,
        verifyingContract: activo.asset
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
      signature: firma
    })
  } catch (err) {
    return no('no se pudo recuperar el firmante: ' + ((err && err.message) || err))
  }

  if (firmante.toLowerCase() !== String(a.from || '').toLowerCase()) {
    return no('la firma no corresponde a quien dice pagar')
  }

  return {
    ok: true,
    payer: firmante,
    // The nonce is the payment's idempotency key (D20): the same nonce
    // settled twice only charges once. It's returned so whoever serves the
    // request can record it.
    nonce: a.nonce,
    valor: valor.toString(),
    red,
    autorizacion: a,
    firma
  }
}

// Micro-dollars -> minimum units of the asset. Lives on its own because it's
// used by whatever builds the 402, whatever verifies it, and whatever PAYS it
// (`x402-cliente.mjs`, when converting its spending cap), and all three have
// to give EXACTLY the same result: declaring one amount and verifying against
// another rejects correct payments.
export function montoEnUnidades(micros, activo) {
  const enteros = BigInt(Math.max(0, Math.ceil(Number(micros) || 0)))
  const escala = BigInt(10) ** BigInt(Math.max(0, activo.decimals - 6))
  return (enteros * escala).toString()
}

// -----------------------------------------------------------------------------
// Settlement (D12, D14)
// -----------------------------------------------------------------------------

// THE PROTOCOL BETWEEN THIS NODE AND THE FACILITATOR, written here because
// it's what Phase 10 settles in batches, and a batch not built with these
// exact fields gets rejected on the other end without saying why.
//
// The transport is provided by `HTTPFacilitatorClient` from
// `@x402/core/http`, which sends POST JSON to `<url>/verify` and
// `<url>/settle`, and GET to `<url>/supported`. What travels in each one, by
// field name (the binding contract is the installed package's schema, not
// the public spec, which doesn't fix the response fields):
//
//   POST /verify   ->  { paymentPayload, paymentRequirements }
//   POST /settle   ->  { paymentPayload, paymentRequirements }
//
//     paymentPayload      = { x402Version, scheme: 'exact', network,
//                             payload: { authorization, signature } }
//     paymentRequirements = the `accepts[]` entry EXACTLY as offered in the
//                           402 (`entradaAccepts`): network, amount, asset,
//                           payTo, maxTimeoutSeconds, extra:{ name, version }.
//                           Recomputing it on this side would mean settling
//                           against different numbers than the ones the
//                           client signed.
//
//   /verify  <-  { isValid: boolean, invalidReason?, invalidMessage? }
//   /settle  <-  { success: boolean, transaction: string, network: string,
//                  payer: string, errorReason?, errorMessage? }
//                `transaction` and `network` come as strings even on
//                failure: the schema requires them and without them the
//                client discards the entire response (see 0-quinquies,
//                Block 0 review).
//
// This is the unit Phase 10 defers: `liquidarLote` in `qvac/lote.mjs` calls
// `liquidar()` once per accumulated receipt, with the same
// (paymentPayload, paymentRequirements) pair that would have been sent in
// Phase 9 — deferred settlement, not a new mechanism.
export const PROTOCOLO_FACILITATOR = Object.freeze({
  endpoints: Object.freeze({ verify: '/verify', settle: '/settle', supported: '/supported' }),
  // What this node SENDS on /verify and /settle.
  envia: Object.freeze(['paymentPayload', 'paymentRequirements']),
  paymentPayload: Object.freeze(['x402Version', 'scheme', 'network', 'payload']),
  paymentPayloadPayload: Object.freeze(['authorization', 'signature']),
  // What this node READS from /settle (x402's SettleResponse).
  settleResponse: Object.freeze(['success', 'transaction', 'network', 'payer']),
  settleResponseError: Object.freeze(['errorReason', 'errorMessage']),
  // What this node READS from /verify (x402's VerifyResponse).
  verifyResponse: Object.freeze(['isValid', 'invalidReason', 'invalidMessage'])
})

// D14 — the facilitator. The decision is Semantic's HOSTED one until Phase
// 10: self-hosted is in beta, needs an additional wallet with native gas, and
// adds a component we don't control to the critical path of the first demo
// that charges for real.
//
// And what needs to be said out loud, also from D14: WDK's documentation
// makes clear that Tether *"does not endorse, operate, or assume legal or
// financial responsibility for any third-party facilitator"*. That goes here
// and in the README, not hidden away.
export const FACILITATOR_DEFAULT = 'https://x402.semanticpay.io'

// Can be pointed at another one — a self-hosted one, or the tests' fake one —
// without touching code.
export const VAR_FACILITATOR = 'PYRUS_X402_FACILITATOR'

export function facilitatorUrl() {
  return env[VAR_FACILITATOR] || FACILITATOR_DEFAULT
}

// Settles an already-verified payment. Returns x402's `SettleResponse`:
// `{ success, transaction, network, payer, errorReason?, errorMessage? }`.
//
// This DOES touch the chain, which is why it happens AFTER serving (D12). The
// cost of that decision has to be stated: if settlement fails, the client has
// already received their tokens. It's deliberate — the alternative is putting
// an on-chain transaction in front of TTFT — and it's what Phase 10 actually
// fixes, by accumulating receipts instead of settling one at a time.
//
// Never throws: a settlement that fails can't take down a response that
// already went out fine. Returns `success: false` with the reason.
export async function liquidar({ pago, requisito }) {
  try {
    const { HTTPFacilitatorClient } = await import('@x402/core/http')
    const { core } = await cargar()
    const cliente = new HTTPFacilitatorClient({ url: facilitatorUrl() })

    const payload = {
      x402Version: core.x402Version,
      scheme: 'exact',
      network: requisito.network,
      payload: { authorization: pago.autorizacion, signature: pago.firma }
    }
    return await cliente.settle(payload, requisito)
  } catch (err) {
    const message = (err && err.message) || String(err)
    console.error(`[x402] settlement failed: ${message}`)
    return {
      success: false,
      errorReason: 'settlement_failed',
      errorMessage: message,
      transaction: '',
      network: requisito.network,
      payer: pago.payer
    }
  }
}

// The `X-PAYMENT-RESPONSE`, in the format x402 defines, not one of ours.
export async function cabeceraDeRecibo(recibo) {
  const { encodePaymentResponseHeader } = await import('@x402/core/http')
  return encodePaymentResponseHeader(recibo)
}
