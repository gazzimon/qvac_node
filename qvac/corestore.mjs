// El Corestore del nodo: UN solo almacen de hypercores para todo el proceso.
//
// Todo lo que persiste o replica (el directorio Hyperbee, el Hyperdrive de
// archivos, y lo que venga despues) sale de aca. No es una comodidad: el
// almacen toma un lock de RocksDB sobre su directorio, y dos Corestore
// apuntando al mismo path fallan al abrir el segundo. Un unico punto de
// apertura hace que ese error no pueda existir.
//
// Ademas, un solo store significa una sola replicacion por socket: cuando
// `swarm.mjs` hace `store.replicate(socket)`, ese unico stream sirve el
// directorio Y los drives, multiplexados por Protomux junto al canal de chat.
// Ver la nota de channel.mjs sobre por que el orden de apertura importa.

import Corestore from 'corestore'
import path from 'bare-path'

let store = null
let opening = null

export function corestoreDir(dir) {
  return path.join(dir, 'corestore')
}

// Idempotente Y segura contra concurrencia: dos llamadas simultaneas antes de
// que la primera termine de abrir tienen que devolver el MISMO store, no dos.
// Con `await` de por medio, un `if (store)` solo no alcanza.
export async function openStore(dir) {
  if (store) return store
  if (opening) return opening

  // La promesa se guarda en `opening` ANTES del primer await: si se guardara
  // despues, dos llamadas concurrentes construirian dos Corestore sobre el
  // mismo path y la segunda moriria contra el lock de RocksDB.
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

// Para los caminos que ya saben que esta abierto (no hace falta await).
export function getStore() {
  return store
}

export async function closeStore() {
  const s = store
  store = null
  opening = null
  if (s) await s.close()
}
