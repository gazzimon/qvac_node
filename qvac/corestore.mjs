// The node's Corestore: a SINGLE hypercore store for the whole process.
//
// Everything that persists or replicates (the Hyperbee directory, the file
// Hyperdrive, and whatever comes after) comes out of here. It's not a nicety:
// the store takes a RocksDB lock on its directory, and two Corestores pointing
// at the same path fail when the second one tries to open. A single opening
// point makes that error impossible.
//
// Also, a single store means a single replication per socket: when
// `swarm.mjs` does `store.replicate(socket)`, that one stream serves the
// directory AND the drives, multiplexed by Protomux alongside the chat
// channel. See the note in channel.mjs about why opening order matters.

import Corestore from 'corestore'
import path from 'bare-path'

let store = null
let opening = null

export function corestoreDir(dir) {
  return path.join(dir, 'corestore')
}

// Idempotent AND safe against concurrency: two simultaneous calls before the
// first finishes opening have to return the SAME store, not two. With an
// `await` in the middle, a plain `if (store)` isn't enough.
export async function openStore(dir) {
  if (store) return store
  if (opening) return opening

  // The promise is saved in `opening` BEFORE the first await: if it were
  // saved after, two concurrent calls would build two Corestores on the same
  // path and the second would die against the RocksDB lock.
  opening = (async () => {
    const s = new Corestore(corestoreDir(dir))
    try {
      await s.ready()
    } catch (err) {
      opening = null
      throw err
    }
    store = s
    opening = null
    return s
  })()

  return await opening
}

// For paths that already know it's open (no await needed).
export function getStore() {
  return store
}

export async function closeStore() {
  const s = store
  store = null
  opening = null
  if (s) await s.close()
}
