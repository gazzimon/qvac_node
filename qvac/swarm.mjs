// Descubrimiento P2P del nodo. Fase 2-b del ROADMAP.
//
// Un topic fijo: todos los nodos QVAC se encuentran ahi sin configuracion. Cada
// conexion -entrante o saliente- lleva UN canal Protomux (D1), que es el MISMO
// canal que transporta chat:request/chat:chunk. No hay una segunda conexion
// para inferencia.
//
// Sobre ESE MISMO socket viaja tambien la replicacion del Corestore, en otros
// canales del mismo multiplexor: el directorio Hyperbee y los Hyperdrive de
// archivos. Una sola conexion, un solo hole-punch, tres cosas encima.
// (Antes el socket iba envuelto en FramedStream, que se adueña del stream y
// hacia imposible compartirlo. Ver la nota de channel.mjs.)
//
// Protocolo (JSON por mensaje, tabla de D1):
//   manifest:announce  nodo -> par    el manifiesto firmado
//   node:status        nodo -> par    { activeRequests, maxConcurrentRequests }
//   files:announce     nodo -> par    { driveKey }  <- agregado, ver files.mjs
//   chat:request       par  -> nodo   { requestId, model, messages, stream }
//   chat:chunk         nodo -> par    { requestId, delta }
//   chat:done          nodo -> par    { requestId }
//   chat:error         nodo -> par    { requestId, message }
//
// Este archivo hace el descubrimiento, el handshake del manifiesto y el
// node:status. El transporte de chat es Fase 2-c/3 y engancha en `onMessage`.

import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import { openChannel, attachMux } from './channel.mjs'
import { buildManifest, signManifest, verifyManifest } from './manifest.mjs'

// Topic fijo y hardcodeado a proposito: es el "canal QVAC". Se deriva de una
// frase por hash para que sea reproducible desde el codigo y no un blob de hex
// que nadie puede auditar de un vistazo.
//
// **v1 y no v0**: el cambio de FramedStream a Protomux NO es compatible en el
// cable. Un nodo v0 y uno v1 se conectan igual -- el topic era el mismo -- y
// despues se quedan mudos hasta que salta el HANDSHAKE_TIMEOUT_MS, porque
// ninguno entiende el framing del otro. Visto en vivo: "no mando manifiesto,
// se descarta", en loop, contra un nodo que estaba perfectamente sano.
//
// Separar el topic convierte una incompatibilidad silenciosa en una ausencia
// limpia: durante la ventana del OTA, los v0 siguen viendose entre ellos y los
// v1 entre ellos, sin conexiones que nacen muertas ni logs que hacen pensar
// que se cayo la red. Cuando el ultimo nodo se actualiza, el v0 queda vacio.
export const TOPIC_NAME = 'qvac-node:marketplace:v1'
export const TOPIC = crypto.data(Buffer.from(TOPIC_NAME))

const STATUS_INTERVAL_MS = 2000

// Un peer que se conecto pero todavia no mando un manifiesto valido NO es un
// candidato. Si no lo manda en esta ventana, se descarta: puede ser otra app
// que cayo en el mismo topic, o un nodo de una version incompatible.
const HANDSHAKE_TIMEOUT_MS = 10000

export class NodeSwarm {
  constructor({
    identity,
    models,
    operator,
    tags,
    store,
    corestore = null,
    directory = null,
    files = null,
    onPeerChange = () => {}
  } = {}) {
    this.identity = identity || crypto.keyPair()
    this.models = models || []
    this.operator = operator || 'Nodo QVAC'
    this.tags = tags || []
    this.store = store || null
    this.onPeerChange = onPeerChange

    // Los tres son opcionales: `peers` (el comando del hard gate) corre sin
    // ninguno y sigue midiendo lo mismo que antes. Cuando estan, la conexion
    // ademas replica y persiste.
    this.corestore = corestore
    this.directory = directory
    this.files = files

    this.swarm = null
    // key hex del peer -> { channel, manifest, status, socket, filesKey }
    this.peers = new Map()

    // Marca de agua alta: pares cuyo manifiesto verifico ALGUNA vez en esta
    // sesion. `peers` solo tiene los conectados ahora, y el DoD de Fase 2 es
    // "se descubrieron e intercambiaron manifiestos verificados" -- un evento,
    // no un estado. Sin esto, el nodo que corre unos segundos mas que el otro
    // reporta cero pares y el gate del runbook falla en falso.
    this.everVerified = new Set()

    // D7: el numero que falta en NOTES.md. Se mide join -> primera conexion, y
    // join -> primer manifiesto verificado, que son cosas distintas: la
    // segunda es la que cuenta para el DoD de Fase 2.
    this.joinedAt = null
    this.firstPeerMs = null
    this.firstManifestMs = null

    this._statusTimer = null
    this._manifest = null

    // El lado que SIRVE (provider.mjs). Solo lo setea `serve --swarm`; con
    // esto en null el nodo anuncia y consume pero no atiende chat:request.
    this.provider = null

    // El lado que CONSUME: requestId -> handlers del request en vuelo.
    this._chats = new Map()
    this._chatSeq = 0
  }

  setProvider(provider) {
    this.provider = provider
  }

  // El manifiesto se arma y se firma UNA vez por sesion: `publishedAt` no tiene
  // que cambiar en cada anuncio, y firmar es lo mas caro de este camino.
  manifest() {
    if (!this._manifest) {
      this._manifest = signManifest(
        buildManifest({
          publicKey: this.identity.publicKey,
          models: this.models,
          operator: this.operator,
          tags: this.tags,
          // El campo `directory` del schema deja de ser un mock (D2) cuando hay
          // un Hyperbee de verdad detras: la clave que se firma aca es la que
          // el par usa para replicarlo.
          directory: this.directory ? this.directory.descriptor() : null
        }),
        this.identity.secretKey
      )
    }
    return this._manifest
  }

  async join() {
    // La identidad del swarm ES la del manifiesto: el `publicKey` que firma es
    // el mismo con el que Hyperswarm se presenta. Sin esto, verifyManifest no
    // puede atar la firma al peer del socket y la firma no prueba identidad
    // (ver la nota larga en manifest.mjs).
    this.swarm = new Hyperswarm({ keyPair: this.identity })

    this.swarm.on('connection', (socket, info) => this._onConnection(socket, info))

    const discovery = this.swarm.join(TOPIC, { client: true, server: true })
    this.joinedAt = Date.now()

    // `flushed()` resuelve cuando el topic esta anunciado en la DHT, no cuando
    // hay pares. Se espera igual: sin esto, un `join()` seguido de un exit
    // inmediato no llega a anunciarse nunca.
    await discovery.flushed()

    return {
      publicKey: this.identity.publicKey.toString('hex'),
      topic: TOPIC.toString('hex')
    }
  }

  _onConnection(socket, info) {
    const key = info.publicKey.toString('hex')

    // ORDEN IMPORTANTE. `attachMux` deja el multiplexor en `socket.userData`
    // ANTES de que nadie mas lo toque. `corestore.replicate` busca uno ahi y,
    // si no lo encuentra, crea el suyo: dos multiplexores escribiendo frames
    // sobre el mismo stream rompen la conexion de una forma que desde afuera
    // se lee como "se cayo la red". Ver el encabezado de channel.mjs.
    attachMux(socket)

    // Replicacion del directorio y de los drives por el MISMO socket. Corestore
    // sirve por discoveryKey lo que tenga (`ondiscoverykey`), asi que esto
    // alcanza para que un par pueda bajar un archivo publicado por este nodo
    // sin abrir ninguna conexion nueva.
    if (this.corestore) this.corestore.replicate(socket)

    // El cap de 16 MiB por frame que daba `bits: 24` no se pierde al sacar
    // FramedStream: NoiseSecretStream frena en MAX_ATOMIC_WRITE = 0xffffff,
    // los mismos 16 MiB, y lo hace una capa mas abajo -- antes de que Protomux
    // llegue a reservar nada. El topic es publico y sale del codigo, asi que
    // ese frame lo puede mandar cualquiera; el manifiesto son ~2 KB y el chat
    // esta capado en 32000 chars por Provider._validate.
    // El peer se declara ANTES de abrir el canal para que el `onmessage` no
    // capture una binding en zona muerta: protomux no entrega nada de forma
    // sincrona, pero depender de eso es una trampa esperando a alguien.
    const peer = { channel: null, socket, manifest: null, status: null, key, filesKey: null }

    const chan = openChannel(socket, {
      onmessage: (msg) => this._onMessage(peer, msg)
    })

    if (chan === null) {
      // Ya habia un canal de control sobre este socket. Es un bug de programa,
      // no una condicion de red: mejor cortar que quedarse con un par mudo.
      console.error(`[swarm] canal duplicado con ${key.slice(0, 8)}…, se corta`)
      socket.destroy()
      return
    }

    peer.channel = chan
    this.peers.set(key, peer)

    if (this.firstPeerMs === null && this.joinedAt !== null) {
      this.firstPeerMs = Date.now() - this.joinedAt
      console.log(`[swarm] primer par en ${this.firstPeerMs}ms (D7)`)
    }

    console.log(`[swarm] conectado ${key.slice(0, 8)}… (${this.peers.size} par/es)`)

    // Un socket sin handler de 'error' tira una excepcion no capturada que se
    // lleva el proceso entero. Un peer que se va cierra el socket de mil
    // formas feas y ninguna justifica tumbar un nodo que esta sirviendo.
    socket.on('error', (err) => {
      console.log(`[swarm] socket ${key.slice(0, 8)}… caido: ${(err && err.message) || err}`)
    })
    const handshake = setTimeout(() => {
      if (!peer.manifest) {
        console.log(`[swarm] ${key.slice(0, 8)}… no mando manifiesto, se descarta`)
        socket.destroy()
      }
    }, HANDSHAKE_TIMEOUT_MS)
    handshake.unref?.()

    socket.on('close', () => {
      clearTimeout(handshake)

      // Si ya hay una conexion MAS NUEVA con este mismo par, este 'close' es
      // el de la vieja y no tiene que tocar nada. `peers` va indexado por
      // clave, asi que la conexion nueva ya piso la entrada: borrar aca deja
      // al par fantasma -- canal vivo pero invisible para el gateway, sus
      // filas del marketplace borradas, y sus requests en vuelo cancelados
      // por cancelByPeer. Pasa en cualquier reconexion rapida y en la carrera
      // de tie-break cliente/servidor de Hyperswarm, y desde afuera se lee
      // como "se cayo la red".
      if (this.peers.get(key) !== peer) return

      this.peers.delete(key)
      // D3: el candidato muere con el socket, sin esperar ningun expiresAt.
      if (this.store && peer.manifest) this.store.removeByPeer(key)

      // Los chats en vuelo contra este par NO se pueden quedar esperando un
      // chunk que no va a llegar nunca: el cliente HTTP del otro lado queda
      // colgado para siempre. Se les avisa aca, y del lado del gateway D4
      // decide si reintenta (solo si todavia no le mando nada al cliente).
      for (const [requestId, chat] of this._chats) {
        if (chat.peerKey !== key) continue
        this._chats.delete(requestId)
        chat.onError('el par se desconecto a mitad del request', 'peer_gone')
      }

      // Y lo que este nodo estaba generando PARA ese par se corta: seguir
      // gastando CPU en tokens que no tienen a donde ir es exactamente lo que
      // chat:cancel evita en el caso normal.
      if (this.provider) this.provider.cancelByPeer(key)

      console.log(`[swarm] desconectado ${key.slice(0, 8)}… (${this.peers.size} par/es)`)
      this.onPeerChange(this.peers)
    })

    // Se anuncia primero, sin esperar al otro: los dos lados hacen lo mismo y
    // el handshake no tiene turnos que puedan quedar trabados.
    this._send(peer, { type: 'manifest:announce', manifest: this.manifest() })
    this._sendStatus(peer)

    // La clave del drive va DESPUES del manifiesto y en su propio mensaje: el
    // schema v0 esta congelado con `additionalProperties: false`, asi que no
    // hay campo del manifiesto donde meterla sin romper la validacion. Va por
    // el canal Noise, que ya autentico al par, con la misma clase de confianza
    // que `node:status` -- atribuible, no firmada. Ver files.mjs.
    if (this.files) this._send(peer, { type: 'files:announce', driveKey: this.files.keyHex })
  }

  _send(peer, msg) {
    if (!peer.channel) return
    peer.channel.send(msg)
  }

  _sendStatus(peer) {
    // Sin gateway levantado (comando `peers`) no hay carga real que reportar,
    // pero la CAPACIDAD declarada si existe: es la del manifiesto. Mandar 0/0
    // haria que el otro lado muestre "capacidad cero", que no es lo que pasa.
    const status = this.store
      ? this.store.localLoad()
      : {
          activeRequests: 0,
          maxConcurrentRequests: this.models.reduce(
            (n, m) => n + (Number.isFinite(m.maxConcurrentRequests) ? m.maxConcurrentRequests : 0),
            0
          )
        }
    this._send(peer, { type: 'node:status', ...status })
  }

  // El canal llama a esto por cada mensaje, YA decodificado (protomux hace el
  // JSON.parse con el encoding `c.json`). TODO lo de adentro va envuelto: una
  // excepcion que se escape sube al onmessage de protomux y se lleva puesto el
  // canal con ese par -- no este request, el canal entero, para todos los
  // requests que vengan despues. El par sigue "conectado" en la tabla y sus
  // chat:request no llegan nunca mas: un modo de falla muy dificil de leer
  // desde afuera.
  //
  // La basura de otra app que caiga en el mismo topic ya no llega hasta aca:
  // sin abrir el canal `qvac/node/v0` no hay a donde entregarsela, cosa que
  // con FramedStream sobre el socket crudo si pasaba.
  _onMessage(peer, msg) {
    try {
      this._dispatch(peer, msg)
    } catch (err) {
      console.error(
        `[swarm] handler de ${peer.key.slice(0, 8)}… tiro una excepcion: ${(err && err.message) || err}`
      )
    }
  }

  _dispatch(peer, msg) {
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'manifest:announce') {
      // El manifiesto se verifica ATANDOLO a la clave del socket. Sin
      // expectedPublicKey, cualquiera puede firmar un manifiesto que dice ser
      // de otro nodo y la firma verifica perfecto sin probar nada.
      const res = verifyManifest(msg.manifest, { expectedPublicKey: peer.key })
      if (!res.ok) {
        console.log(`[swarm] manifiesto rechazado de ${peer.key.slice(0, 8)}…: ${res.reason}`)
        return
      }

      peer.manifest = msg.manifest
      this.everVerified.add(peer.key)

      if (this.firstManifestMs === null && this.joinedAt !== null) {
        this.firstManifestMs = Date.now() - this.joinedAt
        console.log(`[swarm] primer manifiesto VERIFICADO en ${this.firstManifestMs}ms (D7)`)
      }

      const modelos = msg.manifest.models.map((m) => m.modelId).join(', ')
      const op = (msg.manifest.metadata && msg.manifest.metadata.operator) || '?'
      console.log(`[swarm] manifiesto OK de ${op} (${peer.key.slice(0, 8)}…): ${modelos}`)

      if (this.store) this.store.upsertFromManifest(peer.key, msg.manifest)

      // Al directorio va con origin 'socket': este manifiesto SI probo
      // identidad contra la clave de la conexion. El que se replique despues a
      // otro nodo no le transfiere esa propiedad -- ver directory.mjs.
      if (this.directory) this.directory.recordManifest(peer.key, msg.manifest)

      this.onPeerChange(this.peers)
      return
    }

    if (msg.type === 'files:announce') {
      // Mismo criterio que node:status: sin manifiesto verificado no se le
      // acepta nada a un desconocido, ni siquiera una clave de drive.
      if (!peer.manifest) return
      if (typeof msg.driveKey !== 'string' || !/^[0-9a-f]{64}$/.test(msg.driveKey)) return

      peer.filesKey = msg.driveKey
      if (this.directory) this.directory.recordFilesKey(peer.key, msg.driveKey)
      console.log(
        `[swarm] ${peer.key.slice(0, 8)}… publica archivos en ${msg.driveKey.slice(0, 8)}…`
      )
      this.onPeerChange(this.peers)
      return
    }

    if (msg.type === 'node:status') {
      // Un status de un peer que todavia no probo quien es no se acepta: seria
      // dejar que un desconocido escriba en la tabla de candidatos.
      if (!peer.manifest) return
      peer.status = {
        activeRequests: msg.activeRequests,
        maxConcurrentRequests: msg.maxConcurrentRequests
      }
      if (this.store) this.store.updateStatus(peer.key, peer.status)
      this.onPeerChange(this.peers)
      return
    }

    // --- lado proveedor ---
    if (this.provider && this.provider.handles(msg.type)) {
      // Un par que no completo el handshake no puede pedir inferencia: seria
      // regalarle CPU a un desconocido que no dijo quien es.
      if (!peer.manifest) return
      this.provider.onMessage(peer, msg, (out) => this._send(peer, out))
      return
    }

    // --- lado consumidor ---
    if (msg.type.startsWith('chat:')) {
      const chat = this._chats.get(msg.requestId)
      // Respuesta a un request que ya no existe (cancelado, o de otro par que
      // se hace el vivo). Se ignora: no hay a quien entregarsela.
      if (!chat || chat.peerKey !== peer.key) return

      if (msg.type === 'chat:accepted') chat.onAccepted()
      else if (msg.type === 'chat:chunk') chat.onChunk(msg.delta)
      else if (msg.type === 'chat:done') {
        this._chats.delete(msg.requestId)
        chat.onDone()
      } else if (msg.type === 'chat:error') {
        this._chats.delete(msg.requestId)
        chat.onError(msg.message || 'error sin motivo', msg.code || null)
      }
    }
  }

  // Abre un chat contra un par. Devuelve el requestId para poder cancelarlo.
  // Los handlers son callbacks y no una promesa porque esto es un stream: lo
  // que importa es cada chunk a medida que llega, no el resultado final.
  chatRequest(peerKey, { model, messages }, handlers) {
    const peer = this.peers.get(peerKey)
    if (!peer || !peer.manifest) {
      handlers.onError('el par ya no esta conectado', 'peer_gone')
      return null
    }

    const requestId = `r${Date.now().toString(36)}${(this._chatSeq++).toString(36)}`
    this._chats.set(requestId, { peerKey, ...handlers })
    this._send(peer, { type: 'chat:request', requestId, model, messages, stream: true })
    return requestId
  }

  cancelChat(requestId) {
    const chat = this._chats.get(requestId)
    if (!chat) return
    this._chats.delete(requestId)
    const peer = this.peers.get(chat.peerKey)
    // Si el par ya se fue no hay a quien avisarle, y su proceso ya corto solo.
    if (peer) this._send(peer, { type: 'chat:cancel', requestId })
  }

  startStatusBroadcast(intervalMs = STATUS_INTERVAL_MS) {
    this.stopStatusBroadcast()
    this._statusTimer = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (peer.manifest) this._sendStatus(peer)
      }
    }, intervalMs)
    this._statusTimer.unref?.()
  }

  stopStatusBroadcast() {
    if (this._statusTimer) clearInterval(this._statusTimer)
    this._statusTimer = null
  }

  // Los que completaron el handshake. Es la cuenta que importa para el DoD:
  // "conectado" no es lo mismo que "verificado".
  verifiedPeers() {
    return [...this.peers.values()].filter((p) => p.manifest)
  }

  // Los pares conectados que anunciaron un drive. Es la lista de "a quien le
  // puedo pedir un archivo AHORA": los que estan en el directorio pero no
  // conectados no entran, por la misma razon que no son candidatos de ruteo.
  peersWithFiles() {
    return this.verifiedPeers()
      .filter((p) => p.filesKey)
      .map((p) => ({
        peerKey: p.key,
        driveKey: p.filesKey,
        operator: (p.manifest.metadata && p.manifest.metadata.operator) || 'Nodo remoto'
      }))
  }

  timings() {
    return {
      joinToFirstPeerMs: this.firstPeerMs,
      joinToFirstManifestMs: this.firstManifestMs,
      peers: this.peers.size,
      verified: this.verifiedPeers().length,
      verifiedEver: this.everVerified.size
    }
  }

  async destroy() {
    this.stopStatusBroadcast()

    // Los canales se cierran antes que el swarm. Al reves, `swarm.destroy()`
    // rompe el socket abajo del multiplexor y protomux emite el cierre sobre
    // un stream ya muerto.
    for (const peer of this.peers.values()) {
      if (peer.channel) peer.channel.close()
    }

    if (this.swarm) await this.swarm.destroy()
    this.peers.clear()
  }
}
