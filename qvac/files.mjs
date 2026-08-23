// Transferencia de archivos entre maquinas, sobre Hyperdrive.
//
// POR QUE NO ALCANZA EL CANAL QUE YA HAY
//
// El canal de control (channel.mjs) transporta JSON y esta capado en 16 MiB
// por frame, y `Provider._validate` corta el contenido de un mensaje en 32000
// caracteres. Los nodos verticales del catalogo -"Facturas AR", "Lectura de
// planos"- no pueden trabajar asi: un PDF escaneado o un plano no entra, y
// meterlo en base64 adentro de un mensaje de control seria mandar 30 MB por el
// mismo canal donde viajan los tokens del streaming.
//
// Hyperdrive es el canal correcto. Un drive es un Hyperbee de metadata
// (ruta -> puntero al blob) mas un Hyperblobs con los bytes. De ahi salen las
// dos propiedades que importan:
//
//   - DESCARGA SPARSE POR RUTA. El drive puede tener 40 GB y el otro lado baja
//     solo el archivo que pidio. No hay "sincronizar la carpeta".
//   - INTEGRIDAD POR BLOQUE. Cada bloque se verifica contra el merkle root del
//     core al llegar. Un archivo corrupto o alterado a mitad de camino no
//     puede completarse. Esto lo da Hypercore, no lo agrega este modulo.
//
// LO QUE LA CLAVE **NO** PRUEBA
//
// Que los bytes correspondan a la clave esta garantizado. Que la clave sea de
// quien vos crees, NO: eso lo tiene que atar quien la recibe. Cuando la clave
// llega por `files:announce` viene por el canal Noise autenticado, asi que es
// atribuible al par -- pero no esta firmada por el manifiesto (el schema v0
// tiene `additionalProperties: false` y no hay campo donde ponerla). Cuando la
// clave llega por un link pegado a mano, la confianza es la del canal por el
// que te lo pasaron.
//
// UN DRIVE NO ES STORE-AND-FORWARD. Hypercore no guarda copias en un servidor:
// el que manda tiene que estar online mientras el otro baja, o tiene que haber
// un tercer par que ya tenga esos bloques y los este seedeando. Por eso
// `qvac-node send` se queda corriendo en vez de terminar.

import Hyperdrive from 'hyperdrive'
import fs from 'bare-fs'
import path from 'bare-path'

export const LINK_SCHEME = 'qvac://'

// Un link es `qvac://<clave hex de 64>/<ruta>`. La ruta va en el link y no
// aparte porque un archivo sin su drive no se puede pedir, y un drive sin ruta
// no dice que bajar: las dos mitades no sirven separadas.
export function formatLink(keyHex, filePath = '/') {
  const p = filePath.startsWith('/') ? filePath : '/' + filePath
  return LINK_SCHEME + keyHex + p
}

export function parseLink(link) {
  if (typeof link !== 'string' || !link.startsWith(LINK_SCHEME)) {
    throw new Error('un link de QVAC empieza con ' + LINK_SCHEME + ' (recibido: ' + link + ')')
  }
  const rest = link.slice(LINK_SCHEME.length)
  const slash = rest.indexOf('/')
  const keyHex = slash === -1 ? rest : rest.slice(0, slash)
  const filePath = slash === -1 ? '/' : rest.slice(slash)

  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error('la clave del link no es hex de 32 bytes: ' + keyHex.slice(0, 16) + '…')
  }
  return { keyHex, path: filePath }
}

// Normaliza a la forma que usa Hyperdrive: siempre absoluta, siempre con '/'.
// En Windows `path.join` mete backslashes y el drive las guardaria como parte
// del nombre -- el archivo se sube como "\carpeta\x.pdf" y del otro lado no lo
// encuentra nadie.
export function drivePath(p) {
  const norm = String(p).replace(/\\/g, '/').replace(/\/+/g, '/')
  return norm.startsWith('/') ? norm : '/' + norm
}

export class Files {
  constructor(corestore, { swarm = null } = {}) {
    // Namespace propio: el drive tiene que ser un par de cores distinto del
    // directorio, si no comparten clave y anunciar uno anunciaria el otro.
    this.drive = new Hyperdrive(corestore.namespace('files'))
    this.corestore = corestore
    this.swarm = swarm
    this.opened = false

    // Drives remotos ya abiertos, por clave hex. Se cachean porque abrir el
    // mismo drive dos veces crea dos sesiones sobre los mismos cores.
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

  // Anuncia el drive propio en su PROPIO topic (la discoveryKey del drive), no
  // en el topic del marketplace. Asi `qvac-node fetch` puede bajar un archivo
  // de una maquina sin que ninguna de las dos entre al marketplace: el que
  // recibe se une al topic del drive, y solo a ese.
  async serve() {
    if (!this.swarm) throw new Error('Files.serve() necesita un swarm')
    await this.ready()
    if (this._discovery) return this._discovery

    this._discovery = this.swarm.join(this.drive.discoveryKey, { server: true, client: false })
    await this._discovery.flushed()
    return this._discovery
  }

  // -------------------------------------------------------------------------
  // Publicar
  // -------------------------------------------------------------------------

  // Copia un archivo del disco al drive, por streaming. No se lee entero a
  // memoria a proposito: el caso de uso son planos y PDFs escaneados, y un
  // `readFileSync` de 200 MB adentro de un nodo que esta sirviendo tokens es
  // una pausa de GC en el medio de un streaming.
  async share(localPath, name = null) {
    await this.ready()

    const stat = await fs.promises.stat(localPath)
    if (!stat.isFile()) {
      throw new Error(localPath + ' no es un archivo (las carpetas van con shareDir)')
    }

    const target = drivePath(name || path.basename(localPath))

    await pipe(fs.createReadStream(localPath), this.drive.createWriteStream(target))

    return { path: target, bytes: stat.size, link: formatLink(this.keyHex, target) }
  }

  // Una carpeta entera, recursiva. Cada archivo entra como una entrada propia,
  // que es lo que permite que el otro lado baje uno solo.
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

  // Lo publicado por ESTE nodo.
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
  // Bajar
  // -------------------------------------------------------------------------

  // Abre un drive remoto de solo lectura. El corestore ya replica sobre los
  // sockets abiertos, asi que no hay que conectarse de nuevo: la peticion sale
  // por la discoveryKey del drive y contesta cualquier par conectado que lo
  // tenga (ver `ondiscoverykey` en corestore.replicate).
  async remote(keyHex) {
    if (this._remotes.has(keyHex)) return this._remotes.get(keyHex)

    const drive = new Hyperdrive(this.corestore, Buffer.from(keyHex, 'hex'))
    await drive.ready()
    this._remotes.set(keyHex, drive)

    // Si hay swarm, se busca activamente a quien lo tenga. Sin esto un drive
    // cuya clave llego por un link no tiene por donde aparecer.
    if (this.swarm) {
      this.swarm.join(drive.discoveryKey, { server: false, client: true })
    }

    return drive
  }

  // Sincroniza la METADATA de un drive remoto antes de leerlo. Es obligatorio
  // y no una optimizacion:
  //
  //   Un core recien abierto tiene `length === 0` localmente. Hyperbee, sobre
  //   un core de largo cero, contesta `null` a cualquier get -- EN EL ACTO y
  //   sin error. Sin este update, pedir un archivo que existe perfectamente
  //   del otro lado devuelve "el drive no tiene esa ruta": un falso negativo
  //   que se ve igual que un link mal escrito.
  //
  // `findingPeers` es lo que hace que `update({ wait: true })` espere a que
  // aparezca alguien en vez de resolver de una contra cero pares.
  async _syncRemote(drive, timeoutMs) {
    const done = drive.findingPeers()
    if (this.swarm) this.swarm.flush().then(done, done)
    else done()

    try {
      await withTimeout(
        drive.update({ wait: true }),
        timeoutMs,
        'no aparecio ningun par con ese drive en ' + Math.round(timeoutMs / 1000) + 's'
      )
    } finally {
      done()
    }

    if (drive.core.length === 0) {
      throw new Error('el drive existe pero esta vacio (o nadie contesto todavia)')
    }
  }

  // Baja UN archivo a disco. Devuelve los bytes escritos.
  //
  // `timeoutMs` no es un lujo: si nadie tiene esos bloques -- porque el que
  // mando el link se fue -- el stream no falla, se queda esperando para
  // siempre. Un CLI que cuelga sin decir nada es peor que uno que falla.
  async pull(keyHex, filePath, destPath, { onProgress = null, timeoutMs = 60000 } = {}) {
    const drive = await this.remote(keyHex)
    const src = drivePath(filePath)

    await this._syncRemote(drive, timeoutMs)

    const entry = await drive.entry(src)
    if (!entry) throw new Error('el drive no tiene "' + src + '"')

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

  // Baja una carpeta entera del drive remoto al disco.
  async pullDir(keyHex, folder, destDir, { onFile = null, timeoutMs = 60000 } = {}) {
    const drive = await this.remote(keyHex)
    const base = drivePath(folder)

    await this._syncRemote(drive, timeoutMs)

    const entradas = await collect(drive.list(base, { recursive: true }))
    if (entradas.length === 0) throw new Error('el drive no tiene nada bajo "' + base + '"')

    const escritos = []
    for (const entry of entradas) {
      // La ruta relativa a la carpeta pedida, para no recrear todo el arbol
      // del drive adentro del destino.
      const rel = entry.key.slice(base.length).replace(/^\//, '')
      const dest = path.join(destDir, ...rel.split('/'))
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await pipe(drive.createReadStream(entry.key), fs.createWriteStream(dest))
      escritos.push(dest)
      if (onFile) onFile({ path: entry.key, dest })
    }
    return escritos
  }

  // Lo que publica un par, sin bajarlo. El panel lo usa para poder listar los
  // archivos de un nodo remoto antes de que nadie pida nada.
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
