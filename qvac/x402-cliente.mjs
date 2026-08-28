// El rol CLIENTE de x402: este nodo pagándole a OTRO. Es el espejo exacto de
// `qvac/x402.mjs`, que es el rol servidor —`desafio()` arma el 402,
// `verificarPago()` chequea el que llega, `liquidar()` lo cobra—. Acá está la
// otra punta: recibir un 402, firmar la autorización EIP-3009 con la wallet del
// nodo, y reintentar con el `X-PAYMENT` puesto.
//
// -----------------------------------------------------------------------------
// POR QUE ESTO ES UN MODULO Y NO CODIGO SUELTO EN EL LLAMADOR
//
// La firma en sí ya estaba resuelta y probada —`test/integracion.js` la hace
// inline con `evm.ExactEvmScheme` desde la Fase 9—. Lo que faltaba, y es lo que
// vive acá, son las tres cosas que un pagador de verdad no puede improvisar en
// cada call site:
//
//   1. UN TECHO DE GASTO, obligatorio. El monto lo pone el 402, o sea el OTRO
//      lado. Un cliente que firma cualquier `amount` que le manden es un cliente
//      que le entrega la billetera a un desconocido. El roadmap lo dice para el
//      agente de la Fase 11 y vale igual acá: "un agente que se pasa del
//      presupuesto es peor que uno que no arranca". El techo se chequea DOS
//      veces —al elegir la entrada y al firmarla— a propósito.
//
//   2. ELEGIR ENTRE REDES. Un 402 de este proyecto trae un `accepts[]` con una
//      entrada por red (Plasma, su testnet, Stable). `accepts[0]` a ciegas paga
//      en la que el servidor puso primera; acá se recorre la preferencia de D15
//      y NO se paga en una red que no está en la lista —firmar contra una cadena
//      que no reconocemos es EIP-155 en manos ajenas—.
//
//   3. EL BAILE COMPLETO, con UN solo reintento. Pedir → 402 → pagar → repetir
//      UNA vez. Sin loop: si el segundo intento también da 402, se devuelve tal
//      cual y decide el llamador. Reintentar en bucle contra un 402 es cómo un
//      bug de precio se transforma en una wallet vacía.
//
// -----------------------------------------------------------------------------
// LO QUE CRUZA DESDE EL LLAMADOR ES UNA CAPACIDAD DE FIRMAR, NO UNA WALLET
//
// `firmante` es `{ address, signTypedData }` — lo mismo que `bin.mjs` ya hace
// con su closure `firmar`: "el gateway pide firmas, no llaves". La cuenta WDK y
// la seed no entran a este módulo. El armado típico, en el llamador:
//
//     const abierta = await wallet.abrir(dir, passphrase, { red })
//     const firmante = {
//       address: abierta.address,
//       signTypedData: (td) => abierta.cuenta.signTypedData(td)
//     }
//
// -----------------------------------------------------------------------------
// LO QUE NO HACE
//
// No toca la cadena y no liquida: el que paga firma una autorización off-chain
// y se la deja al proveedor, que la cobra (o la difiere, Fase 10). No mira
// saldo —igual que `verificarPago` del otro lado, por la misma razón de D12: lo
// que se prueba acá es que la firma diga lo que tiene que decir—. Un firmante
// sin fondos produce un `X-PAYMENT` válido que recién falla cuando el proveedor
// lo liquida.

import { cargar, CAIP2, montoEnUnidades } from './x402.mjs'

// El orden en que se elige la red para pagar. Es la preferencia de D15, la
// misma que `redesDisponibles()` usa del lado servidor: Plasma primero, su
// testnet después, Stable de fallback. Una red que no esté acá NO se paga.
export const ORDEN_PREFERENCIA = ['plasma', 'plasma-testnet', 'stable']

// -----------------------------------------------------------------------------
// El techo
// -----------------------------------------------------------------------------

// Micro-dólares -> unidades mínimas del activo, para poder comparar un techo
// contra el `amount` del 402, que viene en unidades. Delega en la MISMA función
// que `x402.mjs` usa para armar y verificar el monto: un techo que escala
// distinto del monto rechazaría pagos que están dentro del presupuesto.
export function techoEnUnidades(techoMicros, decimals = 6) {
  return BigInt(montoEnUnidades(techoMicros, { decimals }))
}

// Resuelve el techo a unidades (BigInt), exigiendo que venga UNO de los dos.
// Sin techo no se paga: no hay default "sin límite".
function resolverTecho({ techoMicros, techoUnidades, decimals = 6 }) {
  if (techoUnidades != null) {
    const u = BigInt(techoUnidades)
    if (u <= 0n) throw new Error('x402-cliente: el techo de gasto tiene que ser > 0')
    return u
  }
  if (techoMicros != null) {
    const m = Number(techoMicros)
    if (!Number.isFinite(m) || m <= 0) {
      throw new Error('x402-cliente: techoMicros tiene que ser un número > 0')
    }
    return techoEnUnidades(m, decimals)
  }
  throw new Error(
    'x402-cliente: falta el techo de gasto (techoMicros o techoUnidades). ' +
      'Un pagador sin límite no arranca — es la regla de la Fase 11.'
  )
}

// -----------------------------------------------------------------------------
// La selección
// -----------------------------------------------------------------------------

// De un cuerpo 402 (`{ x402Version, accepts: [...] }`), elige UNA entrada por
// preferencia de red y dentro del techo. Devuelve `{ entrada, motivo }`:
// `entrada` es null si ninguna sirve, y `motivo` dice por qué —el llamador
// tiene que poder distinguir "todas caras" de "ninguna red conocida"—.
export function elegirEntrada(
  desafio,
  { redesPreferidas = ORDEN_PREFERENCIA, techoUnidades } = {}
) {
  const accepts = desafio && Array.isArray(desafio.accepts) ? desafio.accepts : null
  if (!accepts || accepts.length === 0) {
    return { entrada: null, motivo: 'el 402 no trae accepts[]' }
  }
  if (techoUnidades == null) {
    return { entrada: null, motivo: 'elegirEntrada necesita un techo en unidades' }
  }

  const techo = BigInt(techoUnidades)
  let habiaCandidata = false
  let masBarata = null

  for (const nombre of redesPreferidas) {
    const caip2 = CAIP2[nombre]
    if (!caip2) continue
    const entrada = accepts.find(
      (a) => a && a.network === caip2 && (!a.scheme || a.scheme === 'exact')
    )
    if (!entrada) continue

    let monto
    try {
      monto = BigInt(entrada.amount)
    } catch {
      continue // un `amount` que no es entero no se firma
    }
    habiaCandidata = true
    if (masBarata === null || monto < masBarata) masBarata = monto

    if (monto <= techo) {
      return { entrada, motivo: `red ${nombre}, ${monto} unidades (techo ${techo})` }
    }
  }

  if (!habiaCandidata) {
    return {
      entrada: null,
      motivo:
        'ninguna red del 402 está en la preferencia (' +
        redesPreferidas.join(', ') +
        '): no se paga en una cadena que no reconocemos'
    }
  }
  return {
    entrada: null,
    motivo: `todas las entradas superan el techo: la más barata pide ${masBarata}, el techo es ${techo}`
  }
}

// -----------------------------------------------------------------------------
// La firma
// -----------------------------------------------------------------------------

// Firma la autorización EIP-3009 de UNA entrada de `accepts[]` y devuelve el
// sobre + la cabecera lista para el header `x-payment` (base64 de un JSON, el
// mismo formato que `verificarPago` del otro lado decodifica).
//
// `x402Version` sale del cuerpo del 402 y viaja de vuelta en el sobre:
// `verificarPago` rechaza el pago si no coincide con el suyo.
export async function crearPago({ entrada, firmante, x402Version, techoUnidades = null }) {
  if (!entrada) throw new Error('x402-cliente: no hay entrada de accepts[] para firmar')
  if (!firmante || typeof firmante.signTypedData !== 'function' || !firmante.address) {
    throw new Error('x402-cliente: firmante inválido (se espera { address, signTypedData })')
  }
  if (!entrada.extra || !entrada.extra.name || !entrada.extra.version) {
    throw new Error(
      'x402-cliente: la entrada no trae extra.{name,version} — sin el dominio EIP-712 ' +
        'del token no hay qué firmar'
    )
  }

  // El techo, otra vez, acá adentro. Aunque el llamador haya elegido la entrada
  // a mano y se haya salteado `elegirEntrada`, firmar es el punto de no
  // retorno: es donde el chequeo NO puede faltar.
  if (techoUnidades != null && BigInt(entrada.amount) > BigInt(techoUnidades)) {
    throw new Error(
      `x402-cliente: la entrada pide ${entrada.amount} y el techo es ${techoUnidades} — no se firma`
    )
  }

  const { evm } = await cargar()

  // El MISMO camino que `test/integracion.js` ejercita desde la Fase 9:
  // `ExactEvmScheme` arma la autorización (nonce, validAfter/Before) y la firma
  // vía `firmante.signTypedData`. Usar el esquema del paquete —y no armar el
  // typed-data a mano— es lo que hace que si `@x402/evm` cambia la forma de la
  // firma, el cliente se mueva con él, igual que `verificarPago` usa
  // `evm.authorizationTypes` en vez de una copia.
  const esquema = new evm.ExactEvmScheme(firmante)
  const p = await esquema.createPaymentPayload(x402Version, entrada)

  const sobre = {
    x402Version: p.x402Version,
    scheme: 'exact',
    network: entrada.network,
    payload: p.payload
  }

  return {
    cabecera: Buffer.from(JSON.stringify(sobre), 'utf8').toString('base64'),
    sobre,
    autorizacion: p.payload.authorization,
    firma: p.payload.signature
  }
}

// -----------------------------------------------------------------------------
// El recibo de vuelta
// -----------------------------------------------------------------------------

// Decodifica el `X-PAYMENT-RESPONSE` que el proveedor manda tras liquidar. No
// tira si no está o viene roto: un pago servido sin recibo legible sigue siendo
// un pago servido, y el llamador tiene que poder distinguir los casos.
export async function decodificarRecibo(valorHeader) {
  if (!valorHeader) return null
  try {
    const { decodePaymentResponseHeader } = await import('@x402/core/http')
    return decodePaymentResponseHeader(valorHeader)
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------
// El baile completo
// -----------------------------------------------------------------------------

// Hace el request y, si vuelve 402, paga y reintenta UNA vez.
//
//   const { res, pagado, recibo } = await pedirConPago(url, {
//     method: 'POST',
//     headers: { 'content-type': 'application/json' },
//     body: JSON.stringify(cuerpo)
//   }, { firmante, techoMicros: 500 })
//
// Devuelve `{ res, pagado, pago?, recibo?, entrada?, motivo? }`:
//   - `pagado: false` + `motivo` -> no hubo 402, o lo hubo y no se pudo/quiso
//     pagar (techo, red desconocida, 402 sin JSON). `res` es la respuesta cruda.
//   - `pagado: true` -> se firmó y se reintentó. `res` es la SEGUNDA respuesta;
//     puede seguir sin ser 2xx (p. ej. el proveedor rechaza la firma), y en ese
//     caso `res.status` lo dice. `recibo` es el `X-PAYMENT-RESPONSE` decodificado
//     o null.
//
// `opciones.body` se reenvía tal cual en el reintento; si es un stream de un
// solo uso, pasá un string. `opciones.headers` puede ser objeto plano o Headers.
export async function pedirConPago(
  url,
  opciones = {},
  {
    firmante,
    techoMicros = null,
    techoUnidades = null,
    redesPreferidas = ORDEN_PREFERENCIA,
    decimalsTecho = 6,
    fetchImpl = null
  } = {}
) {
  const techo = resolverTecho({ techoMicros, techoUnidades, decimals: decimalsTecho })

  const fetch = fetchImpl || (await cargarFetch())
  const headersBase = normalizarHeaders(opciones.headers)

  const res1 = await fetch(url, opciones)
  if (res1.status !== 402) {
    return { res: res1, pagado: false, motivo: 'sin 402: no hay nada que pagar' }
  }

  let desafio
  try {
    desafio = await res1.json()
  } catch {
    return { res: res1, pagado: false, motivo: 'el 402 no trae un cuerpo JSON' }
  }

  const sel = elegirEntrada(desafio, { redesPreferidas, techoUnidades: techo })
  if (!sel.entrada) {
    return { res: res1, pagado: false, motivo: sel.motivo, desafio }
  }

  const pago = await crearPago({
    entrada: sel.entrada,
    firmante,
    x402Version: desafio.x402Version,
    techoUnidades: techo
  })

  const res2 = await fetch(url, {
    ...opciones,
    headers: { ...headersBase, 'x-payment': pago.cabecera }
  })

  const recibo = await decodificarRecibo(leerHeader(res2, 'x-payment-response'))

  return { res: res2, pagado: true, pago, recibo, entrada: sel.entrada }
}

// -----------------------------------------------------------------------------

// Bajo Bare `fetch` no es global (ver `qvac/upstream.mjs`). Se resuelve igual
// que ahí y que en `embeddings.mjs`.
async function cargarFetch() {
  const mod = await import('bare-fetch')
  return mod.default || mod.fetch || mod
}

function normalizarHeaders(h) {
  if (!h) return {}
  if (typeof h.entries === 'function') return Object.fromEntries(h.entries())
  return { ...h }
}

function leerHeader(res, nombre) {
  const h = res && res.headers
  if (!h) return null
  if (typeof h.get === 'function') return h.get(nombre)
  return h[nombre] || h[nombre.toLowerCase()] || null
}
