// Chat P2P minimo entre dos maquinas, sobre Hyperswarm + FramedStream.
//
// Es la version acotada de Fase 2/3 del ROADMAP_FASE2-6.md: implementa la
// decision D1 (FramedStream sobre Hyperswarm, no HTTP a localhost) y el DoD
// de Fase 3 ("un curl con stream:true devuelve tokens desde otro nodo").
//
// A proposito NO implementa todavia:
//   - D2 (manifiesto firmado Ed25519) — no hay verificacion de identidad.
//   - D3/D4 (deteccion de caida a mitad de stream + reintento en otro nodo)
//     — con un solo proveedor por topic no hay a donde reintentar.
//   - D6 (node:status / eleccion por carga) — mismo motivo.
// Sirve para probar que el TRANSPORTE real funciona entre dos maquinas
// distintas; el resto del roadmap se suma despues sin tocar este canal.

import Hyperswarm from 'hyperswarm'
import FramedStream from 'framed-stream'
import crypto from 'hypercore-crypto'

// Topic fijo y publico -no es secreto, es un punto de encuentro-, mismo
// criterio que ya usa el updater OTA (workers/main.js) para su propio topic.
export const TOPIC = crypto.hash(Buffer.from('qvac-node/p2p-chat/v0'))

function send(pipe, message) {
  pipe.write(JSON.stringify(message))
}

// ---------------------------------------------------------------------------
// Lado proveedor: escucha requests y responde con inferencia real.
// ---------------------------------------------------------------------------

export async function startProvider({ gpuLayers, onLog = () => {} } = {}) {
  const engineMod = await import('./engine.mjs')
  let modelId = null
  let loading = null

  function ensureModel() {
    if (modelId) return Promise.resolve(modelId)
    if (!loading) {
      loading = (async () => {
        const { modelSrc } = await engineMod.resolveModel('llama1b')
        modelId = await engineMod.loadModel({ modelSrc, gpuLayers })
        return modelId
      })()
      // Igual criterio que gateway.mjs: si la carga falla, no se cachea el
      // rechazo -si no, un timeout del registry deja el proveedor muerto para
      // toda la sesion sin reiniciar el proceso.
      loading.catch(() => {
        loading = null
      })
    }
    return loading
  }

  const swarm = new Hyperswarm()

  swarm.on('connection', (connection, info) => {
    const pipe = new FramedStream(connection)
    onLog(`peer conectado: ${info.publicKey.toString('hex').slice(0, 12)}…`)

    pipe.on('data', async (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type !== 'chat:request') return

      const { requestId, prompt } = msg
      try {
        const mid = await ensureModel()
        for await (const delta of engineMod.complete({ modelId: mid, prompt })) {
          send(pipe, { type: 'chat:chunk', requestId, delta })
        }
        send(pipe, { type: 'chat:done', requestId })
      } catch (err) {
        send(pipe, { type: 'chat:error', requestId, message: String((err && err.message) || err) })
      }
    })

    // Un peer que se cae no tumba al proveedor -sigue escuchando al resto.
    pipe.on('error', () => {})
  })

  swarm.join(TOPIC, { client: false, server: true })
  await swarm.flush()

  return {
    async close() {
      await swarm.destroy()
      if (modelId) await engineMod.shutdown(modelId)
    }
  }
}

// ---------------------------------------------------------------------------
// Lado cliente: se conecta al primer peer del topic y manda un prompt.
// ---------------------------------------------------------------------------

export async function askFirstPeer(prompt, { onChunk = () => {}, timeoutMs = 30000 } = {}) {
  const swarm = new Hyperswarm()
  swarm.join(TOPIC, { client: true, server: false })

  const pipe = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      swarm.destroy()
      reject(new Error(`no aparecio ningun proveedor en el topic en ${timeoutMs}ms`))
    }, timeoutMs)

    swarm.once('connection', (connection) => {
      clearTimeout(timer)
      resolve(new FramedStream(connection))
    })
  })

  const requestId = crypto.randomBytes(8).toString('hex')

  return new Promise((resolve, reject) => {
    let full = ''

    function cleanup() {
      pipe.destroy()
      swarm.destroy()
    }

    pipe.on('data', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.requestId !== requestId) return

      if (msg.type === 'chat:chunk') {
        full += msg.delta
        onChunk(msg.delta)
      } else if (msg.type === 'chat:done') {
        cleanup()
        resolve(full)
      } else if (msg.type === 'chat:error') {
        cleanup()
        reject(new Error(msg.message))
      }
    })

    pipe.on('error', (err) => {
      cleanup()
      reject(err)
    })

    send(pipe, { type: 'chat:request', requestId, prompt })
  })
}
