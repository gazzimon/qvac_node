// Descubrimiento P2P del nodo. Fase 2-b del ROADMAP.
//
// Un topic fijo: todos los nodos QVAC se encuentran ahi sin configuracion. Cada
// conexion -entrante o saliente- se envuelve en FramedStream (D1), que es el
// MISMO canal que despues transporta chat:request/chat:chunk en Fase 3. No hay
// una segunda conexion para inferencia.
//
// Protocolo (JSON por mensaje, tabla de D1):
//   manifest:announce  nodo -> par    el manifiesto firmado
//   node:status        nodo -> par    { activeRequests, maxConcurrentRequests }
//   chat:request       par  -> nodo   { requestId, model, messages, stream }
//   chat:chunk         nodo -> par    { requestId, delta }
//   chat:done          nodo -> par    { requestId }
//   chat:error         nodo -> par    { requestId, message }
//
// Este archivo hace el descubrimiento, el handshake del manifiesto y el
// node:status. El transporte de chat es Fase 2-c/3 y engancha en `onMessage`.

import Hyperswarm from 'hyperswarm'
import FramedStream from 'framed-stream'
import crypto from 'hypercore-crypto'
import { buildManifest, signManifest, verifyManifest } from './manifest.mjs'

// Topic fijo y hardcodeado a proposito: es el "canal QVAC". Se deriva de una
// frase por hash para que sea reproducible desde el codigo y no un blob de hex
// que nadie puede auditar de un vistazo.
export const TOPIC_NAME = 'qvac-node:marketplace:v0'
export const TOPIC = crypto.data(Buffer.from(TOPIC_NAME))

const STATUS_INTERVAL_MS = 2000

// Un peer que se conecto pero todavia no mando un manifiesto valido NO es un
// candidato. Si no lo manda en esta ventana, se descarta: puede ser otra app
// que cayo en el mismo topic, o un nodo de una version incompatible.
const HANDSHAKE_TIMEOUT_MS = 10000

export class NodeSwarm {
  constructor({ identity, models, operator, tags, store, onPeerChange = () => {} } = {}) {
    this.identity = identity || crypto.keyPair()
    this.models = models || []
    this.operator = operator || 'Nodo QVAC'
    this.tags = tags || []
    this.store = store || null
    this.onPeerChange = onPeerChange

    this.swarm = null
    // key hex del peer -> { pipe, manifest, status, socket }
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
          tags: this.tags
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
    const pipe = new FramedStream(socket)

    const peer = { pipe, socket, manifest: null, status: null, key }
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
    pipe.on('error', () => {})

    const handshake = setTimeout(() => {
      if (!peer.manifest) {
        console.log(`[swarm] ${key.slice(0, 8)}… no mando manifiesto, se descarta`)
        socket.destroy()
      }
    }, HANDSHAKE_TIMEOUT_MS)
    handshake.unref?.()

    socket.on('close', () => {
      clearTimeout(handshake)
      this.peers.delete(key)
      // D3: el candidato muere con el socket, sin esperar ningun expiresAt.
      if (this.store && peer.manifest) this.store.removeByPeer(key)
      console.log(`[swarm] desconectado ${key.slice(0, 8)}… (${this.peers.size} par/es)`)
      this.onPeerChange(this.peers)
    })

    pipe.on('data', (data) => this._onMessage(peer, data))

    // Se anuncia primero, sin esperar al otro: los dos lados hacen lo mismo y
    // el handshake no tiene turnos que puedan quedar trabados.
    this._send(peer, { type: 'manifest:announce', manifest: this.manifest() })
    this._sendStatus(peer)
  }

  _send(peer, msg) {
    try {
      peer.pipe.write(Buffer.from(JSON.stringify(msg)))
    } catch {
      // El peer se fue entre el check y el write. El 'close' del socket ya lo
      // va a limpiar; no hay nada que hacer aca.
    }
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

  _onMessage(peer, data) {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      // Basura en el canal: puede ser otra app en el mismo topic. Se ignora el
      // mensaje, no se mata la conexion -- todavia puede mandar algo valido.
      return
    }
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

    // chat:* se engancha en Fase 2-c/3 sobre este mismo canal.
    if (this.onMessage) this.onMessage(peer, msg)
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
    if (this.swarm) await this.swarm.destroy()
    this.peers.clear()
  }
}
