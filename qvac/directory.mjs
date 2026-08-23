// El directorio del marketplace: un Hyperbee sobre el Corestore del nodo.
//
// Resuelve dos cosas que hoy no existen:
//
//  1. PERSISTENCIA. `store.mjs` es un Map en memoria y se resetea en cada
//     arranque. Para una demo esta bien; para un marketplace no: sin historia
//     no hay reputacion, y sin reputacion el ruteo no puede elegir por otra
//     cosa que el orden de llegada.
//
//  2. DESCUBRIMIENTO SIN SIMULTANEIDAD. Hoy dos nodos se conocen solo si
//     estan online AL MISMO TIEMPO: el manifiesto se intercambia en el
//     handshake y muere con el socket. Este Hyperbee se replica entre pares,
//     asi que conectarse con UN par alcanza para enterarse de todos los que
//     ese par vio.
//
// POR QUE ES SEGURO RETRANSMITIR EL MANIFIESTO DE UN TERCERO
//
// El manifiesto ya viene firmado por su emisor, asi que quien lo recibe de
// rebote lo verifica igual, sin confiar en el intermediario. Lo unico que el
// intermediario puede hacer es NO pasarlo, u ofrecer uno viejo. No puede
// inventar uno.
//
// LO QUE UN MANIFIESTO DE REBOTE **NO** PRUEBA -- y hay que tenerlo claro:
//
//   `verifyManifest` ata la firma a la clave del socket (`expectedPublicKey`).
//   Un manifiesto que sale del bee no tiene socket: verificarlo contra la
//   clave que el mismo declara es una tautologia. Prueba "el dueño de K dijo
//   esto alguna vez", NO "K esta vivo ahora".
//
//   Por eso las entradas del directorio entran al registro como CONOCIDAS, no
//   como candidatas de ruteo. D3 sigue en pie sin excepciones: un candidato
//   nace y muere con su socket. El directorio es una guia telefonica, no una
//   señal de liveness.
//
// LAYOUT DE CLAVES (el orden lexicografico ES el indice: Hyperbee no tiene
// otro, y un `get` remoto baja solo los ~log(n) bloques del camino):
//
//   peer/<peerKey>              -> { manifest, firstSeen, lastSeen, sessions, filesKey }
//   model/<modelId>/<peerKey>   -> { displayName, operator, pricing, maxConcurrentRequests }
//   stat/<peerKey>              -> { requests, errors, tokens, lastMs, lastAt }
//   log/<ts padded>/<seq>       -> entrada de ruteo
//
// `model/...` es un indice secundario hecho a mano: sin el, "quien sirve
// llama1b" obliga a recorrer todos los `peer/`.

import Hyperbee from 'hyperbee'

// El log crece para siempre si nadie lo poda. El core igual conserva los
// bloques viejos (es append-only), pero la VISTA queda acotada y el arranque
// no tiene que recorrer meses de historia.
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Ancho fijo para que el orden lexicografico de la clave sea el orden
// cronologico. `String(Date.now())` ya son 13 digitos; 16 deja margen de
// sobra y evita que el dia que cambie el ancho se reordene la historia.
function tsKey(ts) {
  return String(ts).padStart(16, '0')
}

// El caracter siguiente a '/' en ASCII es '0'. `gte: 'peer/'` + `lt: 'peer0'`
// cierra el prefijo sin tener que construir una clave centinela rara.
function prefixRange(prefix, extra = {}) {
  return { gte: prefix + '/', lt: prefix + '0', ...extra }
}

export class Directory {
  constructor(corestore, { name = 'directory' } = {}) {
    this.core = corestore.get({ name })
    this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    this.opened = false
    this._seq = 0

    // Cola de una sola via. Las escrituras entran desde `store.mjs`, que es
    // sincrono y no puede esperar al disco: si cada `upsertFromManifest`
    // tuviera que await-ear un put, el handler del swarm se volveria async y
    // un disco lento frenaria el handshake. Se encolan y se olvidan.
    this._tail = Promise.resolve()
    this._errors = 0
  }

  async ready() {
    if (this.opened) return this
    await this.bee.ready()
    this.opened = true
    return this
  }

  get key() {
    return this.core.key
  }

  get keyHex() {
    return this.core.key.toString('hex')
  }

  get discoveryKeyHex() {
    return this.core.discoveryKey.toString('hex')
  }

  get version() {
    return this.bee.version
  }

  // Lo que va en el campo `directory` del manifiesto firmado. Ese campo estaba
  // mockeado (DIRECTORY_MOCK en manifest.mjs, D2 del ROADMAP): con esto pasa a
  // ser real, y el schema congelado ya tenia el lugar exacto para ponerlo.
  descriptor() {
    return {
      writerPublicKey: this.keyHex,
      discoveryKey: this.discoveryKeyHex,
      sequence: this.version
    }
  }

  // Encola una escritura. No devuelve el resultado a proposito: quien llama es
  // codigo sincrono del camino caliente y no tiene nada que hacer con el.
  _write(fn) {
    this._tail = this._tail.then(fn).catch((err) => {
      // Un directorio que no puede escribir NO tumba el nodo: sigue sirviendo
      // inferencia con el registro en memoria. Se avisa una vez cada 20 fallas
      // para no inundar la terminal si el disco esta lleno.
      if (this._errors++ % 20 === 0) {
        console.error('[directory] no se pudo escribir: ' + ((err && err.message) || err))
      }
    })
    return this._tail
  }

  // Espera a que se vacie la cola. Para tests y para el cierre prolijo.
  flush() {
    return this._tail
  }

  // -------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------

  // Un manifiesto VERIFICADO de un par. `origin` distingue de donde salio:
  // 'socket' = handshake directo contra ese par; 'gossip' = vino replicado del
  // directorio de un tercero. La distincion se guarda porque cambia lo que la
  // entrada prueba (ver la nota larga del encabezado).
  recordManifest(peerKey, manifest, { origin = 'socket', now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      const prev = found ? found.value : null

      // Una sesion nueva es una RECONEXION, no un reanuncio: el mismo par
      // reanuncia su manifiesto cada vez que se conecta, y contar cada anuncio
      // como sesion haria que el numero mida trafico en vez de presencia.
      const nuevaSesion = origin === 'socket' && (!prev || prev.lastOrigin !== 'socket')

      const entry = {
        peerKey,
        manifest,
        lastOrigin: origin,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now,
        sessions: (prev ? prev.sessions : 0) + (nuevaSesion ? 1 : 0),
        filesKey: prev ? prev.filesKey : null
      }

      const batch = this.bee.batch()
      await batch.put('peer/' + peerKey, entry)

      // El indice por modelo se RECONSTRUYE, no se agrega encima. Un par que
      // reanuncia con menos modelos -- porque descargo uno, o porque se quedo
      // sin VRAM -- dejaba su fila vieja indexada para siempre, y el panel
      // seguia diciendo que alguien sirve algo que ya nadie sirve.
      //
      // Las claves viejas salen del manifiesto anterior y no de un scan del
      // prefijo `model/`: el peerKey es el ULTIMO tramo de esa clave, asi que
      // buscar "las de este par" obligaria a recorrer el indice entero.
      const modelosViejos = (prev && prev.manifest && prev.manifest.models) || []
      for (const m of modelosViejos) await batch.del('model/' + m.modelId + '/' + peerKey)

      const operator =
        (manifest && manifest.metadata && manifest.metadata.operator) || 'Nodo remoto'
      for (const m of (manifest && manifest.models) || []) {
        await batch.put('model/' + m.modelId + '/' + peerKey, {
          peerKey,
          modelId: m.modelId,
          displayName: m.displayName || m.modelId,
          operator,
          pricing: m.pricing || [],
          maxConcurrentRequests: (m.qos && m.qos.maxConcurrentRequests) || 1,
          lastSeen: now
        })
      }
      await batch.flush()
    })
  }

  // Se llama cuando el socket de un par se cae (swarm.mjs, evento 'close').
  //
  // Sin esto, `sessions` nunca pasa de 1: `recordManifest` solo cuenta una
  // sesion nueva cuando `lastOrigin` no era ya 'socket', pero nada volvia a
  // ponerlo en otra cosa al desconectarse -- una reconexion real llegaba con
  // origin='socket' otra vez sobre un `lastOrigin` que ya era 'socket', y el
  // contador se leia como "presencia" cuando en realidad media "se anuncio
  // una vez, en toda la sesion del proceso".
  recordDisconnect(peerKey, { now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      if (!found) return
      await this.bee.put('peer/' + peerKey, { ...found.value, lastOrigin: 'disconnected', lastSeen: now })
    })
  }

  // La clave del Hyperdrive de un par. No va en el manifiesto porque el schema
  // congelado tiene `additionalProperties: false` en `node` y no hay campo
  // donde meterla sin romperlo. Llega por `files:announce`, que viaja por el
  // canal Noise ya autenticado: es atribuible al par (misma clase de confianza
  // que `node:status`), pero NO esta firmada.
  recordFilesKey(peerKey, filesKey, { now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      if (!found) return // todavia no verifico su manifiesto: no hay a que atarlo
      await this.bee.put('peer/' + peerKey, { ...found.value, filesKey, lastSeen: now })
    })
  }

  recordSeen(peerKey, { now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('peer/' + peerKey)
      if (!found) return
      await this.bee.put('peer/' + peerKey, { ...found.value, lastSeen: now })
    })
  }

  // Contadores por par. Es la materia prima de la reputacion: hoy solo se
  // acumulan. Que el ruteo los use para ordenar candidatos es otra decision
  // (D6 del ROADMAP), y no se toma aca.
  recordStat(peerKey, { ok = true, ms = null, tokens = 0, now = Date.now() } = {}) {
    return this._write(async () => {
      const found = await this.bee.get('stat/' + peerKey)
      const prev = found
        ? found.value
        : { requests: 0, errors: 0, tokens: 0, lastMs: null, lastAt: null }

      await this.bee.put('stat/' + peerKey, {
        requests: prev.requests + 1,
        errors: prev.errors + (ok ? 0 : 1),
        tokens: prev.tokens + (Number.isFinite(tokens) ? tokens : 0),
        lastMs: Number.isFinite(ms) ? ms : prev.lastMs,
        lastAt: now
      })
    })
  }

  pushLog(entry, { now = Date.now() } = {}) {
    const seq = this._seq++
    return this._write(() => this.bee.put('log/' + tsKey(now) + '/' + seq, { ts: now, ...entry }))
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async knownPeers({ limit = 200 } = {}) {
    const out = []
    for await (const { value } of this.bee.createReadStream(prefixRange('peer', { limit }))) {
      out.push(value)
    }
    return out
  }

  async peer(peerKey) {
    const found = await this.bee.get('peer/' + peerKey)
    return found ? found.value : null
  }

  async stats(peerKey) {
    const found = await this.bee.get('stat/' + peerKey)
    return found ? found.value : null
  }

  // Todos los pares que ALGUNA VEZ anunciaron este modelo, esten o no
  // conectados ahora. El ruteo NO usa esto (ver el encabezado); sirve para que
  // el panel pueda decir "4 nodos sirven llama1b, 1 online".
  async providersOf(modelId, { limit = 100 } = {}) {
    const out = []
    for await (const { value } of this.bee.createReadStream(
      prefixRange('model/' + modelId, { limit })
    )) {
      out.push(value)
    }
    return out
  }

  async recentLog(limit = 30) {
    const out = []
    for await (const { value } of this.bee.createReadStream(
      prefixRange('log', { reverse: true, limit })
    )) {
      out.push(value)
    }
    return out
  }

  // -------------------------------------------------------------------------

  async pruneLog({ ttlMs = LOG_TTL_MS, now = Date.now() } = {}) {
    const corte = 'log/' + tsKey(now - ttlMs)
    const viejas = []
    for await (const { key } of this.bee.createReadStream({ gte: 'log/', lt: corte })) {
      viejas.push(key)
    }
    if (viejas.length === 0) return 0

    const batch = this.bee.batch()
    for (const k of viejas) await batch.del(k)
    await batch.flush()
    return viejas.length
  }

  async close() {
    await this.flush()
    await this.bee.close()
  }
}
