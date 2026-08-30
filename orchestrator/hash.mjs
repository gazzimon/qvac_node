// Content hashing for task results.
//
// The attestation format (`qvac/atestacion.mjs`) pegs the algorithm name to the
// value — `blake2b-256:<hex>` — so a third party knows what to recompute with,
// and the name and the value cannot drift into separate fields that fall out of
// sync. This module keeps the SAME shape (`alg:hex`) and a different algorithm:
//
//   BLAKE2b in the attestation is a Bare constraint — `sodium-native` is
//   already in that tree and runs under Bare with no dynamic import. The
//   factory runs under Node, where `node:crypto` gives SHA-256 for free and
//   with no native dependency. A verifier only needs the algorithm named; which
//   one it is does not matter across the machine boundary.

import { createHash } from 'crypto'

export const ALG = 'sha256'

// Accepts a Buffer or a string. A string is hashed as UTF-8 bytes, the same as
// what `write` puts on disk.
export function hashContent(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  return ALG + ':' + createHash(ALG).update(buf).digest('hex')
}

// True when `data` hashes to `expected`. Tolerates `expected` being a bare hex
// digest (no `alg:` prefix) so an older peer's result still verifies.
export function hashMatches(data, expected) {
  if (typeof expected !== 'string' || !expected) return false
  const actual = hashContent(data)
  if (actual === expected) return true
  const bare = expected.includes(':') ? expected.slice(expected.indexOf(':') + 1) : expected
  return actual.slice(actual.indexOf(':') + 1) === bare
}
