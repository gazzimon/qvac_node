// Node manifest: what models it serves, at what price, and the signature that
// proves the owner of that key said so. ROADMAP Phase 2-a.
//
// Doesn't touch the network or disk: an object goes in, an object comes out.
// Everything it does can be tested without two machines (see test/index.js),
// which is exactly why this piece comes first.
//
// SIGNATURE: Ed25519 over the canonical JCS form (RFC 8785) of the manifest
// without the `signature` field. JCS instead of plain `JSON.stringify` because
// the key order of a JS object isn't stable across implementations or
// versions: two nodes serializing the SAME manifest in a different order
// produce different bytes, and the other one's signature never verifies. With
// JCS the bytes are a function of the content, not of the order the object
// was built in.

import crypto from 'hypercore-crypto'

export const SCHEMA_VERSION = 0
// 0.2.0: the transport moves from FramedStream to a Protomux channel,
// `files:announce` is added, and `directory` stops being a mock. schemaVersion
// does NOT change -- the shape of the manifest is the same, what changed is
// the protocol that carries it and the content of a field that used to be
// filler.
export const PROTOCOL_VERSION = '0.2.0'

// ---------------------------------------------------------------------------
// JCS — RFC 8785
// ---------------------------------------------------------------------------

// Canonical serialization: sorted keys, no spaces, numbers in ECMAScript
// form. `JSON.stringify` of a primitive already satisfies the RFC for
// strings and finite numbers; what the RFC adds is the key order and the
// ban on NaN/Infinity, which is what's implemented here.
export function canonicalize(value) {
  if (value === null) return 'null'

  const t = typeof value

  if (t === 'boolean') return value ? 'true' : 'false'

  if (t === 'number') {
    // JSON has no way to represent these, and `JSON.stringify` silently turns
    // them into `null`: a manifest with a NaN price would be signed as if the
    // price were null and would verify just fine. Better to bail out.
    if (!Number.isFinite(value)) {
      throw new Error(`JCS: non-finite number (${value}), cannot canonicalize`)
    }
    return JSON.stringify(value)
  }

  if (t === 'string') return JSON.stringify(value)

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }

  if (t === 'object') {
    // The RFC sorts by the UTF-16 code units of the key, which is exactly
    // what JS's default `sort()` does on strings.
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined) // `undefined` doesn't exist in JSON
      .sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }

  throw new Error(`JCS: non-serializable type (${t})`)
}

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

// The node's identity IS its swarm keypair: the same `publicKey` that shows
// up in the manifest is the one Hyperswarm announces. Without that, the
// signature would prove "someone with this key wrote this" but not "the peer
// I'm talking to wrote this" (see the note on verifyManifest).
export function createIdentity(seed) {
  return crypto.keyPair(seed)
}

function isHex(s, bytes) {
  return typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s)
}

// ---------------------------------------------------------------------------
// Armado
// ---------------------------------------------------------------------------

// `economic` STOPPED BEING A MOCK once the node has a wallet (Phase 7).
//
// Up through Phase 7 this block was a fixed value with the zero address,
// flagged with `_mock` here, in the README, and in the manifest itself. Now,
// once the node opens its wallet, what gets signed is the REAL payout address
// that WDK returned -- built by `wallet.economicDe()`, which is also the one
// that knows about chains and settlement (D15).
//
// The mock STAYS, and not for convenience: there are legitimate paths without
// a wallet that still need to be able to announce themselves. A node that
// only consumes, one that hasn't created its wallet yet, `peers` without
// storage, and the manifest tests, which have no reason to load a wallet
// stack just to test a signature.
//
// What CANNOT happen is the two cases looking the same. That's why the mock
// stays flagged: if someone opens the manifest and sees a wallet with
// apparently real money and no disclaimer, that reading is worse than if the
// field simply weren't there.
const ECONOMIC_MOCK = {
  _mock: 'NO WALLET — this node has not declared a payout address. See ROADMAP Phase 7.',
  walletAddress: '0x0000000000000000000000000000000000000000',
  chains: ['ethereum-sepolia'],
  settlement: 'batch-receipts'
}

// Its shape is validated before signing, for the same reason as
// `directorySection`: a badly built `economic` that's SIGNED is worse than
// none at all. A consumer verifies it fine, sends money to whatever it says,
// and the error shows up after the payment already happened.
//
// The pattern comes from the frozen schema (manifest-v0.json:84) and supports
// the two families the stack handles: EVM and Tron. It's checked here the
// same as there because this is the last point before the signature.
function economicSection(economic) {
  if (!economic) return ECONOMIC_MOCK

  const { walletAddress, chains, settlement } = economic
  const evm = /^0x[a-fA-F0-9]{40}$/.test(String(walletAddress || ''))
  const tron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(walletAddress || ''))
  if (!evm && !tron) {
    throw new Error('buildManifest: economic.walletAddress is neither an EVM nor a Tron address')
  }
  // The zero address passes the pattern and isn't a real address: it's the
  // value the mock used. Signing it would mean sending payment into a pit.
  if (/^0x0{40}$/.test(String(walletAddress))) {
    throw new Error('buildManifest: economic.walletAddress is the zero address')
  }
  if (!Array.isArray(chains) || chains.length === 0) {
    throw new Error('buildManifest: economic.chains needs at least one network')
  }
  for (const c of chains) {
    if (typeof c !== 'string' || !/^[a-z0-9-]{3,40}$/.test(c)) {
      throw new Error('buildManifest: economic.chains has an invalid identifier: ' + c)
    }
  }
  if (!['prepaid-balance', 'batch-receipts', 'onchain-per-job'].includes(settlement)) {
    throw new Error('buildManifest: economic.settlement is not one of the schema values')
  }

  return { walletAddress, chains: [...chains], settlement }
}

// The directory STOPPED being a mock once the node opens its Hyperbee: the
// key signed here is the one the peer uses to replicate it (see
// directory.mjs). The mock stays for the paths that don't mount storage --
// `peers` without storage, and the manifest tests, which have no reason to
// open a disk.
const DIRECTORY_MOCK = {
  _mock: 'NOT IMPLEMENTED — fixed values to validate the schema. See ROADMAP D2.',
  writerPublicKey: '00'.repeat(32),
  discoveryKey: '00'.repeat(32),
  sequence: 0
}

// Its shape is validated before signing. A badly built descriptor that's
// signed is worse than none: the peer verifies it fine, tries to replicate a
// key that doesn't exist, and the error shows up three hops from where it
// originated.
function directorySection(directory) {
  if (!directory) return DIRECTORY_MOCK

  const { writerPublicKey, discoveryKey, sequence } = directory
  if (!isHex(writerPublicKey, 32) || !isHex(discoveryKey, 32)) {
    throw new Error('buildManifest: the directory needs 32-byte hex keys')
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error('buildManifest: directory.sequence must be an integer >= 0')
  }

  return { writerPublicKey, discoveryKey, sequence }
}

// An UNSIGNED manifest. `signManifest` is the only place that adds
// `signature`, so there's no path where a manifest gets built and sent
// without going through the signature.
export function buildManifest({
  publicKey,
  models = [],
  operator = 'QVAC Node',
  tags = [],
  region = 'sa-east',
  directory = null,
  // The payout address for THIS node, or null if it doesn't have a wallet yet.
  // Built by wallet.economicDe(); here it's only validated and signed.
  economic = null,
  ttlMs = 24 * 60 * 60 * 1000,
  now = Date.now()
}) {
  const hex = Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : publicKey
  if (!isHex(hex, 32)) {
    throw new Error('buildManifest: publicKey must be 32 bytes (64-char hex)')
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('buildManifest: at least one model is required')
  }

  for (const m of models) {
    if (!m || typeof m.modelId !== 'string' || m.modelId === '') {
      throw new Error('buildManifest: every model needs a modelId')
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    publishedAt: now,
    expiresAt: now + ttlMs,
    node: {
      hyperswarmPublicKey: hex,
      // D1 decided the transport is FramedStream over the Hyperswarm
      // connection, NOT HTTP: there's no baseUrl to point at. The field stays
      // for schema compatibility with `openaiCompatible: false` so nobody
      // tries to hit a port that doesn't exist on the other machine.
      endpoint: { baseUrl: '', openaiCompatible: false },
      region
    },
    economic: economicSection(economic),
    models: models.map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName || m.modelId,
      capabilities: {
        streaming: m.streaming !== false,
        tools: false,
        structuredOutput: ['text']
      },
      qos: {
        maxConcurrentRequests: Number.isFinite(m.maxConcurrentRequests)
          ? m.maxConcurrentRequests
          : 4
      },
      pricing: m.pricing || []
    })),
    security: {
      toolCallPolicy: 'allowlist',
      allowedTools: [],
      maxToolCallsPerRequest: 0
    },
    directory: directorySection(directory),
    metadata: { operator, tags }
  }
}

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

// The bytes that get signed: the canonicalized manifest WITHOUT `signature`.
// The same function is used when signing and when verifying, so they can't
// diverge.
function signedBytes(manifest) {
  const { signature, ...rest } = manifest // eslint-disable-line no-unused-vars
  return Buffer.from(canonicalize(rest), 'utf8')
}

export function signManifest(manifest, secretKey) {
  const sig = crypto.sign(signedBytes(manifest), secretKey)
  return { ...manifest, signature: sig.toString('hex') }
}

// Returns `{ ok, reason }` instead of throwing or returning a bare boolean:
// on the swarm path we need to be able to LOG why a peer's manifest was
// discarded, and "false" can't be debugged at 3am.
//
// `expectedPublicKey` is NOT optional in practice, even though the argument
// is. The signature only proves that whoever has the private key for
// `node.hyperswarmPublicKey` built the manifest — and that key is chosen by
// the manifest itself. Without tying it to the real key of the connection,
// anyone could build a manifest with THEIR key, sign it correctly, and
// announce themselves as whatever node they want: the signature verifies
// perfectly and proves nothing useful. Whoever calls this from the swarm has
// to pass the key of the peer that gave it the socket.
export function verifyManifest(manifest, { expectedPublicKey = null, now = Date.now() } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'the manifest is not an object' }
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `unknown schemaVersion ${manifest.schemaVersion}` }
  }
  if (!isHex(manifest.signature, 64)) {
    return { ok: false, reason: 'missing signature or not 64-byte hex' }
  }

  const pk = manifest.node && manifest.node.hyperswarmPublicKey
  if (!isHex(pk, 32)) {
    return { ok: false, reason: 'node.hyperswarmPublicKey missing or malformed' }
  }

  if (expectedPublicKey) {
    const expected = Buffer.isBuffer(expectedPublicKey)
      ? expectedPublicKey.toString('hex')
      : expectedPublicKey
    if (expected !== pk) {
      return {
        ok: false,
        reason: `the manifest claims to be from ${pk.slice(0, 8)}… but the connection is from ${expected.slice(0, 8)}…`
      }
    }
  }

  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    return { ok: false, reason: 'the manifest does not announce any model' }
  }

  let ok = false
  try {
    ok = crypto.verify(
      signedBytes(manifest),
      Buffer.from(manifest.signature, 'hex'),
      Buffer.from(pk, 'hex')
    )
  } catch (err) {
    return { ok: false, reason: `could not verify the signature: ${(err && err.message) || err}` }
  }

  if (!ok) return { ok: false, reason: 'the signature does not match the content' }

  // The expiration is REPORTED but doesn't invalidate on its own: D3 decided a
  // candidate lives or dies by the socket's state, not by a timestamp. It's
  // returned so it can be logged without a laptop's out-of-sync clock taking
  // down a node that's perfectly alive.
  const expired = Number.isFinite(manifest.expiresAt) && manifest.expiresAt < now

  return { ok: true, reason: null, expired, publicKey: pk }
}
