// El lado que SIRVE inferencia a un par remoto. Fase 3 del ROADMAP.
//
// Atiende `chat:request` que llegan por el FramedStream que el swarm ya tiene
// abierto (D1: no hay una segunda conexion, ni un hop por HTTP a localhost).
//
// Vive en su propio modulo y no adentro de swarm.mjs porque son dos
// responsabilidades distintas: el swarm decide con QUIEN se habla, el provider
// decide QUE se contesta. Solo lo instancia `serve --swarm`, que es el nodo
// completo; `peers` sigue siendo un diagnostico sin efectos (decidido: el
// comando del hard gate no puede ponerse a servir tokens mientras mide).
//
// Protocolo (extiende la tabla de D1):
//   chat:request   par -> nodo   { requestId, model, messages, stream }
//   chat:accepted  nodo -> par   { requestId }            <- agregado
//   chat:chunk     nodo -> par   { requestId, delta }
//   chat:done      nodo -> par   { requestId }
//   chat:error     nodo -> par   { requestId, message, code }
//   chat:cancel    par -> nodo   { requestId }            <- agregado
//
// `chat:accepted` existe porque el modelo se carga PEREZOSO -recien con el
// primer request- y eso puede tardar decenas de segundos. Sin un acuse, el
// consumidor no puede distinguir "esta cargando 807 MB" de "se colgo", y
// tendria que elegir entre un timeout corto que mata cargas legitimas o uno
// largo que hace esperar de gratis contra un par muerto.

const MAX_MESSAGES = 64
const MAX_CONTENT_CHARS = 32000

export class Provider {
  constructor({ engineLoader, store = null, maxConcurrent = 3, models = [] } = {}) {
    // Se inyecta el cargador en vez de importar engine.mjs aca arriba: importar
    // el motor hace dlopen del addon de llamacpp (96 MB) en el acto, y un nodo
    // que todavia no recibio un request no tiene por que pagar eso.
    this.engineLoader = engineLoader
    this.store = store
    this.maxConcurrent = maxConcurrent
    this.models = models

    this.engine = null
    // modelId ANUNCIADO -> modelId cargado por el engine. Antes era un solo
    // escalar hardcodeado a 'llama1b': con un unico modelo en swarmModels()
    // no se notaba, pero el dia que se agregue un segundo, este nodo
    // aceptaria el request (serves() lo valida contra this.models) y le
    // serviria los pesos del primer modelo igual -- exactamente lo que el
    // manifiesto firmado existe para impedir: anunciar lo que de verdad se
    // sirve.
    this._modelIds = new Map()
    this._loading = new Map()

    // requestId -> { cancelled, peerKey }
    this.active = new Map()
  }

  // Los modelId que este nodo realmente puede servir. Un request por otro
  // modelo se rechaza con un motivo, no con silencio (mismo principio que D5
  // del lado HTTP).
  serves(model) {
    return this.models.some((m) => m.modelId === model)
  }

  // Envoltorio publico de _ensureModel: lo usa el gateway para precargar un
  // modelo ANTES de anunciarlo (POST /v1/swarm/manifest) -- si la carga
  // falla, el llamador nunca llega a re-firmar el manifiesto con un modelo
  // que este nodo en realidad no puede servir.
  async preloadModel(model) {
    return this._ensureModel(model)
  }

  _ensureModel(model) {
    if (this._modelIds.has(model)) return Promise.resolve(this._modelIds.get(model))
    if (!this._loading.has(model)) {
      const loading = (async () => {
        this.engine = this.engine || (await this.engineLoader())
        const { modelSrc } = await this.engine.resolveModel(model)
        const loadedId = await this.engine.loadModel({ modelSrc })
        this._modelIds.set(model, loadedId)
        return loadedId
      })()
      // Una promesa rechazada que queda cacheada deja ESE modelo muerto para
      // toda la sesion: todo request posterior recibe el mismo rechazo al
      // instante. Mismo bug que ya se arreglo en el gateway.
      loading.catch(() => {
        this._loading.delete(model)
      })
      this._loading.set(model, loading)
    }
    return this._loading.get(model)
  }

  // Un peer manda lo que quiere. Nada de lo que llega por el socket se pasa al
  // motor sin revisar: un `messages` de 100k entradas es un OOM gratis para
  // quien presta su maquina.
  _validate(msg) {
    if (typeof msg.requestId !== 'string' || msg.requestId === '') {
      return 'falta requestId'
    }
    if (typeof msg.model !== 'string' || msg.model === '') {
      return 'falta model'
    }
    if (!Array.isArray(msg.messages) || msg.messages.length === 0) {
      return 'messages tiene que ser un array con al menos un mensaje'
    }
    if (msg.messages.length > MAX_MESSAGES) {
      return `demasiados mensajes (${msg.messages.length} > ${MAX_MESSAGES})`
    }
    let total = 0
    for (const m of msg.messages) {
      if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
        return 'cada mensaje necesita role y content de tipo string'
      }
      total += m.content.length
    }
    if (total > MAX_CONTENT_CHARS) {
      return `prompt demasiado largo (${total} > ${MAX_CONTENT_CHARS} chars)`
    }
    return null
  }

  // Devuelve true si el mensaje era para el provider (y se atendio).
  handles(type) {
    return type === 'chat:request' || type === 'chat:cancel'
  }

  onMessage(peer, msg, send) {
    if (msg.type === 'chat:cancel') {
      const entry = this.active.get(msg.requestId)
      // Solo el par que abrio el request lo puede cancelar. Sin este chequeo,
      // cualquier par conectado puede cortarle el stream a otro.
      if (entry && entry.peerKey === peer.key) {
        entry.cancelled = true
        console.log(`[provider] ${msg.requestId} cancelado por el consumidor`)
      }
      return
    }

    if (msg.type === 'chat:request') {
      // No se hace await: cada request corre por su cuenta y el canal sigue
      // leyendo. Un request lento no puede tapar el resto del protocolo
      // (node:status, otros chats, el manifiesto de otro par).
      this._serve(peer, msg, send).catch((err) => {
        console.error('[provider] error no capturado:', (err && err.message) || err)
      })
    }
  }

  async _serve(peer, msg, send) {
    const reply = (type, extra) => send({ type, requestId: msg.requestId, ...extra })

    const invalido = this._validate(msg)
    if (invalido) {
      return reply('chat:error', { message: invalido, code: 'invalid_request' })
    }

    if (!this.serves(msg.model)) {
      const propios = this.models.map((m) => m.modelId).join(', ')
      return reply('chat:error', {
        message: `este nodo no sirve "${msg.model}"; sirve: ${propios}`,
        code: 'model_not_found'
      })
    }

    // Capacidad declarada = capacidad honrada. El manifiesto anuncia
    // maxConcurrentRequests y este es el unico lugar donde eso se cumple: sin
    // el limite, el numero del manifiesto seria decorativo.
    //
    // Se rechaza en vez de encolar a proposito: el consumidor recibe el error
    // ANTES del primer chunk, asi que D4 aplica y reintenta en otro candidato.
    // Una cola haria esperar al cliente sin que nadie sepa por cuanto.
    if (this.active.size >= this.maxConcurrent) {
      return reply('chat:error', {
        message: `este nodo esta al maximo de capacidad (${this.active.size}/${this.maxConcurrent})`,
        code: 'at_capacity'
      })
    }

    const entry = { cancelled: false, peerKey: peer.key }
    this.active.set(msg.requestId, entry)

    // El acuse va ANTES de cargar el modelo: es justamente lo que le dice al
    // consumidor "estoy vivo y trabajando, no me mates por timeout".
    reply('chat:accepted', {})

    const localNodeId = this.store ? this.store.localNodeIdFor(msg.model) : null
    if (localNodeId) this.store.beginRequest(localNodeId)

    const t0 = Date.now()
    let deltas = 0
    let ttftMs = null

    try {
      const modelId = await this._ensureModel(msg.model)

      // Cancelado mientras cargaba el modelo: no se empieza a generar.
      if (entry.cancelled) return

      for await (const delta of this.engine.complete({ modelId, history: msg.messages })) {
        if (entry.cancelled) {
          // `break` cierra el async generator (le llama return()), que es lo
          // que corta la generacion del lado del SDK. Si el SDK igual sigue
          // internamente no hay forma de saberlo desde aca, pero al menos no
          // se le mandan mas bytes a nadie ni se ocupa el slot.
          console.log(`[provider] ${msg.requestId} cortado tras ${deltas} deltas`)
          break
        }
        if (ttftMs === null) ttftMs = Date.now() - t0
        deltas++
        reply('chat:chunk', { delta })
      }

      if (!entry.cancelled) reply('chat:done', {})
      console.log(
        `[provider] ${msg.requestId} ${entry.cancelled ? 'cancelado' : 'ok'}: ` +
          `${deltas} deltas en ${Date.now() - t0}ms`
      )
    } catch (err) {
      const message = String((err && err.message) || err)
      console.error(`[provider] ${msg.requestId} fallo: ${message}`)
      // Se avisa igual si ya habia chunks: el consumidor necesita saber que lo
      // que tiene esta incompleto. Del lado de el, D4 decide si reintenta
      // (solo si todavia no le habia pasado nada al cliente).
      reply('chat:error', { message, code: 'inference_failed' })
    } finally {
      this.active.delete(msg.requestId)
      if (localNodeId) this.store.endRequest(localNodeId)

      // El rastro de lo que ESTE nodo sirvio PARA otro. Sin esta entrada no
      // habia manera de saber quien nos consumio: el log de ruteo solo tenia
      // el trafico saliente -lo que pedimos nosotros- y la mitad de la
      // relacion economica quedaba invisible.
      //
      // `kind: 'served'` y no 'route': una entrada de ruteo dice a quien le
      // pedimos, esta dice quien nos pidio. Mezclarlas en el mismo kind
      // obligaria a adivinar la direccion por los campos que traen.
      if (this.store && typeof this.store.pushLog === 'function') {
        const ms = Date.now() - t0
        this.store.pushLog({
          kind: 'served',
          peerKey: peer.key,
          operator: this.store.operatorForPeer
            ? this.store.operatorForPeer(peer.key)
            : peer.key.slice(0, 8),
          modelId: msg.model,
          tokens: deltas,
          ttftMs,
          tokensPerSec: ttftMs !== null && ms > 0 ? +(deltas / (ms / 1000)).toFixed(2) : null,
          ms,
          ok: !entry.cancelled && deltas > 0,
          reason: entry.cancelled ? 'cancelado por el par' : undefined
        })
      }
    }
  }

  // El par se desconecto: lo que se estaba generando para el no tiene destino.
  cancelByPeer(peerKey) {
    let n = 0
    for (const [requestId, entry] of this.active) {
      if (entry.peerKey !== peerKey) continue
      entry.cancelled = true
      n++
      void requestId
    }
    if (n) console.log(`[provider] ${n} request(s) cortado(s): el par se fue`)
  }

  async shutdown() {
    // Se marcan todos como cancelados para que los loops en vuelo corten en la
    // proxima iteracion en vez de seguir generando contra un socket que ya no
    // esta.
    for (const entry of this.active.values()) entry.cancelled = true
    if (this.engine) {
      for (const loadedId of this._modelIds.values()) {
        await this.engine.shutdown(loadedId).catch(() => {})
      }
    }
  }
}
