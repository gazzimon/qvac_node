// Registro en memoria de API keys para consumir el gateway desde AFUERA del
// panel: tu propia terminal, OpenClaw (Telegram/WhatsApp), Hermes Agent, Open
// WebUI, o cualquier cliente OpenAI-compatible.
//
// PERSISTE, y desde la Fase 6.5 eso NO es una comodidad: es la condicion para
// que el tope de gasto exista.
//
// El ledger le imputa el consumo a la cuenta, y la cuenta ES la key
// (gateway.mjs, `cuentaDe`). Con el registro en memoria ese id no sobrevivia al
// proceso: el cliente reconectaba, le daban una key nueva, y arrancaba con el
// tope entero otra vez -- mientras `budget.json` acumulaba cuentas huerfanas que
// nadie iba a reclamar. Un tope que se limpia reiniciando no es un tope.
//
// Y arregla algo que no era un bug declarado pero se sentia como uno: cada
// reinicio del nodo invalidaba la configuracion de TODOS los clientes -- el bot
// de Telegram, Open WebUI, la terminal-, que tenian que ir a buscar una key
// nueva al panel.
//
// LA KEY SE GUARDA EN CLARO, y es una decision, no un descuido. El mismo
// directorio ya guarda la semilla de red en claro (identity.mjs), el gateway
// escucha solo en 127.0.0.1, y el panel existe justamente para poder volver a
// copiar una key semanas despues (ver `listKeysFull`). Hashearla obligaria a
// rotar la credencial cada vez que alguien no la guardo, que para este modelo de
// amenaza es peor. La que NO puede ir en claro es la semilla de la wallet: esa
// es D13 y es otra cosa.
//
// El azar SI es criptografico: hypercore-crypto ya esta en el arbol de
// dependencias (lo usa swarm.mjs para la identidad del nodo), asi que no hay
// excusa para Math.random en algo que despues viaja como credencial en un
// header Authorization.

import crypto from 'hypercore-crypto'
import fs from 'bare-fs'
import path from 'bare-path'

// Sube cuando cambie la forma de una fila. Un archivo de otra version se
// descarta entero y se avisa, en vez de cargar filas a medias.
const VERSION = 1

const keys = new Map() // id -> { id, key, label, nodeId, createdAt, lastUsedAt }

// base64url sobre bytes aleatorios reales. Se evitan +/= para que la key se
// pueda pegar en una URL, en un YAML o en un JSON5 sin escaparla.
function randomToken(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

// `null` => todo en memoria. Es el camino de los tests y el de un nodo sin
// directorio de storage.
let archivo = null

// Escritura atomica, igual que budget.mjs: temporal y rename encima. Un
// writeFileSync cortado a la mitad deja un JSON invalido, y perder este archivo
// es perder la identidad de las cuentas -- o sea, resetear todos los topes.
function guardar() {
  if (!archivo) return
  const tmp = archivo + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, keys: [...keys.values()] }, null, 2), {
      // Solo el dueno. En Windows no hace nada (el modo se ignora), pero el
      // archivo queda igual bajo %LOCALAPPDATA% del usuario.
      mode: 0o600
    })
    fs.renameSync(tmp, archivo)
  } catch (err) {
    console.error(`[apikeys] no se pudo guardar el registro: ${(err && err.message) || err}`)
    console.error('[apikeys] las keys corren EN MEMORIA: el tope de gasto se reinicia con el proceso')
    archivo = null
  }
}

// Se abre ANTES que el gateway, por la misma razon que el ledger: una key que
// llega antes de que el registro este cargado seria una key desconocida.
export function open(dir) {
  archivo = dir ? path.join(dir, 'apikeys.json') : null
  keys.clear()
  if (!archivo) return 0

  try {
    const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'))
    if (!crudo || crudo.version !== VERSION) {
      if (crudo) console.error(`[apikeys] ${archivo} es de otra version, se arranca de cero`)
      return 0
    }
    for (const e of Array.isArray(crudo.keys) ? crudo.keys : []) {
      // Una fila sin id o sin key no se puede usar para nada y romperia
      // `verifyKey`, que compara longitudes.
      if (!e || typeof e.id !== 'string' || typeof e.key !== 'string') continue
      keys.set(e.id, {
        id: e.id,
        key: e.key,
        label: typeof e.label === 'string' ? e.label : 'unnamed',
        nodeId: typeof e.nodeId === 'string' ? e.nodeId : null,
        createdAt: Number(e.createdAt) || Date.now(),
        lastUsedAt: Number(e.lastUsedAt) || null
      })
    }
  } catch {
    // No existe todavia: primer arranque.
  }
  return keys.size
}

// Persiste el `lastUsedAt` acumulado. `verifyKey` lo toca en CADA request y no
// guarda: un fsync por request para escribir una marca de tiempo cosmetica
// seria pagar latencia de disco en el camino caliente. La cuenta y el tope no
// dependen de ese campo -- dependen del id, que solo cambia al crear o revocar,
// y esos si guardan al toque.
export function close() {
  guardar()
  archivo = null
}

export function createKey({ label = 'unnamed', nodeId = null } = {}) {
  const id = randomToken(6)
  const key = `qvac_sk_${randomToken(24)}`
  const entry = { id, key, label, nodeId, createdAt: Date.now(), lastUsedAt: null }
  keys.set(id, entry)
  guardar()
  return entry
}

// Una key por nodo: apretar "Conectar" dos veces sobre la misma tarjeta tiene
// que devolver la MISMA credencial, no llenar el registro de keys huerfanas
// que el usuario ya pego en un config y no puede distinguir.
export function keyForNode(nodeId, label) {
  for (const entry of keys.values()) {
    if (entry.nodeId === nodeId) return entry
  }
  return createKey({ label, nodeId })
}

function mask(entry) {
  return {
    id: entry.id,
    label: entry.label,
    nodeId: entry.nodeId,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    preview: entry.key.slice(0, 12) + '…' + entry.key.slice(-4)
  }
}

export function listKeys() {
  return [...keys.values()].map(mask)
}

// Igual que listKeys pero con la credencial en claro.
//
// Solo para el panel local: el gateway escucha unicamente en 127.0.0.1 y el
// sentido de esa pantalla es poder volver a copiar una key en la config de un
// bot semanas despues. Enmascararla ahi obligaria a rotarla cada vez que uno
// se olvida de guardarla, que es peor que mostrarla en una pagina que solo se
// alcanza desde esta maquina. `mask()` sigue existiendo para cualquier
// consumidor que no sea local.
export function listKeysFull() {
  return [...keys.values()].map((e) => ({
    id: e.id,
    label: e.label,
    key: e.key,
    createdAt: e.createdAt,
    lastUsedAt: e.lastUsedAt
  }))
}

export function count() {
  return keys.size
}

export function revokeKey(id) {
  const habia = keys.delete(id)
  if (habia) guardar()
  return habia
}

// Comparacion en tiempo constante. Una key es una credencial y `===` corta en
// el primer byte distinto, o sea que el tiempo filtra el prefijo. Con pocas
// keys en memoria el riesgo es teorico, pero hacerlo bien cuesta seis lineas.
// (hypercore-crypto NO exporta constantTimeEqual -sus exports son keyPair,
// sign, verify, data, hash, randomBytes...-, asi que se hace a mano.)
function equalConstantTime(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function verifyKey(rawKey) {
  if (!rawKey) return null
  for (const entry of keys.values()) {
    if (equalConstantTime(entry.key, rawKey)) {
      entry.lastUsedAt = Date.now()
      return entry
    }
  }
  return null
}

// Devuelve cuantas revoco. Sin ese numero la UI solo podia decir "se revoco la
// key actual", que es mentira cuando hay varias emitidas.
export function reset() {
  const n = keys.size
  keys.clear()
  guardar()
  return n
}
