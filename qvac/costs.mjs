// Cuanto cuesta un request. Entra un uso, sale un numero entero.
//
// Es la mitad "sabe de precios" de la Fase 6.5; la otra mitad -- quien lleva
// el saldo y corta -- es budget.mjs. Estan separadas a proposito: el ledger no
// tiene por que saber cuanto sale un token, y la tabla de precios no tiene por
// que saber que existe una cuenta.
//
// No toca la red ni el disco, igual que manifest.mjs: entra un objeto, sale un
// numero. Por eso se puede testear sin dos maquinas, sin modelo cargado y sin
// una sola llamada a la API -- que es la razon por la que esta pieza va
// primero dentro de la fase.
//
// -----------------------------------------------------------------------------
// MICROS, NO FLOATS. Todo monto de este archivo -- y de budget.mjs -- es un
// ENTERO de micro-dolares: 1 USD = 1_000_000 micros. Nunca un float.
//
// El motivo es viejo y conocido: 0.1 + 0.2 !== 0.3 en punto flotante. Un tope
// de USD 20 acumulado en floats a lo largo de miles de requests deriva, y
// deriva JUSTO en el borde, que es el unico lugar donde el numero importa. Con
// enteros el tope se compara exacto y "gastado + este request <= tope" es una
// afirmacion verdadera o falsa, no una aproximacion.
// -----------------------------------------------------------------------------

export const MICROS_POR_USD = 1_000_000

// Precios de la API de Claude en micro-dolares por 1M de tokens, consultados
// el 2026-08-25.
//
// SE USA EL PRECIO ESTANDAR A PROPOSITO, NO EL PROMOCIONAL. Sonnet 5 tiene un
// precio introductorio (USD 2 / USD 10) que vence el 2026-08-31. Calibrar el
// tope con el precio promocional es el riesgo #8 del ROADMAP: el 1 de
// septiembre el costo por turno sube 50% solo, sin que nadie toque una linea,
// y un tope calibrado con el numero viejo deja pasar mas gasto del acordado.
//
// Usar el estandar mientras rige el promocional SOBREESTIMA el costo. Eso
// corta un poco antes de lo necesario, que es el lado correcto para
// equivocarse: el tope existe para proteger al que paga.
export const PRECIOS = {
  'claude-sonnet-5': { entrada: 3_000_000, salida: 15_000_000 },
  'claude-haiku-4-5': { entrada: 1_000_000, salida: 5_000_000 },
  'claude-opus-5': { entrada: 5_000_000, salida: 25_000_000 }
}

// El modelo externo por default. D19 lo deja como decision de negocio abierta
// (Sonnet 5 rinde ~1.480 turnos por el tope de USD 20; Haiku 4.5 rinde ~4.400),
// asi que vive en UNA constante y no repartido por el codigo.
export const MODELO_EXTERNO_DEFAULT = 'claude-sonnet-5'

// La inferencia local y la de un par de la red no cuestan dolares. Devolver
// cero explicito -- en vez de no llamar a esta funcion en esos caminos -- hace
// que el contador de consumo tenga UNA sola entrada para todos los targets, y
// que agregar el precio de la Fase 8 despues sea cambiar este archivo y nada
// mas.
const GRATIS = { entrada: 0, salida: 0 }

// Los precios de los upstreams NO pueden vivir en la tabla de arriba: que APIs
// usa este nodo lo decide el operador en su `upstreams.json`, y cada cuenta
// tiene su lista de modelos y su tarifa. Se registran al arrancar, desde la
// config, y quedan aca para que `estimar` y `real` no tengan que saber de
// donde salio el precio.
//
// Un modelo externo SIN precio declarado no entra a esta tabla, y por lo tanto
// `conocido()` da false y estima cero. Eso es deliberado y peligroso: un gasto
// que el contador no ve es un tope que no corta. Por eso el registro del
// upstream (bin.mjs) exige el precio para dejarlo online, en vez de dejar que
// esta tabla lo perdone.
const PRECIOS_EXTERNOS = new Map()

// `entrada`/`salida` en micro-dolares por 1M de tokens, la misma unidad que
// PRECIOS. Devuelve false si el precio no es utilizable: quien registra decide
// que hacer con eso, aca no se inventa una tarifa.
export function registrarPrecio(modelId, { entrada = 0, salida = 0 } = {}) {
  if (typeof modelId !== 'string' || modelId === '') return false
  const e = Number(entrada)
  const s = Number(salida)
  if (!Number.isFinite(e) || !Number.isFinite(s) || e < 0 || s < 0) return false
  if (e === 0 && s === 0) return false
  PRECIOS_EXTERNOS.set(modelId, { entrada: Math.ceil(e), salida: Math.ceil(s) })
  return true
}

// Para los tests y para un reinicio de config: la tabla externa es estado de
// proceso, no una constante.
export function olvidarPreciosExternos() {
  PRECIOS_EXTERNOS.clear()
}

export function precioDe(modelId) {
  return PRECIOS[modelId] || PRECIOS_EXTERNOS.get(modelId) || GRATIS
}

export function conocido(modelId) {
  return Object.prototype.hasOwnProperty.call(PRECIOS, modelId) || PRECIOS_EXTERNOS.has(modelId)
}

// Redondeo SIEMPRE hacia arriba. Un request que sale 0.4 micros se cobra 1: a
// lo largo de miles de requests el truncado hacia abajo acumula gasto que el
// contador no ve, y el tope se pasa por el lado que no se mide. Redondear
// hacia arriba se equivoca en contra nuestra, que es el unico lado seguro.
function porMillon(tokens, precioPorMillon) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.ceil((tokens * precioPorMillon) / 1_000_000)
}

// COTA SUPERIOR del costo de un request que todavia no se hizo.
//
// Se asume que el modelo va a generar `maxTokens` completos, aunque casi nunca
// lo haga. Es a proposito: esto alimenta la RESERVA (ver budget.mjs), y una
// reserva que se queda corta es un tope que se pasa. Se reserva el peor caso y
// despues se liquida el real; la diferencia vuelve al saldo.
//
// R3 del ROADMAP dice que el costo real se conoce despues de responder. Esta
// funcion es la respuesta a eso: no se adivina el costo, se acota.
export function estimar({ model, promptTokens = 0, maxTokens = 0 } = {}) {
  const precio = precioDe(model)
  return porMillon(promptTokens, precio.entrada) + porMillon(maxTokens, precio.salida)
}

// Costo REAL, con los tokens que efectivamente se generaron. Es lo que se
// liquida contra la reserva.
export function real({ model, promptTokens = 0, completionTokens = 0 } = {}) {
  const precio = precioDe(model)
  return porMillon(promptTokens, precio.entrada) + porMillon(completionTokens, precio.salida)
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

// Para el panel y los logs. Cuatro decimales porque un turno tipico sale
// USD 0,0135: con dos decimales todos los requests valdrian "USD 0,01" y el
// numero dejaria de distinguir un chat corto de uno largo.
export function formatUSD(micros) {
  const usd = (Number(micros) || 0) / MICROS_POR_USD
  return `USD ${usd.toFixed(4)}`
}

// USD -> micros, para leer topes escritos por una persona ("20", "0.10").
// Redondea hacia abajo: un tope de 20 son 20_000_000 micros exactos, y si
// alguien escribe un tope con mas precision que un micro, el tope efectivo es
// el menor. Un tope nunca se redondea para arriba.
export function usdAMicros(usd) {
  const n = Number(usd)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n * MICROS_POR_USD)
}
