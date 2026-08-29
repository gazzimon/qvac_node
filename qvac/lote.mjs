// Fase 10 — recibos y lote.
//
// -----------------------------------------------------------------------------
// QUE ES UN RECIBO, Y POR QUE LA FIRMA EIP-3009 YA LO ES
//
// La Fase 9 verifica un pago sincrónico, sirve, y liquida DESPUES (D12). Un
// recibo acá es exactamente ese pago verificado con el settlement DIFERIDO: la
// autorización EIP-3009 que el cliente firmó es una orden de transferencia
// off-chain que no obliga a liquidar en el momento. Guardarla y liquidarla más
// tarde —de a muchas— es el mismo flujo de la Fase 9, no un mecanismo nuevo.
//
// Esto es lo que mata la Fase 6: con liquidación on-chain diferida no hace falta
// un ledger multi-escritor propio. El ledger de verdad es la cadena.
//
// -----------------------------------------------------------------------------
// EL LOTE: UNA RED, UNA WALLET
//
// Un lote agrupa recibos que van al MISMO `payTo` en la MISMA red, porque eso es
// lo que se puede liquidar recorriendo `x402.liquidar()` una vez por entrada
// contra un solo facilitator. Mezclar redes o destinos en un lote sería un
// artefacto que no se puede procesar de una sola forma.
//
// El lote va firmado con la WALLET (no con la clave de red), mismo criterio que
// `atestacion.mjs` y que `manifest-v0.json:84`: la Ed25519 dice "este nodo es
// este nodo", la wallet dice "a esta dirección le pagan". Un lote es una
// afirmación sobre cobros, así que pertenece a la segunda.
//
// -----------------------------------------------------------------------------
// LOS BYTES QUE SE FIRMAN
//
// JCS (RFC 8785) del lote SIN `signature`, con la MISMA función de
// canonicalización que el manifiesto y la atestación — la única forma de que no
// puedan divergir al firmar y al verificar. Encima, un personal_sign EIP-191 con
// la clave de la wallet (`account.sign` de WDK), que se recupera con
// `recoverMessageAddress`. No es EIP-712: acá no hay un dominio de contrato, hay
// un documento canónico.
//
// La clave de idempotencia de cada recibo es el `nonce` de la autorización
// EIP-3009 (D20): el mismo nonce liquidado dos veces cobra UNA sola vez, del
// lado del token. Por eso el acumulador se indexa por nonce y `marcarLiquidados`
// habla en nonces.

import fs from 'bare-fs'
import path from 'bare-path'
import { canonicalize } from './manifest.mjs'
import { hashDe } from './atestacion.mjs'
import * as x402 from './x402.mjs'

// Sube cuando cambie la FORMA del recibo o del lote. Un verificador de otra
// versión no tiene que adivinar si le falta un campo o si el que lee significa
// otra cosa.
export const VERSION = 1

// -----------------------------------------------------------------------------
// El recibo
// -----------------------------------------------------------------------------

const es0x = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]+$/.test(s)

// Un pago verificado con el settlement diferido. El orden en que se escriben las
// claves acá no significa nada: JCS las ordena.
//
// `requirements` es la entrada de `accepts[]` TAL CUAL se ofreció en el 402
// (`x402.entradaAccepts`). Se guarda entera porque es contra ESOS números que
// hay que liquidar: recalcularla al liquidar es liquidar contra otro monto que
// el que el cliente firmó.
export function construirRecibo({
  requestId,
  ts = Date.now(),
  red,
  network,
  asset,
  assetName,
  assetVersion,
  payTo,
  payer,
  amount,
  authorization,
  signature,
  requirements = null,
  atestacion = null,
  liquidacion = null
}) {
  if (!requestId) throw new Error('lote: el recibo no tiene requestId')
  if (!network) throw new Error('lote: el recibo no tiene network (CAIP-2)')
  if (!es0x(payTo)) throw new Error('lote: el recibo no tiene un payTo EVM')
  if (!authorization || typeof authorization !== 'object') {
    throw new Error('lote: el recibo no tiene la autorizacion EIP-3009')
  }
  if (!authorization.nonce) throw new Error('lote: la autorizacion no tiene nonce')
  if (!es0x(signature)) throw new Error('lote: el recibo no tiene una firma EIP-3009')

  // El monto que efectivamente se transfiere es el `value` de la autorización
  // (pagar de más es del pagador). Si no vino, el mínimo que se pidió.
  const bruto = amount != null ? amount : requirements && requirements.amount
  let monto
  try {
    monto = BigInt(bruto).toString()
  } catch {
    throw new Error(`lote: el monto del recibo no es un entero: ${bruto}`)
  }

  return {
    v: VERSION,
    requestId,
    ts,
    // Nombre corto (para agrupar y loguear) y CAIP-2 (lo que se firma).
    red: red || null,
    network,
    asset: asset || (requirements && requirements.asset) || null,
    // El dominio EIP-712 con el que se firmó la autorización. Sin esto un
    // tercero no puede recuperar al firmante del recibo.
    assetName: assetName || (requirements && requirements.extra && requirements.extra.name) || null,
    assetVersion:
      assetVersion || (requirements && requirements.extra && requirements.extra.version) || null,
    payTo,
    payer: payer || authorization.from || null,
    amount: monto,
    nonce: authorization.nonce,
    authorization,
    signature,
    requirements,
    // La atestación de D24, firmada con la wallet de quien sirvió. Puede faltar
    // (par, sin firmante): entonces el recibo prueba el pago y no el trabajo.
    attestation: atestacion || null,
    // El resultado de la liquidación inmediata de la Fase 9, si la hubo. `null`
    // o `{ success:false }` es un recibo que todavía se debe: es lo que
    // `liquidarLote` reintenta.
    liquidacion: liquidacion || null
  }
}

// La clave con la que el recibo se deduplica y se marca liquidado.
export function claveDe(recibo) {
  return recibo && recibo.nonce
}

// -----------------------------------------------------------------------------
// El lote
// -----------------------------------------------------------------------------

function mismoDestino(recibos) {
  const red = recibos[0].network
  const payTo = String(recibos[0].payTo).toLowerCase()
  for (const r of recibos) {
    if (r.network !== red) {
      throw new Error(`lote: un recibo es de la red ${r.network} y el lote es de la red ${red}`)
    }
    if (String(r.payTo).toLowerCase() !== payTo) {
      throw new Error('lote: un recibo paga a otra wallet que el resto del lote')
    }
  }
}

function sumar(recibos) {
  let total = 0n
  for (const r of recibos) total += BigInt(r.amount)
  return total.toString()
}

// El lote SIN firmar. Se separa de `firmarLote` para que los tests puedan mirar
// la forma sin necesitar una wallet.
export function construirLote({ recibos, ts = Date.now() }) {
  if (!Array.isArray(recibos) || recibos.length === 0) {
    throw new Error('lote: no hay recibos que agrupar')
  }

  // De-dup por nonce: el mismo recibo dos veces es uno. Dos recibos DISTINTOS
  // con el mismo nonce es un error de programa —el nonce es la clave de
  // idempotencia— y se corta en vez de elegir uno.
  const porNonce = new Map()
  for (const r of recibos) {
    const k = claveDe(r)
    const previo = porNonce.get(k)
    if (previo && canonicalize(previo) !== canonicalize(r)) {
      throw new Error(`lote: dos recibos distintos con el mismo nonce ${k}`)
    }
    porNonce.set(k, r)
  }
  const unicos = [...porNonce.values()]
  mismoDestino(unicos)

  const nonces = [...porNonce.keys()].sort()
  return {
    v: VERSION,
    ts,
    red: unicos[0].red || null,
    network: unicos[0].network,
    payTo: unicos[0].payTo,
    count: unicos.length,
    totalAmount: sumar(unicos),
    nonces,
    // En el orden de `nonces` para que dos lotes con los mismos recibos armados
    // en distinto orden canonicalicen igual.
    recibos: nonces.map((n) => porNonce.get(n))
  }
}

// Los bytes que se firman: el lote canonicalizado SIN `signature`. Misma función
// al firmar y al verificar.
function bytesFirmados(lote) {
  const { signature, ...resto } = lote // eslint-disable-line no-unused-vars
  return canonicalize(resto)
}

// Un identificador estable del lote (hash del contenido sin firma). Para logs y
// para que dos puntas hablen del mismo lote sin mandarlo entero.
export function idDeLote(lote) {
  return hashDe(bytesFirmados(lote))
}

// Firma con la wallet. `firmarMensaje` es la función que inyecta bin.mjs y que
// envuelve `account.sign` de WDK: acá no entra ninguna seed.
//
// No tira si la firma falla: devuelve null y que el llamador decida. Un lote sin
// firmar NO se emite — un artefacto que parece una prueba y no lo es es peor que
// uno ausente.
export async function firmarLote(lote, firmarMensaje) {
  if (typeof firmarMensaje !== 'function') return null
  try {
    const signature = await firmarMensaje(bytesFirmados(lote))
    if (typeof signature !== 'string' || !signature.startsWith('0x')) return null
    return { ...lote, signature }
  } catch (err) {
    console.error(`[lote] no se pudo firmar: ${(err && err.message) || err}`)
    return null
  }
}

// Verifica el lote entero: la firma de la wallet sobre el contenido, la
// homogeneidad de red/destino, el total, y —recibo por recibo— que la
// autorización EIP-3009 recupere a quien dice pagar.
//
// Devuelve `{ ok, reason, firmante, recibosMal }` y no un booleano: hay que
// poder loguear POR QUE se descartó.
export async function verificarLote(lote) {
  if (!lote || typeof lote !== 'object') return { ok: false, reason: 'el lote no es un objeto' }
  if (lote.v !== VERSION) return { ok: false, reason: `version ${lote.v} desconocida` }
  if (typeof lote.signature !== 'string' || !lote.signature.startsWith('0x')) {
    return { ok: false, reason: 'falta la firma del lote o no es una firma EVM' }
  }
  if (!Array.isArray(lote.recibos) || lote.recibos.length === 0) {
    return { ok: false, reason: 'el lote no tiene recibos' }
  }

  // ANTES de `import('viem')`: `cargar()` instala el polyfill de TextEncoder que
  // viem usa al evaluarse. Sin esto, un `verificar-lote` suelto —sin nadie que
  // haya cargado WDK antes en el proceso— muere con un ReferenceError que no
  // menciona viem. Ver el encabezado de x402.mjs.
  const { evm } = await x402.cargar()
  const viem = await import('viem')

  let firmante
  try {
    firmante = await viem.recoverMessageAddress({
      message: bytesFirmados(lote),
      signature: lote.signature
    })
  } catch (err) {
    return {
      ok: false,
      reason: `no se pudo recuperar al firmante del lote: ${(err && err.message) || err}`
    }
  }

  try {
    mismoDestino(lote.recibos)
  } catch (err) {
    return { ok: false, reason: err.message, firmante }
  }

  if (sumar(lote.recibos) !== String(lote.totalAmount)) {
    return { ok: false, reason: 'el totalAmount no es la suma de los recibos', firmante }
  }
  if (lote.count !== lote.recibos.length) {
    return { ok: false, reason: 'el count no coincide con la cantidad de recibos', firmante }
  }

  // `authorizationTypes` sale del paquete, no se copia acá.
  const recibosMal = []
  for (const r of lote.recibos) {
    const motivo = await verificarAutorizacion(r, viem, evm)
    if (motivo) recibosMal.push({ nonce: r.nonce, reason: motivo })
  }

  return {
    ok: recibosMal.length === 0,
    reason:
      recibosMal.length === 0 ? null : `${recibosMal.length} recibo(s) con la autorizacion mal`,
    firmante,
    recibosMal
  }
}

// Que la firma EIP-3009 del recibo recupere a `authorization.from`. Es el mismo
// `recoverTypedDataAddress` que `x402.verificarPago` hace en vivo, contra el
// dominio EIP-712 que el recibo guarda.
async function verificarAutorizacion(recibo, viem, evm) {
  const a = recibo.authorization
  if (!a || !recibo.signature) return 'no trae authorization y signature'
  if (!recibo.assetName || !recibo.asset) return 'no trae el dominio EIP-712 (assetName/asset)'

  const chainId = Number(String(recibo.network).split(':')[1])
  if (!Number.isFinite(chainId)) return `network sin chainId: ${recibo.network}`

  let firmante
  try {
    firmante = await viem.recoverTypedDataAddress({
      domain: {
        name: recibo.assetName,
        version: recibo.assetVersion || '1',
        chainId,
        verifyingContract: recibo.asset
      },
      types: evm.authorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from,
        to: a.to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce
      },
      signature: recibo.signature
    })
  } catch (err) {
    return `no se pudo recuperar al firmante: ${(err && err.message) || err}`
  }

  if (firmante.toLowerCase() !== String(a.from || '').toLowerCase()) {
    return `la firma es de ${firmante} y la autorizacion dice pagar desde ${a.from}`
  }
  if (String(a.to || '').toLowerCase() !== String(recibo.payTo || '').toLowerCase()) {
    return 'la autorizacion paga a otra direccion que el payTo del recibo'
  }
  return null
}

// -----------------------------------------------------------------------------
// La liquidación diferida
// -----------------------------------------------------------------------------

// Cómo se clasifica cada resultado de `x402.liquidar()` al procesar un lote.
// Con D9 cobrando un tope fijo casi no importaba; acá SÍ, porque el lote liquida
// solo y estos motivos piden acciones incompatibles (ver 0-quinquies, punto 1
// de la revisión del Bloque 0):
//
//   liquidado     éxito, o `nonce_already_used` — que es un reintento ya
//                 cobrado del lado del token: idempotente, se da por bueno.
//   saldo         `insufficient_balance` — es del otro lado, no se reintenta.
//   firma         `invalid_signature` — no es contabilidad, es reputación.
//   reintentable  cualquier otra cosa: se deja en el lote para la próxima.
function clasificar(res) {
  if (res && res.success) return 'liquidado'
  const motivo = String((res && (res.errorReason || res.errorMessage)) || '').toLowerCase()
  if (/nonce.*(already|used)|already.*used/.test(motivo)) return 'liquidado'
  if (/insufficient|balance|fondos|saldo/.test(motivo)) return 'saldo'
  if (/signature|firma|invalid.*sig/.test(motivo)) return 'firma'
  return 'reintentable'
}

// Recorre el lote llamando a `liquidar` una vez por recibo. `liquidar` es
// `x402.liquidar` (inyectada para no acoplar este módulo al stack que corre bajo
// Bare, igual que `atestacion.firmar` recibe la función que firma).
//
// NO toca el acumulador: devuelve qué nonces quedaron liquidados y el llamador
// decide con `marcarLiquidados`. Así un corte en el medio no deja el acumulador
// en un estado a medias que nadie sabe leer.
export async function liquidarLote({ lote, liquidar }) {
  if (!lote || !Array.isArray(lote.recibos)) throw new Error('lote: no hay recibos que liquidar')
  if (typeof liquidar !== 'function') throw new Error('lote: falta la funcion liquidar')

  const liquidados = []
  const fallidos = []
  const detalle = []

  for (const r of lote.recibos) {
    let res
    try {
      res = await liquidar({
        pago: { autorizacion: r.authorization, firma: r.signature, requisito: r.requirements },
        requisito: r.requirements
      })
    } catch (err) {
      res = {
        success: false,
        errorReason: 'settlement_failed',
        errorMessage: (err && err.message) || String(err)
      }
    }
    const clase = clasificar(res)
    detalle.push({
      nonce: r.nonce,
      clase,
      transaction: res && res.transaction,
      motivo: res && (res.errorReason || res.errorMessage)
    })
    if (clase === 'liquidado') liquidados.push(r.nonce)
    else
      fallidos.push({ nonce: r.nonce, clase, motivo: res && (res.errorReason || res.errorMessage) })
  }

  return { liquidados, fallidos, detalle }
}

// -----------------------------------------------------------------------------
// El acumulador (memoria del proceso, no un ledger)
// -----------------------------------------------------------------------------

// Igual que el Map `recibos` del gateway: esto NO es el ledger —el ledger es la
// cadena— sino la serie de recibos que este nodo todavía puede juntar en un
// lote. Se poda al agregar, no con un timer.
const MAX_PENDIENTES = 500
const _pend = new Map() // nonce -> recibo

// -----------------------------------------------------------------------------
// Persistencia del acumulador (FASE 10)
// -----------------------------------------------------------------------------
//
// `_pend` es memoria del proceso, y hasta acá un corte entre "servido/verificado"
// y "liquidado" regalaba el trabajo: la autorización EIP-3009 estaba firmada y en
// ningún disco. Se espeja a un JSONL —una línea JSON por recibo— con el MISMO
// patrón de escritura atómica que `apikeys.mjs` y `budget.mjs`: temporal y
// `rename` encima, porque un `writeFileSync` cortado a la mitad deja un archivo
// que no parsea y perder este es perder cobros firmados.
//
// El archivo vive en el dir PERSISTENTE (no en `budgetDir`, que bajo `bare` es
// temp —D30.1—): lo abre `bin.mjs` con `abrir()`, antes del gateway, por la misma
// razón que el ledger y las API keys. `null` => todo en memoria, que es el camino
// de los tests y el de un nodo sin storage.
const ARCHIVO = 'lote-pendientes.jsonl'

// Cuántos recibos SIN liquidar disparan un flush por tamaño. Un nodo con tráfico
// no espera al timer ni al apagado para juntar el lote.
const FLUSH_POR_TAMANO = 50

// Cada cuánto se intenta un flush aunque no se llegue al umbral. Va MUY por
// debajo de los `maxTimeoutSeconds` del 402 (300s por defecto): una autorización
// EIP-3009 vencida no se puede liquidar, así que diferir de más es perder el
// cobro. Ese es el límite honesto del modo `batch-receipts` y está anotado en el
// roadmap.
const FLUSH_INTERVALO_MS = 90_000

let _archivo = null
let _firmar = null
let _liquidar = null
let _timer = null
let _flushEnCurso = null
let _umbral = FLUSH_POR_TAMANO

// Escritura atómica del acumulador entero. Igual que `apikeys.guardar`: si falla,
// se avisa fuerte y se sigue EN MEMORIA —un corte ahí sí pierde el recibo, y eso
// tiene que verse, no tragarse.
function persistir() {
  if (!_archivo) return
  const tmp = _archivo + '.tmp'
  try {
    const lineas = [..._pend.values()].map((r) => JSON.stringify(r)).join('\n')
    fs.writeFileSync(tmp, lineas ? lineas + '\n' : '', { mode: 0o600 })
    fs.renameSync(tmp, _archivo)
  } catch (err) {
    console.error(`[lote] no se pudo persistir el acumulador: ${(err && err.message) || err}`)
    console.error(
      '[lote] los pendientes corren EN MEMORIA: un corte entre servir y liquidar los pierde'
    )
    _archivo = null
  }
}

// Abre el acumulador contra `dir` y le inyecta con qué firmar y liquidar el
// lote. Carga lo que haya quedado de una corrida anterior —una línea corrupta se
// saltea, no se lleva puesto el resto— y arma el timer del flush periódico.
// Devuelve cuántos recibos se recuperaron.
export function abrir(
  dir,
  {
    firmar = null,
    liquidar = null,
    intervaloMs = FLUSH_INTERVALO_MS,
    umbral = FLUSH_POR_TAMANO
  } = {}
) {
  _archivo = dir ? path.join(dir, ARCHIVO) : null
  _firmar = typeof firmar === 'function' ? firmar : null
  _liquidar = typeof liquidar === 'function' ? liquidar : null
  _umbral = Number.isFinite(umbral) && umbral > 0 ? umbral : FLUSH_POR_TAMANO
  _pend.clear()

  if (_archivo) {
    try {
      for (const linea of fs.readFileSync(_archivo, 'utf8').split('\n')) {
        if (!linea.trim()) continue
        try {
          const r = JSON.parse(linea)
          const k = claveDe(r)
          if (k) _pend.set(k, r)
        } catch {
          // Una línea que no parsea es una que se corrompió al escribirse; el
          // resto del archivo sigue siendo bueno.
        }
      }
    } catch {
      // No existe todavía: primer arranque.
    }
  }

  if (_timer) clearInterval(_timer)
  _timer = null
  if (_archivo && intervaloMs > 0) {
    _timer = setInterval(() => {
      flushTodo().catch(() => {})
    }, intervaloMs)
    _timer.unref?.()
  }

  return _pend.size
}

// El flush por tamaño. `agregar` lo llama fire-and-forget; los tests lo esperan.
// No hace nada si el acumulador no está abierto o falta con qué firmar/liquidar.
export async function flushSiSuperaUmbral() {
  if (!_archivo || !_firmar || !_liquidar) return null
  if (_flushEnCurso) return _flushEnCurso
  if (contar({ soloPendientes: true }) < _umbral) return null
  return flushTodo()
}

// Arma-firma-liquida-marca TODO lo pendiente, agrupado por red+wallet (un lote es
// de UNA red y UNA wallet: `construirLote` lo exige). NO reintenta acá lo que
// falló: queda en el acumulador para el próximo disparo. Devuelve un resumen por
// grupo. No tira: un flush que revienta no puede llevarse puesto el `close`.
export async function flushTodo({ firmar = _firmar, liquidar = _liquidar } = {}) {
  if (_flushEnCurso) return _flushEnCurso
  _flushEnCurso = (async () => {
    const resultados = []
    const grupos = new Set(
      pendientes({ soloPendientes: true }).map(
        (r) => `${r.network}|${String(r.payTo).toLowerCase()}`
      )
    )
    for (const g of grupos) {
      const sep = g.indexOf('|')
      const network = g.slice(0, sep)
      const payTo = g.slice(sep + 1)
      let firmado = null
      try {
        const l = armar({ network, payTo, soloPendientes: true })
        firmado = typeof firmar === 'function' ? await firmarLote(l, firmar) : null
      } catch (err) {
        resultados.push({ network, payTo, ok: false, motivo: (err && err.message) || String(err) })
        continue
      }
      if (!firmado) {
        resultados.push({ network, payTo, ok: false, motivo: 'no se pudo firmar el lote' })
        continue
      }
      if (typeof liquidar !== 'function') {
        resultados.push({ network, payTo, ok: false, motivo: 'no hay funcion liquidar' })
        continue
      }
      const res = await liquidarLote({ lote: firmado, liquidar })
      marcarLiquidados(res.liquidados)
      resultados.push({
        network,
        payTo,
        ok: true,
        liquidados: res.liquidados.length,
        fallidos: res.fallidos.length
      })
    }
    persistir()
    return resultados
  })()
  try {
    return await _flushEnCurso
  } finally {
    _flushEnCurso = null
  }
}

// El apagado de `bin.mjs`. Persiste PRIMERO —si el flush cuelga contra un
// facilitator lento, el forced-exit corta igual y no se pierde nada—, después
// intenta un último flush, y vuelve a persistir lo que quede.
export async function cerrar({ flush = true } = {}) {
  if (_timer) clearInterval(_timer)
  _timer = null
  persistir()
  if (flush && _liquidar) {
    try {
      await flushTodo()
    } catch {
      // ya se avisó adentro; el acumulador queda persistido para la próxima.
    }
    persistir()
  }
  _archivo = null
  _firmar = null
  _liquidar = null
}

// -----------------------------------------------------------------------------

export function agregar(recibo) {
  const k = claveDe(recibo)
  if (!k) throw new Error('lote: no se puede acumular un recibo sin nonce')
  _pend.set(k, recibo)
  if (_pend.size > MAX_PENDIENTES) {
    const sobran = _pend.size - MAX_PENDIENTES
    let n = 0
    for (const key of _pend.keys()) {
      if (n++ >= sobran) break
      _pend.delete(key)
    }
  }
  persistir()
  flushSiSuperaUmbral().catch(() => {})
  return recibo
}

// Los recibos acumulados, filtrables por red/destino y por si todavía se deben.
export function pendientes({ red, network, payTo, soloPendientes = false } = {}) {
  const out = []
  for (const r of _pend.values()) {
    if (red && r.red !== red) continue
    if (network && r.network !== network) continue
    if (payTo && String(r.payTo).toLowerCase() !== String(payTo).toLowerCase()) continue
    if (soloPendientes && r.liquidacion && r.liquidacion.success) continue
    out.push(r)
  }
  return out
}

export function contar(filtro) {
  return pendientes(filtro).length
}

// Arma un lote con los recibos acumulados que matcheen. Tira si no hay ninguno:
// un lote vacío no es un lote.
export function armar({ red, network, payTo, soloPendientes = false, ts } = {}) {
  const recibos = pendientes({ red, network, payTo, soloPendientes })
  if (recibos.length === 0) throw new Error('lote: no hay recibos acumulados para ese destino')
  return construirLote({ recibos, ts })
}

// Marca esos nonces como liquidados (no los borra: quedan para auditar hasta que
// la poda se los lleve).
export function marcarLiquidados(nonces, { transaction } = {}) {
  let toco = false
  for (const n of nonces || []) {
    const r = _pend.get(n)
    if (r) {
      r.liquidacion = {
        success: true,
        transaction: transaction || (r.liquidacion && r.liquidacion.transaction) || '',
        at: Date.now()
      }
      toco = true
    }
  }
  // Que el corte de un proceso justo después de liquidar no vuelva a cobrar: lo
  // liquidado tiene que quedar marcado en disco, no solo en memoria.
  if (toco) persistir()
}

// Sólo para los tests: vacía el acumulador entre casos.
export function limpiar() {
  _pend.clear()
}
