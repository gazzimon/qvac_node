// A swarm double for testing `qvac/task/v0` without Hyperswarm, the DHT or a
// real socket — just the three methods coordinator.mjs and task-accept.mjs
// actually use: `addTaskListener`, `sendTask`, `peers`. Real drive replication
// over a real (non-DHT) connection is proven separately in
// test/context-drive-test.mjs; this is for the message protocol and the loop
// around it.

export class FakeSwarm {
  constructor(key, manifest) {
    this.key = key
    this.manifest = manifest
    this.peers = new Map() // peerKey -> { manifest }
    this._remotes = new Map() // peerKey -> FakeSwarm
    this._listeners = new Set()
  }

  static connect(a, b) {
    a.peers.set(b.key, { manifest: b.manifest })
    b.peers.set(a.key, { manifest: a.manifest })
    a._remotes.set(b.key, b)
    b._remotes.set(a.key, a)
  }

  addTaskListener(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  sendTask(peerKey, msg) {
    const remote = this._remotes.get(peerKey)
    if (!remote) return false
    // Async on purpose — a real socket write is never synchronous with the
    // handler on the other end, and code that accidentally depends on
    // same-tick delivery should fail here too.
    Promise.resolve().then(() => remote._receive(this.key, msg))
    return true
  }

  _receive(fromKey, msg) {
    const peer = { key: fromKey, manifest: this.peers.get(fromKey)?.manifest }
    const reply = (out) => this.sendTask(fromKey, out)
    for (const fn of this._listeners) fn(peer, msg, reply)
  }
}
