// File transfer between machines, over Hyperdrive.
//
// WHY THE EXISTING CHANNEL ISN'T ENOUGH
//
// The control channel (channel.mjs) carries JSON and is capped at 16 MiB per
// frame, and `Provider._validate` cuts a message's content off at 32000
// characters. The catalog's vertical nodes -"Facturas AR", "Lectura de
// planos"- can't work like that: a scanned PDF or a blueprint doesn't fit,
// and stuffing it as base64 inside a control message would mean sending 30 MB
// over the same channel where the streaming tokens travel.
//
// Hyperdrive is the right channel. A drive is a metadata Hyperbee (path ->
// pointer to blob) plus a Hyperblobs with the bytes. That gives it the two
// properties that matter:
//
//   - SPARSE DOWNLOAD BY PATH. The drive can be 40 GB and the other side only
//     downloads the file it asked for. There's no "sync the whole folder".
//   - PER-BLOCK INTEGRITY. Each block gets verified against the core's merkle
//     root on arrival. A file corrupted or altered midway can't complete.
//     This comes from Hypercore, this module doesn't add it.
//
// WHAT THE KEY DOES **NOT** PROVE
//
// That the bytes match the key is guaranteed. That the key belongs to who you
// think it does, is NOT: whoever receives it has to tie that down themselves.
// When the key arrives via `files:announce` it comes over the authenticated
// Noise channel, so it's attributable to the peer -- but it isn't signed by
// the manifest (the v0 schema has `additionalProperties: false` and there's
// no field to put it in). When the key arrives via a link pasted by hand, the
// trust is whatever the channel it was passed through gives you.
//
// A DRIVE IS NOT STORE-AND-FORWARD. Hypercore doesn't keep copies on a
// server: whoever's sending has to be online while the other side downloads,
// or there has to be a third peer that already has those blocks and is
// seeding them. That's why `qvac-node send` stays running instead of exiting.

import Hyperdrive from 'hyperdrive'
import fs from 'bare-fs'
import path from 'bare-path'

export const LINK_SCHEME = 'qvac://'

// A link is `qvac://<64-char hex key>/<path>`. The path lives in the link and
// not separately because a file without its drive can't be requested, and a
// drive without a path doesn't say what to download: the two halves are
// useless apart.
export function formatLink(keyHex, filePath = '/') {
  const p = filePath.startsWith('/') ? filePath : '/' + filePath
  return LINK_SCHEME + keyHex + p
}

export function parseLink(link) {
  if (typeof link !== 'string' || !link.startsWith(LINK_SCHEME)) {
    throw new Error('a QVAC link starts with ' + LINK_SCHEME + ' (got: ' + link + ')')
  }
  const rest = link.slice(LINK_SCHEME.length)
  const slash = rest.indexOf('/')
  const keyHex = slash === -1 ? rest : rest.slice(0, slash)
  const filePath = slash === -1 ? '/' : rest.slice(slash)

  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error('the link key is not 32-byte hex: ' + keyHex.slice(0, 16) + '…')
  }
  return { keyHex, path: filePath }
}

// Normalizes to the form Hyperdrive uses: always absolute, always with '/'.
// On Windows `path.join` inserts backslashes and the drive would store them
// as part of the name -- the file gets uploaded as "\folder\x.pdf" and nobody
// on the other end can find it.
export function drivePath(p) {
  const norm = String(p).replace(/\\/g, '/').replace(/\/+/g, '/')
  return norm.startsWith('/') ? norm : '/' + norm
}

export class Files {
  constructor(corestore, { swarm = null, dir = null } = {}) {
    // Own namespace: the drive has to be a different pair of cores from the
    // directory, otherwise they'd share a key and announcing one would
    // announce the other.
    this.drive = new Hyperdrive(corestore.namespace('files'))
    this.corestore = corestore
    this.swarm = swarm
    this.dir = dir
    this.opened = false

    // Already-opened remote drives, by hex key. Cached because opening the
    // same drive twice creates two sessions over the same cores.
    this._remotes = new Map()
    this._discovery = null
  }

  async ready() {
    if (this.opened) return this
    await this.drive.ready()
    this.opened = true
    return this
  }

  get key() {
    return this.drive.key
  }

  get keyHex() {
    return this.drive.key.toString('hex')
  }

  get version() {
    return this.drive.version
  }

  // Announces its own drive on its OWN topic (the drive's discoveryKey), not
  // on the marketplace topic. That way `qvac-node fetch` can download a file
  // from a machine without either of them joining the marketplace: the
  // receiver joins the drive's topic, and only that one.
  async serve() {
    if (!this.swarm) throw new Error('Files.serve() needs a swarm')
    await this.ready()
    if (this._discovery) return this._discovery

    this._discovery = this.swarm.join(this.drive.discoveryKey, { server: true, client: false })
    await this._discovery.flushed()
    return this._discovery
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  // Copies a file from disk to the drive, by streaming. Deliberately not read
  // whole into memory: the use case is blueprints and scanned PDFs, and a
  // 200 MB `readFileSync` inside a node that's serving tokens is a GC pause
  // in the middle of a stream.
  async share(localPath, name = null) {
    await this.ready()

    const stat = await fs.promises.stat(localPath)
    if (!stat.isFile()) {
      throw new Error(localPath + ' is not a file (folders go through shareDir)')
    }

    const target = drivePath(name || path.basename(localPath))

    await pipe(fs.createReadStream(localPath), this.drive.createWriteStream(target))

    return { path: target, bytes: stat.size, link: formatLink(this.keyHex, target) }
  }

  // A whole folder, recursively. Each file becomes its own entry, which is
  // what lets the other side download just one.
  async shareDir(localDir, prefix = null) {
    await this.ready()

    const base = drivePath(prefix || path.basename(localDir))
    const subidos = []

    const walk = async (dir, rel) => {
      for (const entry of await fs.promises.readdir(dir)) {
        const full = path.join(dir, entry)
        const stat = await fs.promises.stat(full)
        if (stat.isDirectory()) {
          await walk(full, rel + '/' + entry)
          continue
        }
        const target = drivePath(rel + '/' + entry)
        await pipe(fs.createReadStream(full), this.drive.createWriteStream(target))
        subidos.push({ path: target, bytes: stat.size })
      }
    }

    await walk(localDir, base)
    return { base, files: subidos, link: formatLink(this.keyHex, base) }
  }

  async unshare(name) {
    await this.ready()
    await this.drive.del(drivePath(name))
  }

  // What THIS node has published.
  async list(folder = '/') {
    await this.ready()
    const out = []
    for await (const entry of this.drive.list(drivePath(folder), { recursive: true })) {
      out.push({
        path: entry.key,
        bytes: entry.value && entry.value.blob ? entry.value.blob.byteLength : 0,
        link: formatLink(this.keyHex, entry.key)
      })
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  // Opens a remote read-only drive. The corestore already replicates over the
  // open sockets, so there's no need to reconnect: the request goes out over
  // the drive's discoveryKey and any connected peer that has it answers (see
  // `ondiscoverykey` in corestore.replicate).
  async remote(keyHex) {
    if (this._remotes.has(keyHex)) return this._remotes.get(keyHex)

    const drive = new Hyperdrive(this.corestore, Buffer.from(keyHex, 'hex'))
    await drive.ready()
    this._remotes.set(keyHex, drive)

    // If there's a swarm, it actively looks for whoever has it. Without this
    // a drive whose key arrived via a link has no way to show up.
    if (this.swarm) {
      this.swarm.join(drive.discoveryKey, { server: false, client: true })
    }

    return drive
  }

  // Syncs a remote drive's METADATA before reading it. This is mandatory, not
  // an optimization:
  //
  //   A freshly opened core has `length === 0` locally. Hyperbee, over a
  //   zero-length core, answers `null` to any get -- RIGHT AWAY and with no
  //   error. Without this update, requesting a file that perfectly well
  //   exists on the other side returns "the drive doesn't have that path": a
  //   false negative that looks exactly like a mistyped link.
  //
  // `findingPeers` is what makes `update({ wait: true })` wait for someone to
  // show up instead of resolving against zero peers.
  async _syncRemote(drive, timeoutMs) {
    const done = drive.findingPeers()
    if (this.swarm) this.swarm.flush().then(done, done)
    else done()

    try {
      await withTimeout(
        drive.update({ wait: true }),
        timeoutMs,
        'no peer with that drive showed up in ' + Math.round(timeoutMs / 1000) + 's'
      )
    } finally {
      done()
    }

    if (drive.core.length === 0) {
      throw new Error('the drive exists but is empty (or nobody has answered yet)')
    }
  }

  // Downloads ONE file to disk. Returns the bytes written.
  //
  // `timeoutMs` isn't a luxury: if nobody has those blocks -- because whoever
  // sent the link left -- the stream doesn't fail, it just waits forever. A
  // CLI that hangs without saying anything is worse than one that fails.
  async pull(keyHex, filePath, destPath, { onProgress = null, timeoutMs = 60000 } = {}) {
    const drive = await this.remote(keyHex)
    const src = drivePath(filePath)

    await this._syncRemote(drive, timeoutMs)

    const entry = await drive.entry(src)
    if (!entry) throw new Error('the drive does not have "' + src + '"')

    const total = entry.value && entry.value.blob ? entry.value.blob.byteLength : 0

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true })

    let bajados = 0
    const rs = drive.createReadStream(src)
    if (onProgress) {
      rs.on('data', (chunk) => {
        bajados += chunk.byteLength
        onProgress({ bytes: bajados, total, progress: total ? bajados / total : 0 })
      })
    }

    await pipe(rs, fs.createWriteStream(destPath))
    return { bytes: bajados || total, total, path: destPath }
  }

  // Downloads a whole folder from the remote drive to disk.
  async pullDir(keyHex, folder, destDir, { onFile = null, timeoutMs = 60000 } = {}) {
    const drive = await this.remote(keyHex)
    const base = drivePath(folder)

    await this._syncRemote(drive, timeoutMs)

    const entradas = await collect(drive.list(base, { recursive: true }))
    if (entradas.length === 0) throw new Error('the drive has nothing under "' + base + '"')

    const escritos = []
    for (const entry of entradas) {
      // The path relative to the requested folder, so the whole drive tree
      // doesn't get recreated inside the destination.
      const rel = entry.key.slice(base.length).replace(/^\//, '')
      const dest = path.join(destDir, ...rel.split('/'))
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await pipe(drive.createReadStream(entry.key), fs.createWriteStream(dest))
      escritos.push(dest)
      if (onFile) onFile({ path: entry.key, dest })
    }
    return escritos
  }

  // What a peer publishes, without downloading it. The panel uses this to
  // list a remote node's files before anyone requests anything.
  async listRemote(keyHex, folder = '/', { timeoutMs = 30000 } = {}) {
    const drive = await this.remote(keyHex)

    await this._syncRemote(drive, timeoutMs)

    const entradas = await collect(drive.list(drivePath(folder), { recursive: true }))
    return entradas.map((e) => ({
      path: e.key,
      bytes: e.value && e.value.blob ? e.value.blob.byteLength : 0,
      link: formatLink(keyHex, e.key)
    }))
  }

  async close() {
    for (const drive of this._remotes.values()) await drive.close()
    this._remotes.clear()
    if (this.opened) await this.drive.close()
    this.opened = false
  }
}

// ---------------------------------------------------------------------------

function pipe(rs, ws) {
  return new Promise((resolve, reject) => {
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('close', resolve)
    rs.pipe(ws)
  })
}

async function collect(stream) {
  const out = []
  for await (const item of stream) out.push(item)
  return out
}

function withTimeout(promise, ms, mensaje) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(mensaje)), ms)
    if (t.unref) t.unref()
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (err) => {
        clearTimeout(t)
        reject(err)
      }
    )
  })
}
