// The node's persistent identity: the Ed25519 keypair it signs its manifest
// with and presents itself to the swarm with (they're the same key, see the
// note on verifyManifest in manifest.mjs).
//
// It's persisted because a new key on every boot means the node is a
// different stranger every time: nobody can recognize it across sessions and
// the pitch's word "verifiable" loses its subject. What gets verified is that
// THIS node, the usual one, signed what it says it did.

import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'

// The 32-byte SEED is saved, not the whole keypair: the pair is derived from
// it, and saving the full private key would be saving twice the sensitive
// material for nothing.
export function loadOrCreateIdentity(dir) {
  const file = path.join(dir, 'identity.json')

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof raw.seed === 'string' && raw.seed.length === 64) {
      return { ...crypto.keyPair(Buffer.from(raw.seed, 'hex')), file, created: false }
    }
    // The file exists but is unusable. This is reported and a new one gets
    // generated instead of dying: a node with an unreadable identity can
    // still work, and killing the process over this would leave the demo
    // dead for no reason.
    console.error(`[identity] ${file} unreadable, generating a new identity`)
  } catch {
    // Doesn't exist yet: first boot.
  }

  const seed = crypto.randomBytes(32)
  const keyPair = crypto.keyPair(seed)

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ seed: seed.toString('hex') }, null, 2))
  } catch (err) {
    // If it can't be written, the node keeps running with an ephemeral
    // identity. Said out loud: it changes the meaning of what gets verified.
    console.error(`[identity] could not save the identity: ${(err && err.message) || err}`)
    console.error('[identity] the node is running with an EPHEMERAL key (changes on restart)')
    return { ...keyPair, file: null, created: true }
  }

  return { ...keyPair, file, created: true }
}
