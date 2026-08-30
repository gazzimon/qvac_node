// A persistent Ed25519 identity for a plain-Node process that joins the
// marketplace swarm — the coordinator CLI and worker/serve-tasks.mjs both need
// one. Same shape and same reasoning as qvac/identity.mjs (the seed is what's
// saved, not the full keypair; an unreadable or missing file gets a fresh one
// rather than killing the process), rewritten on plain `fs` because this code
// runs under Node, never under Bare — see the header of worker/serve-tasks.mjs
// for why that split exists.

import fs from 'fs'
import path from 'path'
import crypto from 'hypercore-crypto'

export function loadOrCreateIdentity(dir) {
  const file = path.join(dir, 'identity.json')

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof raw.seed === 'string' && raw.seed.length === 64) {
      return { ...crypto.keyPair(Buffer.from(raw.seed, 'hex')), file, created: false }
    }
    console.error(`[identity] ${file} unreadable, generating a new one`)
  } catch {
    // Does not exist yet: first run.
  }

  const seed = crypto.randomBytes(32)
  const keyPair = crypto.keyPair(seed)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ seed: seed.toString('hex') }, null, 2))
  } catch (err) {
    console.error(`[identity] could not save identity: ${(err && err.message) || err}`)
    console.error('[identity] running with an EPHEMERAL key (changes on restart)')
    return { ...keyPair, file: null, created: true }
  }
  return { ...keyPair, file, created: true }
}
