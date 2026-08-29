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
//   chat:request   par -> nodo   { requestId, model, messages, stream,
//                                  payment?, maxTokens? }   <- payment: Fase 10
//   chat:accepted  nodo -> par   { requestId }            <- agregado
//   chat:chunk     nodo -> par   { requestId, delta }
//   chat:done      nodo -> par   { requestId, attestation?, attestationMissing? }  <- Fase 10
//   chat:error     nodo -> par   { requestId, message, code }
//   chat:cancel    par -> nodo   { requestId }            <- agregado
//
// `chat:accepted` existe porque el modelo se carga PEREZOSO -recien con el
// primer request- y eso puede tardar decenas de segundos. Sin un acuse, el
// consumidor no puede distinguir "esta cargando 807 MB" de "se colgo", y
// tendria que elegir entre un timeout corto que mata cargas legitimas o uno
// largo que hace esperar de gratis contra un par muerto.
//
// FASE 10 — cuando el `chat:request` trae un `payment` (la autorizacion EIP-3009
// que el CLIENTE firmo a favor de ESTE nodo, reenviada por el gateway que
// ruteo), este lado hace lo que en un cobro local hace el gateway: arma la
// atestacion D24 de lo que sirvio, arma el recibo x402 con ese pago, y lo
// acumula en el lote propio para liquidarlo diferido. El gateway que ruteo YA NO
// liquida los ruteados (handoff completo): el que cobra es el que corrio el
// modelo. La atestacion firmada vuelve en el `chat:done` para el rastro del otro
// lado.
//
// Lo que este lado NO hace: re-verificar la autorizacion. Confia en que el
// gateway que ruteo ya corrio `x402.verificarPago`. Es una decision explicita
// (el TTFT es lo que se mide) y su costo es que un gateway comprometido puede
// quemar GPU ajena.

import * as quota from './quota.mjs'
import * as atestacion from './atestacion.mjs'
import * as lote from './lote.mjs'

const MAX_MESSAGES = 64
const MAX_CONTENT_CHARS = 32000

export class Provider {
  constructor({
    engineLoader,
    store = null,
    maxConcurrent = 3,
    models = [],
    // FASE 10 — la wallet de cobro de este nodo y una FUNCION que firma con
    // ella (personal_sign EIP-191, `account.sign` de WDK). Mismo patron que
    // `gateway.setWalletSigner`: acá no entra ninguna seed. Sin las dos, un
    // request ruteado con pago se sirve igual pero no se atestigua ni se
    // acumula, y el `chat:done` lo dice con un motivo.
    walletAddress = null,
    firmarConWallet = null
  } = {}) {
    // Se inyecta el cargador en vez de importar engine.mjs aca arriba: importar
    // el motor hace dlopen del addon de llamacpp (96 MB) en el acto, y un nodo
    // que todavia no recibio un request no tiene por que pagar eso.
    this.engineLoader = engineLoader
    this.store = store
    this.maxConcurrent = maxConcurrent
    this.models = models
    this.walletAddress = walletAddress
    this.firmarConWallet = typeof firmarConWallet === 'function' ? firmarConWallet : null

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

    // La cuota gratuita del par (D23 / Fase 6.6). Va ANTES del limite de
    // capacidad a proposito: los dos rechazan antes del primer chunk, asi que
    // D4 reintenta igual, pero el motivo no es intercambiable. "Estoy lleno"
    // invita a volver en dos segundos; "te quedaste sin cuota" dice en cuanto
    // se repone. Contestar lo primero cuando pasa lo segundo manda al
    // consumidor a un reintento que va a fallar igual.
    const cuota = quota.check(peer.key)
    if (!cuota.ok) {
      return reply('chat:error', {
        message: cuota.reason,
        code: 'quota_exceeded',
        // El dato accionable: sin esto el consumidor sabe que no puede, pero
        // no cuando podria.
        resetsInMs: cuota.resetsInMs
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
    // FASE 10 — el texto acumulado, para el `outputHash` de la atestacion D24.
    // El hash es sobre el texto COMPLETO servido, no sobre el conteo de deltas:
    // quien trocea el stream es este lado, y un hash que dependiera del troceo
    // seria el agujero que D24 cierra.
    let contenido = ''
    // FASE 10 / D9 — el tope de tokens que declaro el 402, reenviado por el
    // gateway. Se aplica ACA para que la atestacion y lo que el cliente recibe
    // sean el MISMO texto: si el gateway recortara despues, el `outputHash`
    // atestiguaria de mas. Estimacion bytes UTF-8 / 4, igual que el gateway.
    const tope =
      Number.isFinite(Number(msg.maxTokens)) && Number(msg.maxTokens) > 0
        ? Number(msg.maxTokens)
        : 0
    let topeAlcanzado = false

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
        contenido += delta
        reply('chat:chunk', { delta })
        if (tope > 0 && Buffer.byteLength(contenido, 'utf8') / 4 >= tope) {
          topeAlcanzado = true
          console.log(`[provider] ${msg.requestId} cortado por el tope de ${tope} tokens`)
          break
        }
      }

      // FASE 10 — el recibo de lo servido, con la atestacion firmada. Va ANTES
      // del `chat:done` para poder adjuntarla. Solo si el request trajo un pago
      // (o sea: lo ruteo un gateway que cobro), este nodo tiene con que firmar,
      // y salio AL MENOS un token: un corte sin resultado no se cobra ni se
      // atestigua (D27 caso 2), igual que del lado del gateway.
      const finishReason = entry.cancelled ? 'client_cancelled' : topeAlcanzado ? 'length' : 'stop'
      let reciboRes = { attestation: null, motivo: null }
      if (msg.payment && deltas > 0) {
        reciboRes = await this._acumularReciboDelPar({ msg, contenido, deltas, finishReason })
      } else if (msg.payment) {
        reciboRes = { attestation: null, motivo: 'no se sirvio ningun token: no se cobra (D27)' }
      }

      if (!entry.cancelled) {
        reply('chat:done', {
          ...(reciboRes.attestation ? { attestation: reciboRes.attestation } : {}),
          ...(reciboRes.motivo ? { attestationMissing: reciboRes.motivo } : {})
        })
      } else if (msg.payment && deltas > 0) {
        // FASE 10 / D27 caso 1 — el cliente corto, pero este nodo sirvio y
        // atestiguo un prefijo cobrable. El `chat:done` tardio lleva esa
        // atestacion (o el motivo si no se pudo firmar) para que el gateway la
        // cuelgue del rastro del ruteado en vez de dejarlo con
        // attestationMissing. El swarm del otro lado mantiene el chat vivo una
        // ventana corta justo para recibir esto.
        reply('chat:done', {
          ...(reciboRes.attestation ? { attestation: reciboRes.attestation } : {}),
          ...(reciboRes.motivo ? { attestationMissing: reciboRes.motivo } : {})
        })
      }
      console.log(
        `[provider] ${msg.requestId} ${entry.cancelled ? 'cancelado' : topeAlcanzado ? 'tope' : 'ok'}: ` +
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

      // Se descuenta lo que se genero DE VERDAD, no lo que se pidio. Un
      // request cancelado a los tres tokens gasta tres, y uno que fallo
      // cargando el modelo no gasta nada: la cuota mide GPU entregada, no
      // intentos. Va en el finally por lo mismo que la liquidacion del
      // budget del otro lado -- un stream que revienta a la mitad igual
      // consumio lo que consumio.
      quota.registrar(peer.key, deltas)

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

  // FASE 10 — arma la atestacion D24 de lo que se sirvio, arma el recibo x402
  // con el pago que reenvio el gateway, y lo mete en el lote propio para
  // liquidarlo diferido. Devuelve `{ attestation, motivo }`: `attestation` es la
  // firmada (o null) y `motivo` dice por que falta, para que el `chat:done` la
  // ausencia sea legible.
  //
  // No tira nunca: un fallo acá no puede llevarse puesto el `chat:done` de un
  // stream que sí se sirvió. El precio de ese fallo es un recibo no acumulado
  // -- trabajo servido y no cobrado --, y se dice fuerte en el log.
  async _acumularReciboDelPar({ msg, contenido, deltas, finishReason }) {
    const p = msg.payment
    try {
      if (!this.walletAddress || !this.firmarConWallet) {
        return { attestation: null, motivo: 'este nodo no tiene wallet/firmante para atestiguar' }
      }
      if (!p || !p.authorization || !p.signature || !p.requirements) {
        return { attestation: null, motivo: 'el pago reenviado esta incompleto' }
      }
      // El 402 tuvo que pagarNOS a nosotros. Si el payTo no es nuestra wallet,
      // el gateway ruteo mal o el pago viene manipulado: no se acumula.
      if (String(p.requirements.payTo || '').toLowerCase() !== this.walletAddress.toLowerCase()) {
        console.error(
          `[provider] ${msg.requestId}: el pago reenviado no apunta a la wallet de este nodo`
        )
        return { attestation: null, motivo: 'el pago reenviado no apunta a la wallet de este nodo' }
      }

      const sinFirmar = atestacion.construir({
        requestId: msg.requestId,
        modelId: msg.model,
        quantization: atestacion.cuantizacionDe(msg.model),
        runtime: 'llamacpp',
        promptHash: atestacion.hashDeMensajes(msg.messages),
        outputHash: atestacion.hashDe(contenido),
        // Sin `usage` de este lado: el prefill no se mide, el decode es el
        // conteo de deltas. Son los numeros que este nodo se compromete a
        // sostener; la fuente (medido/estimado) la anota el rastro, no la
        // atestacion.
        tokensPrefill: 0,
        tokensDecode: deltas,
        finishReason,
        providerPubkey: this.walletAddress
      })
      const firmada = await atestacion.firmar(sinFirmar, this.firmarConWallet)
      if (!firmada) {
        return { attestation: null, motivo: 'la wallet no pudo firmar la atestacion' }
      }

      const recibo = lote.construirRecibo({
        requestId: msg.requestId,
        red: p.red || null,
        network: p.requirements.network,
        asset: p.requirements.asset,
        assetName: p.requirements.extra && p.requirements.extra.name,
        assetVersion: p.requirements.extra && p.requirements.extra.version,
        payTo: this.walletAddress,
        payer: p.authorization.from,
        amount: p.authorization.value,
        authorization: p.authorization,
        signature: p.signature,
        requirements: p.requirements,
        atestacion: firmada,
        liquidacion: null
      })
      lote.agregar(recibo)
      console.log(
        `[provider] ${msg.requestId}: recibo acumulado en el lote (nonce ${recibo.nonce})`
      )
      return { attestation: firmada, motivo: null }
    } catch (err) {
      console.error(
        `[provider] ${msg.requestId}: no se pudo acumular el recibo: ${(err && err.message) || err}`
      )
      return { attestation: null, motivo: 'no se pudo armar el recibo de lo servido' }
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
