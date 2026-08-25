// El contador de consumo con corte. Fase 6.5 del ROADMAP_FASE7-X402.
//
// Lleva, por cuenta y por mes, cuanto se gasto y cuanto queda del tope. Es la
// mitad "sabe de saldos" de la fase; la que sabe de precios es costs.mjs.
//
// -----------------------------------------------------------------------------
// POR QUE RESERVA Y NO CONTABILIDAD
//
// R5.3 del ROADMAP: un tope que se aplica al facturar es un descuento, porque
// el gasto ya ocurrio y alguien lo pago. Para que sea un TOPE tiene que
// evaluarse antes de mandar el request.
//
// Pero antes del request no se sabe cuanto va a costar -- R3: el costo depende
// de los tokens generados, que no existen todavia. La salida a esa pinza es el
// patron de dos tiempos:
//
//   1. reserve()  se aparta la COTA SUPERIOR del costo (costs.estimar) y se
//                 persiste. Si no entra en lo que queda, se rechaza ACA y el
//                 request nunca sale.
//   2. settle()   termino el request: se cambia la reserva por el costo REAL
//                 (costs.real) y la diferencia vuelve al saldo.
//
// Entre los dos momentos el saldo esta comprometido, asi que dos requests
// simultaneos no pueden gastar los mismos dolares.
//
// -----------------------------------------------------------------------------
// POR QUE SE ESCRIBE AL RESERVAR Y NO AL LIQUIDAR
//
// Si solo se persistiera el gasto liquidado, un corte de luz en el medio de un
// request perderia ese consumo: el proceso vuelve, el contador no lo vio, y el
// tope deja pasar mas de lo acordado. Por eso la reserva se escribe a disco
// ANTES de que el request salga (write-ahead).
//
// Y al abrir, una reserva que quedo de una corrida anterior se cobra ENTERA,
// por el estimado, porque no hay forma de saber que costo en realidad. Eso
// cobra de mas y corta antes de tiempo. Es deliberado: el tope existe para
// proteger al que paga, asi que cuando hay que equivocarse, se hace del lado
// que gasta de menos.
// -----------------------------------------------------------------------------

import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { usdAMicros } from './costs.mjs'

// El tope por default, en la unidad de costs.mjs. USD 20 por cuenta y por mes.
export const TOPE_DEFAULT_MICROS = usdAMicros(20)

const VERSION = 1

let estado = null // { version, period, accounts, pending, history }
let archivo = null // ruta del JSON, o null si corre solo en memoria

// ---------------------------------------------------------------------------
// Periodo
// ---------------------------------------------------------------------------

// El mes calendario en UTC. UTC y no la hora local porque el corte tiene que
// caer en el mismo instante para todos los nodos de la red: con hora local,
// dos maquinas en husos distintos cierran el mes en momentos distintos y el
// reparto de fin de mes no cuadra.
export function periodoDe(now = Date.now()) {
  const d = new Date(now)
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mes}`
}

function estadoVacio(now) {
  return { version: VERSION, period: periodoDe(now), accounts: {}, pending: {}, history: [] }
}

// Se llama en CADA operacion, no con un timer. Un timer no corre si el proceso
// estuvo apagado todo el 1ro de mes, y entonces el primer request de febrero
// se cobraria contra el saldo de enero. Chequear al usar no puede llegar tarde.
function rotarSiCambioElMes(now) {
  const actual = periodoDe(now)
  if (estado.period === actual) return false

  // El periodo que cierra se guarda: es lo que alimenta el reparto de fin de
  // mes. Sin esto, el 1ro a las 00:00 UTC desaparece el mes que hay que
  // facturar.
  estado.history.unshift({
    period: estado.period,
    accounts: estado.accounts,
    closedAt: now
  })
  estado.history = estado.history.slice(0, 12)

  estado.period = actual
  // Los topes sobreviven al cambio de mes; el gasto no. Es la definicion de
  // "tope mensual".
  const topes = {}
  for (const [id, cuenta] of Object.entries(estado.accounts)) {
    topes[id] = { spent: 0, cap: cuenta.cap }
  }
  estado.accounts = topes
  estado.pending = {}
  return true
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

// Escritura atomica: se escribe un temporal y se renombra encima. Un
// writeFileSync directo que se corta a la mitad deja un JSON invalido, y este
// archivo es el que dice cuanta plata se gasto -- perderlo por un corte de luz
// significa que el tope arranca de cero en el peor momento posible.
function guardar() {
  if (!archivo) return
  const tmp = archivo + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2))
    fs.renameSync(tmp, archivo)
  } catch (err) {
    // No se tira el proceso: un nodo que no puede escribir el ledger igual
    // puede servir inferencia local, que es gratis. Pero se dice en voz alta,
    // porque cambia lo que el tope garantiza.
    console.error(`[budget] no se pudo guardar el ledger: ${(err && err.message) || err}`)
    console.error('[budget] el tope corre EN MEMORIA: se reinicia con el proceso')
    archivo = null
  }
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

// `dir` null => todo en memoria (tests, y el camino sin storage). Devuelve
// cuantas reservas huerfanas encontro, porque eso hay que loguearlo: son
// requests que salieron y nadie sabe como terminaron.
export function open(dir, { now = Date.now() } = {}) {
  archivo = dir ? path.join(dir, 'budget.json') : null
  estado = estadoVacio(now)

  if (archivo) {
    try {
      const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'))
      if (crudo && crudo.version === VERSION) {
        estado = {
          version: VERSION,
          period: typeof crudo.period === 'string' ? crudo.period : periodoDe(now),
          accounts: crudo.accounts && typeof crudo.accounts === 'object' ? crudo.accounts : {},
          pending: crudo.pending && typeof crudo.pending === 'object' ? crudo.pending : {},
          history: Array.isArray(crudo.history) ? crudo.history : []
        }
      } else if (crudo) {
        console.error(`[budget] ${archivo} es de otra version, se arranca de cero`)
      }
    } catch {
      // No existe todavia: primer arranque.
    }
  }

  // Reservas de una corrida anterior: se cobran enteras. Ver la nota del
  // encabezado -- no se puede saber que costaron, y el lado seguro es cobrar
  // el estimado.
  const huerfanas = Object.values(estado.pending)
  for (const r of huerfanas) {
    const cuenta = cuentaDe(r.account)
    cuenta.spent += r.micros
  }
  estado.pending = {}

  rotarSiCambioElMes(now)
  if (huerfanas.length) {
    console.error(
      `[budget] ${huerfanas.length} reserva(s) sin liquidar de una corrida anterior: se cobran por el estimado`
    )
    guardar()
  }
  return huerfanas.length
}

export function close() {
  if (estado) guardar()
  estado = null
  archivo = null
}

// Para los tests: memoria limpia, sin disco.
export function reset({ now = Date.now() } = {}) {
  archivo = null
  estado = estadoVacio(now)
}

function asegurarAbierto() {
  if (!estado) estado = estadoVacio(Date.now())
  return estado
}

function cuentaDe(accountId) {
  const s = asegurarAbierto()
  if (!s.accounts[accountId]) {
    s.accounts[accountId] = { spent: 0, cap: TOPE_DEFAULT_MICROS }
  }
  return s.accounts[accountId]
}

// ---------------------------------------------------------------------------
// Topes
// ---------------------------------------------------------------------------

export function setCap(accountId, micros) {
  const n = Math.floor(Number(micros))
  cuentaDe(accountId).cap = Number.isFinite(n) && n >= 0 ? n : 0
  guardar()
}

export function capOf(accountId) {
  return cuentaDe(accountId).cap
}

// Cuanto hay comprometido ahora mismo por requests en vuelo de esta cuenta.
function reservadoDe(accountId) {
  let total = 0
  for (const r of Object.values(asegurarAbierto().pending)) {
    if (r.account === accountId) total += r.micros
  }
  return total
}

export function usage(accountId, { now = Date.now() } = {}) {
  asegurarAbierto()
  if (rotarSiCambioElMes(now)) guardar()

  const cuenta = cuentaDe(accountId)
  const reserved = reservadoDe(accountId)
  return {
    period: estado.period,
    account: accountId,
    spent: cuenta.spent,
    reserved,
    cap: cuenta.cap,
    // Nunca negativo: si una reserva huerfana empujo el gasto por encima del
    // tope, lo que queda es cero, no una deuda.
    remaining: Math.max(0, cuenta.cap - cuenta.spent - reserved)
  }
}

// ---------------------------------------------------------------------------
// Reserva y liquidacion
// ---------------------------------------------------------------------------

// Devuelve { ok, id } o { ok:false, reason, ... }, no un booleano pelado ni una
// excepcion. Misma razon que verifyManifest en manifest.mjs: quien llama tiene
// que poder DECIRLE AL USUARIO por que no puede gastar, y "false" no se le
// explica a nadie.
export function reserve(accountId, micros, { now = Date.now() } = {}) {
  asegurarAbierto()
  if (rotarSiCambioElMes(now)) guardar()

  const monto = Math.max(0, Math.ceil(Number(micros) || 0))

  // Costo cero -- inferencia local o de un par -- no toca el ledger ni el
  // disco. Es el camino comun y tiene que ser gratis en todo sentido. Devuelve
  // una reserva valida igual, para que el gateway tenga UN solo flujo y no un
  // `if` alrededor de cada llamada.
  if (monto === 0) return { ok: true, id: null, micros: 0 }

  const estadoCuenta = usage(accountId, { now })
  if (monto > estadoCuenta.remaining) {
    return {
      ok: false,
      reason: 'presupuesto agotado',
      remaining: estadoCuenta.remaining,
      cap: estadoCuenta.cap,
      needed: monto
    }
  }

  const id = 'r_' + crypto.randomBytes(8).toString('hex')
  estado.pending[id] = { account: accountId, micros: monto, startedAt: now }
  guardar() // write-ahead: a disco ANTES de que el request salga
  return { ok: true, id, micros: monto }
}

// El request termino. `realMicros` es lo que costo de verdad; la diferencia
// contra la reserva vuelve al saldo.
//
// Se cobra el MENOR entre el real y lo reservado. Si el real salio mas caro que
// la cota superior, el error esta en la estimacion, no en el usuario: cobrarle
// mas de lo que se le aparto seria pasarse del tope por la ventana de atras,
// que es exactamente lo que esta fase existe para impedir.
export function settle(id, realMicros) {
  if (!id) return 0
  const s = asegurarAbierto()
  const r = s.pending[id]
  if (!r) return 0

  const real = Math.max(0, Math.ceil(Number(realMicros) || 0))
  const cobrado = Math.min(real, r.micros)

  cuentaDe(r.account).spent += cobrado
  delete s.pending[id]
  guardar()
  return cobrado
}

// El request no llego a gastar nada (fallo antes de salir, lo cancelaron). La
// reserva se libera entera.
export function release(id) {
  if (!id) return false
  const s = asegurarAbierto()
  if (!s.pending[id]) return false
  delete s.pending[id]
  guardar()
  return true
}

// ---------------------------------------------------------------------------
// Reparto
// ---------------------------------------------------------------------------

// El consumo atribuido por cuenta. Sin `period` devuelve el mes en curso; con
// un periodo cerrado, lo que quedo guardado en el historial.
//
// Es la respuesta al "entre todos los usuarios se dividen los tokens a fin de
// mes": el reparto no se calcula al final, se ACUMULA durante todo el mes, y
// esta funcion solo lo lee. Un reparto calculado al cierre sobre un log
// depende de que el log este completo; este numero es el mismo que corto.
export function report({ period = null, now = Date.now() } = {}) {
  asegurarAbierto()
  if (rotarSiCambioElMes(now)) guardar()

  let cuentas = estado.accounts
  let cual = estado.period
  if (period && period !== estado.period) {
    const viejo = estado.history.find((h) => h.period === period)
    if (!viejo) return { period, total: 0, accounts: [], found: false }
    cuentas = viejo.accounts
    cual = period
  }

  const filas = Object.entries(cuentas)
    .map(([account, c]) => ({ account, spent: c.spent, cap: c.cap }))
    .filter((f) => f.spent > 0)
    .sort((a, b) => b.spent - a.spent)

  return {
    period: cual,
    total: filas.reduce((acc, f) => acc + f.spent, 0),
    accounts: filas,
    found: true
  }
}

export function periodoActual() {
  return asegurarAbierto().period
}
