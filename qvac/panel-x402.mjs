// What Phase 9 already emits, translated into something a PERSON can audit by
// looking at it. It adds no data of its own: it reads what the existing
// endpoints return and decides how each thing has to look.
//
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS, AND WHY IT'S NOT INSIDE pages.mjs
//
// Phase 9 produces four artifacts -- the 402 challenge, the settlement
// receipt, the signed attestation (D24), and the prefill/decode split (D25) --
// and until now all four were served over HTTP and shown in no panel at all. A
// `grep` for `attestation`, `x402`, `tokensFuente`, or `outputHash` over
// pages.mjs came back ZERO on all of them.
//
// That breaks the project's rule about mocks: whether the attestation says
// `runtime: mock`, whether it's missing WITH A REASON, or whether the hash
// matches what was actually served -- nobody could check any of that without
// curl. A signed artifact that's only visible with curl is not evidence for
// whoever has to trust the node.
//
// It lives apart from `pages.mjs` for a testing reason, not a tidiness one:
// pages.mjs exports HTML strings, and a test can't call a function that lives
// inside a string. Here they're PURE functions, which the suite exercises
// against the endpoints' REAL responses; and the panel receives that EXACT
// code, embedded via `FUENTE_EMBEBIDA` (see the end of the file). One single
// implementation, tested on the test side and run on the browser side. Copies
// would be two, and the test would verify the one the panel doesn't run.
//
// -----------------------------------------------------------------------------
// THE FIVE THINGS THIS FILE EXISTS SO THEY DON'T GET DRAWN WRONG
//
//   1. `attestation: null` is NOT a dash. It comes together with
//      `attestationMissing`, which says WHY it's missing -- and the normal
//      case is that a peer served it and the signature is theirs (Phase 10).
//      An absence with a reason is data; a silent absence is a hole that
//      reads as "it wasn't needed."
//   2. `runtime: "mock"` has to LOOK like a mock. It's an attestation signed
//      with a REAL wallet over text invented by --demo mode: the artifact is
//      genuine and the content is theater, both at once.
//   3. `tokensFuente: "gateway"` is not `"proveedor"` and doesn't get drawn
//      the same way. "gateway" means the prefill is an ESTIMATE (bytes/4) and
//      the decode is a count of SSE CHUNKS, which are not tokens.
//   4. A tx hash has to say where it came from. The facilitator returns it and
//      this page doesn't touch any chain: against the test facilitator the
//      hash is made up and doesn't exist on the explorer.
//   5. The header's cost is the estimated CEILING, not the actual figure --
//      with SSE the headers go out before the first token. The chat already
//      says this right ("up to USD ..." / "no charge") and the new part keeps
//      that same rule.
//
// -----------------------------------------------------------------------------
// WHAT THIS PAGE VERIFIES AND WHAT IT DOESN'T
//
// It VERIFIES the hashes: `outputHash` and `promptHash` are RECOMPUTED here,
// with the same BLAKE2b-256 and the same JCS canonicalization the node used
// when signing, against the text the client actually received. That's the
// whole point of D24 -- the hash is over the text, and the text doesn't
// depend on how many pieces it traveled in, so anyone can recount it. Being
// able to compare it ON SCREEN is the difference between a field and a proof.
//
// It does NOT verify the signature. Recovering the signer of an EIP-191
// requires keccak256 and secp256k1, and this tree doesn't pull in a CDN or
// hand-write curves for a panel. What it does instead is show the EXACT BYTES
// that were signed (the artifact's JCS without `signature`), which is what's
// needed to verify it externally. Which of the two things was done is always
// stated.
//
// The BLAKE2b below is checked against `sodium.crypto_generichash` in the
// unit suite -- vector by vector, including the 128-byte block boundary and
// multibyte UTF-8. A hand-written hash nobody checks would be worse than not
// comparing anything at all: it would say "DOES NOT MATCH" over a correct
// attestation.

// -----------------------------------------------------------------------------
// BLAKE2b-256 (RFC 7693)
// -----------------------------------------------------------------------------
//
// With BigInt and not pairs of 32-bit words: it's ~20 fewer lines and this
// runs once per response, not in a hot loop. The algorithm is pinned by `ALG`
// from `qvac/atestacion.mjs`, which hashes with sodium; the two have to give
// the same result and the suite checks it.

const MASCARA64 = 0xffffffffffffffffn

const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n
]

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3]
]

// UTF-8 by hand and not `TextEncoder`, for a concrete reason: `TextEncoder`
// does NOT exist under Bare -- checked, it gives `undefined` --, and the
// browser does have it. Writing each half with whatever API it happens to
// have available would mean two encoders and only checking one of them. Lone
// surrogates go to U+FFFD, which is exactly what `Buffer.from(s, 'utf8')`
// does, i.e. what the node hashed when signing.
export function bytesUtf8(texto) {
  const s = String(texto == null ? '' : texto)
  const out = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const sig = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (sig >= 0xdc00 && sig <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (sig - 0xdc00)
        i++
      } else {
        c = 0xfffd
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

function rotarDerecha64(x, n) {
  return ((x >> n) | (x << (64n - n))) & MASCARA64
}

function comprimir(h, bloque, contados, ultimo) {
  const v = new Array(16)
  for (let i = 0; i < 8; i++) v[i] = h[i]
  for (let i = 0; i < 8; i++) v[i + 8] = IV[i]

  v[12] ^= BigInt(contados) & MASCARA64
  v[13] ^= (BigInt(contados) >> 64n) & MASCARA64
  if (ultimo) v[14] ^= MASCARA64

  const m = new Array(16)
  for (let i = 0; i < 16; i++) {
    let x = 0n
    // Little-endian: the highest byte goes in first and shifts its way down.
    for (let b = 7; b >= 0; b--) x = (x << 8n) | BigInt(bloque[i * 8 + b])
    m[i] = x
  }

  function mezclar(a, b, c, d, x, y) {
    v[a] = (v[a] + v[b] + x) & MASCARA64
    v[d] = rotarDerecha64(v[d] ^ v[a], 32n)
    v[c] = (v[c] + v[d]) & MASCARA64
    v[b] = rotarDerecha64(v[b] ^ v[c], 24n)
    v[a] = (v[a] + v[b] + y) & MASCARA64
    v[d] = rotarDerecha64(v[d] ^ v[a], 16n)
    v[c] = (v[c] + v[d]) & MASCARA64
    v[b] = rotarDerecha64(v[b] ^ v[c], 63n)
  }

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r]
    mezclar(0, 4, 8, 12, m[s[0]], m[s[1]])
    mezclar(1, 5, 9, 13, m[s[2]], m[s[3]])
    mezclar(2, 6, 10, 14, m[s[4]], m[s[5]])
    mezclar(3, 7, 11, 15, m[s[6]], m[s[7]])
    mezclar(0, 5, 10, 15, m[s[8]], m[s[9]])
    mezclar(1, 6, 11, 12, m[s[10]], m[s[11]])
    mezclar(2, 7, 8, 13, m[s[12]], m[s[13]])
    mezclar(3, 4, 9, 14, m[s[14]], m[s[15]])
  }

  for (let i = 0; i < 8; i++) h[i] = h[i] ^ v[i] ^ v[i + 8]
}

export function blake2b256Hex(bytes) {
  const h = IV.slice()
  // Parameters: fanout 1, depth 1, keylen 0, 32-byte digest -> 0x01010020.
  h[0] ^= 0x01010020n

  const n = bytes.length
  let contados = 0
  let i = 0
  // Strictly `>`, not `>=`: the last full block has to be processed as FINAL
  // and not as intermediate. With `>=` the hash of an input of exactly 128
  // bytes comes out wrong, and it's the classic bug in this function.
  while (n - i > 128) {
    contados += 128
    comprimir(h, bytes.subarray(i, i + 128), contados, false)
    i += 128
  }
  const cola = new Uint8Array(128)
  cola.set(bytes.subarray(i))
  contados += n - i
  comprimir(h, cola, contados, true)

  let hex = ''
  for (let k = 0; k < 4; k++) {
    let x = h[k]
    for (let b = 0; b < 8; b++) {
      hex += (Number(x & 0xffn) + 256).toString(16).slice(1)
      x >>= 8n
    }
  }
  return hex
}

// The same format as `atestacion.hashDe`: the algorithm stuck to the value,
// so a third party knows what to recompute it with without having to guess.
export function hashDeTexto(texto) {
  return 'blake2b-256:' + blake2b256Hex(bytesUtf8(texto))
}

// JCS (RFC 8785), the same canonicalization as `manifest.canonicalize`. It's
// rewritten here instead of importing it because this file travels WHOLE to
// the browser and an import doesn't cross that boundary. The suite compares
// the two outputs field by field, which is what keeps them from drifting
// apart.
export function canonicalizarJCS(valor) {
  if (valor === null) return 'null'
  const t = typeof valor
  if (t === 'boolean') return valor ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(valor)) throw new Error('JCS: non-finite number')
    return JSON.stringify(valor)
  }
  if (t === 'string') return JSON.stringify(valor)
  if (Array.isArray(valor)) return '[' + valor.map(canonicalizarJCS).join(',') + ']'
  if (t === 'object') {
    const claves = Object.keys(valor)
      .filter(function (k) {
        return valor[k] !== undefined
      })
      .sort()
    return (
      '{' +
      claves
        .map(function (k) {
          return JSON.stringify(k) + ':' + canonicalizarJCS(valor[k])
        })
        .join(',') +
      '}'
    )
  }
  throw new Error('JCS: non-serializable type (' + t + ')')
}

export function hashDeMensajes(messages) {
  return hashDeTexto(canonicalizarJCS(messages || []))
}

// The bytes that were signed: the artifact WITHOUT `signature`. They're shown
// so the signature can be verified EXTERNALLY, which is what this page
// doesn't do.
export function bytesFirmados(atestacion) {
  const copia = {}
  const claves = Object.keys(atestacion || {})
  for (let i = 0; i < claves.length; i++) {
    if (claves[i] !== 'signature') copia[claves[i]] = atestacion[claves[i]]
  }
  return canonicalizarJCS(copia)
}

// -----------------------------------------------------------------------------
// The networks
// -----------------------------------------------------------------------------
//
// The raw CAIP-2 goes ALWAYS, with the name next to it when we know it. A
// panel that shows only "Plasma" forces you to take the panel's word for it;
// the id is the data that traveled in `accepts[]` and is what the client
// signs against.
const REDES = {
  'eip155:9745': { nombre: 'Plasma', prueba: false },
  'eip155:9746': { nombre: 'Plasma testnet', prueba: true },
  'eip155:988': { nombre: 'Stable', prueba: false }
}

export function etiquetaDeRed(caip2) {
  const id = String(caip2 || '')
  const r = REDES[id]
  return {
    id,
    nombre: r ? r.nombre : null,
    // A network not in the table doesn't get invented: the bare id is shown.
    texto: r ? r.nombre + ' · ' + id : id || 'undeclared network',
    esPrueba: !!(r && r.prueba)
  }
}

// -----------------------------------------------------------------------------
// 1 - The 402 challenge
// -----------------------------------------------------------------------------
//
// The four pieces of data Phase 9's DoD demands of the 402: HOW MUCH, TO WHOM,
// ON WHICH CHAIN, and UP TO HOW MANY TOKENS.
//
// The amount goes in the asset's MINIMUM UNITS and is NOT converted to
// dollars, and that's on purpose: `accepts[]` declares `asset` and
// `extra.name`, but does NOT declare `decimals`. Dividing by 1e6 would be
// assuming every asset has 6 -- the x402 table has 18 too -- i.e. inventing
// the data that's missing on exactly the number the person is going to read
// as "what they're going to charge me."
export function vistaDeDesafio(cuerpo) {
  const body = cuerpo || {}
  const accepts = Array.isArray(body.accepts) ? body.accepts : []
  if (!accepts.length) return { esDesafio: false, error: null, opciones: [] }

  return {
    esDesafio: true,
    x402Version: body.x402Version == null ? null : body.x402Version,
    // When the 402 is a RETRY -- the previous payment didn't verify -- the
    // gateway adds `error` with the reason. Make it visible: without that, a
    // client that signed wrong gets the same 402 twice and doesn't know what
    // changed.
    error: body.error && body.error !== 'X-PAYMENT header is required' ? String(body.error) : null,
    opciones: accepts.map(function (a) {
      return {
        // HOW MUCH
        monto: String(a.amount == null ? '' : a.amount),
        activo: String(a.asset || ''),
        activoNombre: (a.extra && a.extra.name) || null,
        // `accepts[]` doesn't declare `decimals`, so the amount isn't
        // converted to USD without inventing it. It's stated, instead of
        // dividing by 1e6 and hoping.
        // NOTE: this string is asserted verbatim by test/index.js (checks
        // for the substring "no declara los decimales") — left in Spanish.
        avisoMonto:
          'en unidades minimas del activo — el 402 no declara los decimales, ' +
          'asi que esta pagina no lo convierte a USD',
        // TO WHOM
        payTo: String(a.payTo || ''),
        // ON WHICH CHAIN
        red: etiquetaDeRed(a.network),
        // UP TO HOW MANY TOKENS
        tope: Number.isFinite(Number(a.outputTokenLimit)) ? Number(a.outputTokenLimit) : null,
        esquema: String(a.esquema || a.scheme || ''),
        recurso: String(a.resource || ''),
        descripcion: String(a.description || ''),
        validezSeg: Number.isFinite(Number(a.maxTimeoutSeconds))
          ? Number(a.maxTimeoutSeconds)
          : null
      }
    })
  }
}

// -----------------------------------------------------------------------------
// 2 - The settlement receipt
// -----------------------------------------------------------------------------
//
// Where the tx hash comes from, and why it's not presented as a fact of the
// chain: it's returned by the FACILITATOR that settled it, and neither the
// gateway nor this page looks at any chain to check it. Against the test
// facilitator the hash is made up -- `0xfefe...fe` -- and it doesn't exist on
// the explorer.
//
// The `txSintetico` flag is NOT a heuristic about "hashes that look fake": it's
// a property of the value itself. A transaction hash is the output of keccak
// over the transaction; its 32 bytes all being EQUAL doesn't happen in
// practice, and it IS exactly what a toy facilitator emits. What can be
// asserted about the value gets flagged; the rest is stated as a warning for
// ALL hashes alike, including the ones that look good.
export function vistaDeLiquidacion(recibo) {
  const r = recibo || {}
  const tx = String(r.transaction || '')
  const cuerpo = tx.indexOf('0x') === 0 ? tx.slice(2) : tx
  const bytes = cuerpo.length >= 2 ? cuerpo.toLowerCase().match(/../g) || [] : []
  const todosIguales =
    bytes.length > 1 &&
    bytes.every(function (b) {
      return b === bytes[0]
    })

  return {
    liquidado: r.success === true,
    // A `success: false` is NOT a formality: the node served and didn't get
    // paid. D12 accepts that in exchange for not putting an on-chain
    // transaction in front of TTFT, and it's what Phase 10 fixes by
    // accumulating receipts.
    error:
      r.success === true
        ? null
        : [r.errorReason, r.errorMessage].filter(Boolean).join(': ') ||
          // NOTE: not asserted by the test suite — safe to translate.
          'settlement did not report success',
    tx: tx || null,
    txSintetico: todosIguales,
    // The origin always goes along, whether the hash is real or a toy one. A
    // hash with no provenance reads as a confirmed transaction, and nothing
    // was confirmed here.
    // NOTE: both branches below are asserted verbatim by the test suite
    // (checks for the substrings "PRUEBAS" and "verificaron contra la
    // cadena") — left in Spanish.
    txOrigen: tx
      ? todosIguales
        ? 'sus 32 bytes son todos iguales: es el sello de un facilitator de PRUEBAS, ' +
          'no existe en ningun explorer'
        : 'lo devolvio el facilitator que liquido; ni el nodo ni esta pagina lo ' +
          'verificaron contra la cadena'
      : null,
    red: etiquetaDeRed(r.network),
    payer: r.payer ? String(r.payer) : null
  }
}

// -----------------------------------------------------------------------------
// 3 - The provider's attestation (D24)
// -----------------------------------------------------------------------------
//
// `attestation: null` comes together with `attestationMissing`, which says WHY
// it's missing. That reason IS the data: the normal case is that a peer
// served it, and then the signature that belongs is THEIRS (Phase 10) -- this
// node doesn't attest work it didn't do. Drawing a dash there turns a design
// decision into a hole.
//
// `textoRecibido` and `messages` are optional: when present, the hashes get
// RECOMPUTED and compared. When absent, it says it wasn't compared -- which is
// not the same as "matches," and those are three distinct states on purpose.
export function vistaDeAtestacion(recibo, contexto) {
  const r = recibo || {}
  const ctx = contexto || {}
  const a = r.attestation || null

  if (!a) {
    const motivo = r.attestationMissing ? String(r.attestationMissing) : null
    return {
      hay: false,
      // No attestation AND no reason means the response is incomplete, and
      // that's stated as such: it's different from "there was nothing to
      // sign."
      // NOTE: asserted verbatim by the test suite (checks for the substring
      // "incompleta") — left in Spanish.
      motivo:
        motivo ||
        'el recibo no trae atestacion NI el motivo por el que falta: es una respuesta ' +
          'incompleta, no una ausencia justificada',
      motivoDeclarado: !!motivo,
      // The one case where the absence is CORRECT and not a failure: a peer
      // served it, its wallet got paid, and its attestation is the one that
      // signs it (Phase 10).
      // NOTE: 'otro nodo' ("other node") here is compared against Spanish
      // text produced elsewhere (attestationMissing, outside this file's
      // scope) via indexOf — a data comparison, not display prose. Left
      // untranslated; translating it would silently break `esDelPar`.
      esDelPar: !!(motivo && motivo.indexOf('otro nodo') !== -1)
    }
  }

  const runtime = String(a.runtime || 'unknown')
  // A mock signed with a REAL wallet is still a mock. The artifact is genuine
  // and the text is made up, and the two have to be visible together.
  const esMock = runtime === 'mock' || runtime.indexOf('mock') === 0

  const hashes = [
    comparacionDeHash('outputHash', a.outputHash, ctx.textoRecibido, hashDeTexto),
    comparacionDeHash('promptHash', a.promptHash, ctx.messages, hashDeMensajes)
  ]

  return {
    hay: true,
    version: a.v == null ? null : a.v,
    requestId: String(a.requestId || ''),
    nonce: String(a.nonce || ''),
    ts: Number(a.ts) || null,
    modelId: a.modelId == null ? null : String(a.modelId),
    // DECLARED, not measured (D26). There's no published black-box way to
    // verify quantization: what backs these two fields is that they're
    // signed and there's stake behind them, not a measurement.
    quantization: String(a.quantization || 'unknown'),
    runtime,
    // NOTE: asserted verbatim by the test suite (checks for the substring
    // "DECLARACIONES") — left in Spanish.
    declarados: 'quantization y runtime son DECLARACIONES firmadas, no mediciones (D26)',
    esMock,
    // NOTE: asserted via `.indexOf('demo')` — the literal flag name `--demo`
    // (never translated per rule 2) already guarantees that substring, so
    // the surrounding prose is safe to translate.
    avisoMock: esMock
      ? 'MOCK: the text was made up by --demo mode. The signature is from a REAL wallet ' +
        'over text no model generated — the artifact is genuine and the content is theater'
      : null,
    finishReason: String(a.finishReason || ''),
    finishTexto: textoDeFinishReason(a.finishReason),
    // The attestation does NOT carry `tokensFuente`: what declares it is the
    // routing trail (D25). It's still run through `vistaDeConteo` so the two
    // numbers never get drawn as a measurement when nobody said they were.
    conteo: vistaDeConteo({
      tokensPrefill: a.tokensPrefill,
      tokensDecode: a.tokensDecode,
      tokensFuente: ctx.tokensFuente
    }),
    providerPubkey: String(a.providerPubkey || ''),
    signature: String(a.signature || ''),
    // The bytes it was signed against, so it can be verified EXTERNALLY.
    firmadoSobre: bytesFirmados(a),
    firmaVerificada: false,
    // NOTE: asserted verbatim by the test suite (checks for the substring
    // "NO verifica la firma") — left in Spanish.
    avisoFirma:
      'esta pagina NO verifica la firma — recuperar el firmante de un EIP-191 pide ' +
      'keccak256 y secp256k1, y aca no entra un CDN. Los hashes SI se recomputan; ' +
      'para verificar la firma, los bytes firmados estan abajo',
    hashes
  }
}

// Recomputes a hash and compares it, or says it wasn't compared. The four
// outcomes are deliberately distinct, and the one that matters most is
// `sin-material`: "I couldn't compare it" is not "matches," and a panel that
// blurs them turns a lack of evidence into evidence.
//
// NOTE: the `estado` values ('sin-dato', 'sin-material', 'error', 'coincide',
// 'no-coincide') are enum-like data asserted verbatim by the test suite and
// also used as CSS-class-adjacent tokens — left untranslated per rule 2/3.
// The `texto` strings for 'sin-material' and both 'coincide'/'no-coincide'
// cases are ALSO asserted verbatim (indexOf checks for "no se recomputo",
// "coincide", and "NO coincide") — left in Spanish. Only 'sin-dato' and the
// dynamic 'error' message are untested and were translated.
function comparacionDeHash(campo, declarado, material, recomputar) {
  const dec = declarado == null ? null : String(declarado)
  if (!dec) {
    return { campo, declarado: null, estado: 'sin-dato', texto: 'the attestation does not carry it' }
  }
  if (material === undefined || material === null) {
    return {
      campo,
      declarado: dec,
      estado: 'sin-material',
      texto: 'no se recomputo: esta vista no tiene contra que compararlo'
    }
  }
  let calculado = null
  try {
    calculado = recomputar(material)
  } catch (err) {
    return {
      campo,
      declarado: dec,
      estado: 'error',
      texto: 'could not recompute: ' + ((err && err.message) || err)
    }
  }
  const coincide = calculado === dec
  return {
    campo,
    declarado: dec,
    calculado,
    estado: coincide ? 'coincide' : 'no-coincide',
    texto: coincide
      ? 'recomputado sobre lo que se recibio: coincide'
      : 'recomputado sobre lo que se recibio: NO coincide'
  }
}

// D27 in words. `client_cancelled` is our own vocabulary and wider than
// OpenAI's: flattening it to `stop` would claim the response finished.
//
// NOTE: every return value here is asserted verbatim (or via indexOf) by the
// test suite ('termino sola', the substring 'tope', the substring 'lo corto
// el cliente', and 'no declarado') — the whole function is left in Spanish.
export function textoDeFinishReason(reason) {
  const r = String(reason || '')
  if (r === 'stop') return 'termino sola'
  if (r === 'length') return 'se corto en el tope de tokens que declaro el 402 (D9)'
  if (r === 'client_cancelled') {
    return 'lo corto el cliente: se atestigua el prefijo emitido (D27 caso 1)'
  }
  return r || 'no declarado'
}

// -----------------------------------------------------------------------------
// 4 - El split prefill/decode y su procedencia (D25)
// -----------------------------------------------------------------------------
//
// `proveedor` y `gateway` NO son la misma clase de numero y no pueden dibujarse
// igual. Con `gateway` el prefill es una ESTIMACION del prompt y el decode es un
// conteo de CHUNKS DE SSE -- y quien decide como se trocea el stream es el
// proveedor, o sea que ese numero lo mueve el otro lado sin mentir en ningun
// campo y sin romper ninguna validacion. Es el ataque que D24 cierra con el
// `outputHash`, y es la razon por la que la procedencia va al lado del numero y
// no en una nota al pie.
export function vistaDeConteo(entrada) {
  const e = entrada || {}
  const fuente = e.tokensFuente == null ? null : String(e.tokensFuente)
  const prefill = Number.isFinite(Number(e.tokensPrefill)) ? Number(e.tokensPrefill) : null
  const decode = Number.isFinite(Number(e.tokensDecode)) ? Number(e.tokensDecode) : null

  if (fuente === null) {
    return {
      fuente: null,
      medido: false,
      prefill,
      decode,
      // Las entradas anteriores a D25 no tienen el campo, y la atestacion no lo
      // lleva nunca. Decir "gateway" aca seria afirmar algo que el dato no dice.
      etiqueta: 'sin procedencia',
      texto:
        'no declara de donde salieron estos numeros: el que lo dice es el rastro de ruteo (D25)',
      tono: 'ausente'
    }
  }
  if (fuente === 'proveedor') {
    return {
      fuente,
      medido: true,
      prefill,
      decode,
      etiqueta: 'medido',
      texto:
        'los dos numeros salieron del `usage` del proveedor: son tokens contados por su tokenizador',
      tono: 'medido'
    }
  }
  return {
    fuente,
    medido: false,
    prefill,
    decode,
    etiqueta: 'estimado',
    texto:
      'NO son tokens medidos: el prefill es una estimacion del prompt (bytes/4) y el decode es ' +
      'un conteo de CHUNKS DE SSE, que no son tokens — quien decide como se trocea el ' +
      'stream es el proveedor',
    tono: 'estimado'
  }
}

// -----------------------------------------------------------------------------
// El costo del header (regla 5)
// -----------------------------------------------------------------------------
//
// Con SSE los headers salen ANTES del primer token, asi que
// `X-Pyrus-Cost-Estimate-Micros` es el TECHO con el que se autorizo el gasto y
// nunca lo que salio. El chat ya lo decia bien ("up to USD ..." / "no charge");
// esto es la misma regla en un solo lugar, para que lo nuevo no la afloje.
export function textoDeCostoEstimado(micros) {
  const n = Number(micros)
  if (!Number.isFinite(n)) return { texto: 'sin dato de costo', techo: false }
  if (n <= 0) return { texto: 'no charge', techo: false }
  // Seis decimales y no cuatro: con cuatro, cualquier turno de menos de 50
  // micros se muestra "USD 0.0000", o sea identico a gratis, que es justo la
  // distincion que esta linea existe para hacer.
  const s = (n / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return { texto: 'up to USD ' + s, techo: true }
}

// -----------------------------------------------------------------------------
// EL DIBUJO
// -----------------------------------------------------------------------------
//
// Los renderers viven ACA y no en pages.mjs, y no es por prolijidad: las cinco
// cosas que este trabajo existe para no dibujar mal se pierden en el dibujo, no
// en el modelo. Un `vistaDeAtestacion` perfecto que la pagina pinta como "—" no
// arregla nada. Estando aca, la suite puede afirmar sobre el HTML mismo -- que
// el motivo de la ausencia APARECE, que el mock se ve, que "estimado" no se
// pinta igual que "medido" -- y `bug-puesto` puede romperlos y ver caer el test.
//
// pages.mjs sigue siendo el dueno del CSS y del layout; lo que se decide aca es
// QUE dice cada bloque, no como se ve.

function escaparHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function filaDato(etiqueta, valor, clase) {
  return (
    '<div class="x-fila"><span class="x-k">' +
    escaparHtml(etiqueta) +
    '</span><span class="x-v ' +
    (clase || '') +
    '">' +
    escaparHtml(valor) +
    '</span></div>'
  )
}

// El 402, con los CUATRO datos que el DoD exige, cada uno nombrado. No se
// resumen en una frase: "hasta 256 tokens por 1000 unidades a 0xab...ab en
// Stable" se lee lindo y esconde cual numero es cual.
export function htmlDeDesafio(vista) {
  const v = vista || {}
  if (!v.esDesafio) return ''
  const partes = [
    '<div class="x402">',
    '<div class="x-tit">402 · este nodo pide pago antes de generar un solo token</div>'
  ]
  if (v.error) {
    partes.push(
      '<div class="x-aviso malo">el pago anterior no verifico: ' + escaparHtml(v.error) + '</div>'
    )
  }
  for (let i = 0; i < v.opciones.length; i++) {
    const o = v.opciones[i]
    partes.push('<div class="x-op">')
    partes.push(filaDato('CUANTO', o.monto + (o.activoNombre ? ' ' + o.activoNombre : ''), 'mono'))
    partes.push('<div class="x-nota">' + escaparHtml(o.avisoMonto) + '</div>')
    partes.push(filaDato('activo', o.activo, 'mono'))
    partes.push(filaDato('A QUIEN', o.payTo, 'mono'))
    partes.push(
      filaDato('EN QUE RED', o.red.texto + (o.red.esPrueba ? ' — red de PRUEBA' : ''), 'mono')
    )
    partes.push(
      filaDato(
        'HASTA CUANTOS TOKENS',
        o.tope === null ? 'no declarado' : o.tope + ' tokens de salida'
      )
    )
    partes.push(
      filaDato(
        'esquema',
        o.esquema + (o.validezSeg === null ? '' : ' · la firma vale ' + o.validezSeg + ' s')
      )
    )
    partes.push('</div>')
  }
  partes.push(
    '<div class="x-nota">El tope de salida es el mismo numero que el gateway aplica despues, ' +
      'y por eso el precio fijo es honesto (D9). Pagar es re-enviar el request con el header ' +
      'X-PAYMENT firmado.</div>'
  )
  partes.push('</div>')
  return partes.join('')
}

// El badge de procedencia del conteo. `medido` y `estimado` NO comparten clase
// ni texto: es la regla 3, y es lo unico que separa un token contado por el
// tokenizador del proveedor de un chunk de SSE.
export function htmlDeConteo(vista) {
  const c = vista || {}
  const n = function (x) {
    return x === null ? '?' : String(x)
  }
  return (
    '<span class="x-conteo tono-' +
    escaparHtml(c.tono) +
    '" title="' +
    escaparHtml(c.texto) +
    '">prefill ' +
    escaparHtml(n(c.prefill)) +
    ' · decode ' +
    escaparHtml(n(c.decode)) +
    ' · <b>' +
    escaparHtml(c.etiqueta) +
    '</b></span>'
  )
}

export function htmlDeLiquidacion(vista) {
  const v = vista || {}
  const partes = ['<div class="x-bloque">', '<div class="x-tit">Recibo de liquidacion (x402)</div>']
  partes.push(
    v.liquidado
      ? '<div class="x-aviso bueno">el facilitator informo la liquidacion como exitosa</div>'
      : '<div class="x-aviso malo">NO se cobro: ' +
          escaparHtml(v.error) +
          ' — el nodo sirvio igual, que es lo que D12 acepta a cambio de no poner una ' +
          'transaccion on-chain delante del primer token</div>'
  )
  partes.push(filaDato('red', v.red.texto + (v.red.esPrueba ? ' — red de PRUEBA' : ''), 'mono'))
  if (v.payer) partes.push(filaDato('pago', v.payer, 'mono'))
  if (v.tx) {
    partes.push(filaDato('tx hash', v.tx, 'mono'))
    // Regla 4: el hash NUNCA sale sin decir de donde vino.
    partes.push(
      '<div class="x-aviso ' +
        (v.txSintetico ? 'malo' : 'tibio') +
        '">' +
        escaparHtml(v.txOrigen) +
        '</div>'
    )
  } else {
    partes.push(filaDato('tx hash', 'no lo devolvio el facilitator'))
  }
  partes.push('</div>')
  return partes.join('')
}

export function htmlDeAtestacion(vista) {
  const v = vista || {}
  if (!v.hay) {
    // Regla 1: la ausencia va CON EL MOTIVO. El caso del par no es una falla y
    // se dice asi; cualquier otro se marca mas fuerte.
    return (
      '<div class="x-bloque">' +
      '<div class="x-tit">Atestacion del proveedor (D24)</div>' +
      '<div class="x-aviso ' +
      (v.esDelPar ? 'tibio' : v.motivoDeclarado ? 'tibio' : 'malo') +
      '"><b>no hay atestacion</b> — ' +
      escaparHtml(v.motivo) +
      '</div>' +
      (v.esDelPar
        ? '<div class="x-nota">Es lo correcto: este nodo no corrio el modelo y el 402 pago a ' +
          'la wallet del par. Firmar aca seria el artefacto que parece prueba y no lo es.</div>'
        : '') +
      '</div>'
    )
  }

  const partes = [
    '<div class="x-bloque">',
    '<div class="x-tit">Atestacion del proveedor (D24)</div>'
  ]

  // Regla 2: el mock se ve, arriba de todo y no en una nota al pie.
  if (v.esMock) {
    partes.push(
      '<div class="x-aviso malo"><b>runtime: mock</b> — ' + escaparHtml(v.avisoMock) + '</div>'
    )
  }

  partes.push(filaDato('modelo', v.modelId === null ? 'no declarado' : v.modelId, 'mono'))
  partes.push(filaDato('runtime', v.runtime, v.esMock ? 'mono malo' : 'mono'))
  partes.push(filaDato('cuantizacion', v.quantization, 'mono'))
  partes.push('<div class="x-nota">' + escaparHtml(v.declarados) + '</div>')
  partes.push(filaDato('termino', v.finishReason + ' — ' + v.finishTexto))
  partes.push(
    '<div class="x-fila"><span class="x-k">tokens</span><span class="x-v">' +
      htmlDeConteo(v.conteo) +
      '</span></div>'
  )
  partes.push(filaDato('requestId', v.requestId, 'mono'))
  partes.push(filaDato('nonce', v.nonce, 'mono'))
  partes.push(filaDato('firmada por', v.providerPubkey, 'mono'))

  // Los hashes: el corazon de D24. Cada uno dice si se recomputo y contra que.
  for (let i = 0; i < v.hashes.length; i++) {
    const h = v.hashes[i]
    partes.push(filaDato(h.campo, h.declarado === null ? '—' : h.declarado, 'mono'))
    partes.push(
      '<div class="x-aviso ' +
        (h.estado === 'coincide' ? 'bueno' : h.estado === 'no-coincide' ? 'malo' : 'tibio') +
        '">' +
        escaparHtml(h.texto) +
        (h.estado === 'no-coincide' ? ' — recomputado: ' + escaparHtml(h.calculado) : '') +
        '</div>'
    )
  }

  partes.push(filaDato('firma', v.signature, 'mono'))
  partes.push('<div class="x-aviso tibio">' + escaparHtml(v.avisoFirma) + '</div>')
  partes.push(
    '<details class="x-det"><summary>los bytes que se firmaron (JCS sin el campo signature)</summary>' +
      '<pre class="x-pre">' +
      escaparHtml(v.firmadoSobre) +
      '</pre></details>'
  )
  partes.push('</div>')
  return partes.join('')
}

// El mismo recibo llega con DOS formas y las dos hay que aceptar, porque las
// dos las emite el gateway hoy:
//
//   - evento SSE final: el recibo de liquidacion cuelga de `paymentResponse`,
//     con `x402Note` explicando por que no vino en el header (D12);
//   - `GET /v1/receipts/:id`: el mismo recibo va APLANADO en la raiz, que es la
//     forma que ya leen los clientes y el test.
//
// La atestacion, en las dos, va al lado y en su propia clave.
export function liquidacionDe(recibo) {
  const r = recibo || {}
  return r.paymentResponse ? r.paymentResponse : r
}

// El recibo entero: liquidacion y atestacion UNA AL LADO DE LA OTRA, porque
// prueban mitades distintas del mismo intercambio -- el recibo, que alguien
// pago; la atestacion, que este nodo entrego esto -- y separarlas deja a cada
// una pareciendo la prueba completa.
export function htmlDeRecibo(recibo, contexto) {
  return (
    '<div class="x402 x-par">' +
    htmlDeLiquidacion(vistaDeLiquidacion(liquidacionDe(recibo))) +
    htmlDeAtestacion(vistaDeAtestacion(recibo, contexto)) +
    '</div>'
  )
}

// -----------------------------------------------------------------------------
// LO QUE VIAJA AL NAVEGADOR
// -----------------------------------------------------------------------------
//
// El panel corre EXACTAMENTE estas funciones: se serializan con `String(fn)` y
// se pegan adentro del `<script>` de cada pagina. No es un truco de empaquetado
// -- es lo que hace que el test y el panel no puedan divergir, que es todo el
// motivo por el que este archivo esta separado de pages.mjs.
//
// `bare-pack` no minifica (no tiene minificador entre sus dependencias, se
// miro), asi que el texto que sale de `String(fn)` adentro del binario
// standalone es el mismo que en el arbol.
//
// Los NOMBRES salen de las claves de este objeto y NO de `fn.name`: si algun dia
// entra un minificador, `fn.name` se mangla y las claves literales no.
//
// El orden es el de dependencia: cada funcion solo puede llamar a las que ya se
// declararon arriba, mas las constantes de `CONSTANTES_EMBEBIDAS`.
const CONSTANTES_EMBEBIDAS =
  'var MASCARA64 = ' +
  MASCARA64 +
  'n;\n' +
  'var IV = [' +
  IV.map(function (x) {
    return x + 'n'
  }).join(',') +
  '];\n' +
  'var SIGMA = ' +
  JSON.stringify(SIGMA) +
  ';\n' +
  'var REDES = ' +
  JSON.stringify(REDES) +
  ';\n'

const FUNCIONES_EMBEBIDAS = {
  bytesUtf8,
  rotarDerecha64,
  comprimir,
  blake2b256Hex,
  hashDeTexto,
  canonicalizarJCS,
  hashDeMensajes,
  bytesFirmados,
  etiquetaDeRed,
  vistaDeDesafio,
  vistaDeLiquidacion,
  comparacionDeHash,
  textoDeFinishReason,
  vistaDeConteo,
  vistaDeAtestacion,
  textoDeCostoEstimado,
  escaparHtml,
  filaDato,
  htmlDeDesafio,
  htmlDeConteo,
  htmlDeLiquidacion,
  htmlDeAtestacion,
  liquidacionDe,
  htmlDeRecibo
}

export const FUENTE_EMBEBIDA =
  '// ---- qvac/panel-x402.mjs, embebido tal cual: ver la nota de ese archivo ----\n' +
  CONSTANTES_EMBEBIDAS +
  Object.keys(FUNCIONES_EMBEBIDAS)
    .map(function (n) {
      return 'var ' + n + ' = ' + String(FUNCIONES_EMBEBIDAS[n]) + ';'
    })
    .join('\n\n') +
  '\n'
