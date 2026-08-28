// El stack de x402, cargado de la única forma en que funciona bajo Bare.
// Fase 9 del ROADMAP_FASE7-X402 (D8, D9, D10, D14, D15).
//
// -----------------------------------------------------------------------------
// POR QUÉ ESTE ARCHIVO EXISTE, Y POR QUÉ NO ES UN `import` SUELTO
//
// `@x402/evm` NO IMPORTA BAJO BARE POR SU CUENTA, y el motivo está
// diagnosticado: **viem usa `TextEncoder`, que Bare no tiene como global.**
//
//     antes de importar WDK:   typeof globalThis.TextEncoder === 'undefined'
//     después:                 'function'
//
// WDK los instala (`TextEncoder` y `TextDecoder`) al cargarse, y viem —que está
// abajo de `@x402/evm`— los usa en `utils/encoding/toHex.js`. Sin ese polyfill,
// el import muere con `ReferenceError: TextEncoder is not defined`.
//
// Alcanza con IMPORTAR WDK: no hace falta derivar ninguna cuenta ni abrir
// ninguna wallet. Lo que importa es que el polyfill quede instalado antes.
//
// (Hubo un segundo problema, ya resuelto por otro lado: `@noble/hashes` elegía
// su variante `node:crypto` bajo el packer. Eso rompía el BINARIO, no el
// runtime, y lo arregla `scripts/parche-noble-bare.js`.)
//
// Depender de un polyfill que instala otro paquete es frágil igual, así que en
// vez de dejarlo como un `import` de arriba de archivo que alguien va a
// reordenar en un refactor de imports —y la falla aparecería tres saltos más
// allá—, vive acá, con el porqué al lado y con dos cosas que lo vigilan:
//
//   - el paso 5 de `scripts/spike-d11-wdk-bare.mjs`, que mide si `@x402/evm`
//     importa AISLADO lanzando un proceso bare limpio (hoy falla, y está bien
//     que falle: falla el spike, no la fase);
//   - un test de la suite que carga ESTE módulo en un proceso limpio.
//
// El día que `@noble/hashes` o Bare cambien, uno de los dos se rompe y dice
// exactamente qué se rompió.
//
// -----------------------------------------------------------------------------
// D15 — LAS CADENAS, Y LA QUE X402 NO CONOCE
//
// D15 decidió Plasma (`eip155:9745`) como default y Stable (`eip155:988`) como
// fallback. Pero `@x402/evm` sólo trae Stable de fábrica:
//
//     getDefaultAsset('eip155:988')   -> USDT0, 6 decimales
//     getDefaultAsset('eip155:9745')  -> throw: "No default asset configured"
//
// Así que el activo de Plasma hay que declararlo nosotros, y ese es exactamente
// el tipo de dato que no se inventa: es la dirección de un contrato a la que se
// le va a mandar plata real. Ver `ACTIVOS` abajo.

import env from 'bare-env'

// -----------------------------------------------------------------------------
// Las cadenas
// -----------------------------------------------------------------------------

// CAIP-2 de cada red que este nodo puede aceptar, en el orden de preferencia de
// D15. Los nombres cortos son los que viajan en `economic.chains` del
// manifiesto (kebab-case, ver wallet.mjs).
//
// `plasma-testnet` (9746) lo agrega la Fase 10 y REABRE la Fase 9: D30 decidió
// que nada se estrena en mainnet, así que el `curl` que cobra de verdad lo hace
// primero en 9746. El chainId no es un detalle de config — por EIP-155 entra en
// lo que se firma —, así que 9745 y 9746 son dos redes distintas y no una con
// una bandera.
export const CAIP2 = {
  plasma: 'eip155:9745',
  'plasma-testnet': 'eip155:9746',
  stable: 'eip155:988'
}

// El activo con el que se cobra en cada red.
//
// El de Stable NO se escribe acá: se le pide a `@x402/evm`, que lo trae de
// fábrica. Duplicar una dirección de contrato que el paquete ya conoce es
// crear una segunda fuente de verdad para un dato que, si se desincroniza,
// manda plata a otro lado.
//
// El de Plasma sí hay que declararlo, porque x402 no lo tiene. Y acá está el
// límite honesto: la dirección de abajo es la que usó el spike de D11
// (`scripts/spike-d11-wdk-bare.mjs`, dominio EIP-712 de la firma), y **no está
// verificada contra la cadena**. Por eso `activoDe()` no la devuelve sin más:
// exige que el operador confirme, porque el modo de falla es mandar USD₮ a un
// contrato equivocado y eso no tiene vuelta atrás.
const PLASMA_USDT0_SIN_VERIFICAR = {
  asset: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
  name: 'USDT0',
  version: '1',
  decimals: 6,
  symbol: 'USDT0'
}

// La variable con la que el operador declara que verificó la dirección de
// Plasma contra el explorer. Sin esto, Plasma queda fuera y se cobra en Stable.
export const VAR_PLASMA_OK = 'PYRUS_X402_PLASMA_ASSET_VERIFICADO'

// -----------------------------------------------------------------------------
// Plasma TESTNET (9746) — donde D30 dice que se estrena
// -----------------------------------------------------------------------------

// En 9746 NO hay stablecoin: los faucets dan sólo XPL, que es gas nativo y no
// tiene contrato. El activo con EIP-3009 lo despliega el operador
// (`npm run desplegar-activo`, `scripts/activo-prueba.sol` → tUSD) y cada
// despliegue tiene su propia dirección, así que —a diferencia de Plasma
// mainnet— acá no hay una constante canónica que hardcodear: se declara por
// variable.
//
// Son los MISMOS nombres que lee `scripts/verificar-x402.js`, que es el que
// comprueba CONTRA LA CADENA que ese contrato implementa EIP-3009 y que su
// dominio EIP-712 coincide con el que vamos a firmar. Acá no se verifica nada:
// declarar `ASSET` y `NAME` es el operador diciendo "ya lo corrí y quedó bien".
// Sin los dos, la red no se ofrece — el default es no cobrar en una red cuyo
// activo nadie declaró.
export const VAR_PLASMA_TESTNET_ASSET = 'PYRUS_X402_PLASMA_TESTNET_ASSET'
export const VAR_PLASMA_TESTNET_NAME = 'PYRUS_X402_PLASMA_TESTNET_NAME'
export const VAR_PLASMA_TESTNET_SYMBOL = 'PYRUS_X402_PLASMA_TESTNET_SYMBOL'
export const VAR_PLASMA_TESTNET_VERSION = 'PYRUS_X402_PLASMA_TESTNET_VERSION'
export const VAR_PLASMA_TESTNET_DECIMALS = 'PYRUS_X402_PLASMA_TESTNET_DECIMALS'

// -----------------------------------------------------------------------------
// La carga
// -----------------------------------------------------------------------------

let cache = null

// Carga el stack, en orden. Devuelve `{ core, evm }`.
//
// Es async y con cache: el import de WDK cuesta, y esto lo llama el camino de
// un request. La segunda vez sale de memoria.
export async function cargar() {
  if (cache) return cache

  // ESTE IMPORT NO SE MUEVE Y NO SE BORRA. Ver el encabezado: instala los
  // globales `TextEncoder`/`TextDecoder` que viem necesita, y sin él el de
  // abajo muere con un ReferenceError que no menciona x402 por ningún lado.
  await import('@tetherto/wdk-wallet-evm')

  const core = await import('@x402/core')
  const evm = await import('@x402/evm')

  cache = { core, evm }
  return cache
}

// El activo con el que se cobra en `red` ('plasma' | 'stable'), o null si esa
// red no se puede usar todavía.
//
// Devolver null en vez de tirar es deliberado: que Plasma no esté disponible
// no es un error del programa, es una configuración incompleta, y el llamador
// tiene que poder caer a Stable —que es exactamente lo que D15 llama fallback—
// en vez de quedarse sin cobrar.
export async function activoDe(red) {
  const { evm } = await cargar()
  const id = CAIP2[red]
  if (!id) return null

  if (red === 'plasma') {
    // Sin la confirmación explícita del operador, Plasma no se usa. El default
    // es no cobrar en una red cuya dirección de contrato no verificó nadie.
    if (env[VAR_PLASMA_OK] !== '1') return null
    return { network: id, ...PLASMA_USDT0_SIN_VERIFICAR }
  }

  if (red === 'plasma-testnet') {
    // Igual que Plasma pero sin dirección de fábrica: la pone el operador
    // después de correr `npm run verificar-x402`. Sin `ASSET` y `NAME` la red
    // no entra al `accepts[]` — un cliente no puede firmar un EIP-712 contra un
    // dominio a medias.
    const asset = env[VAR_PLASMA_TESTNET_ASSET]
    const name = env[VAR_PLASMA_TESTNET_NAME]
    if (!asset || !name) return null
    const dec = Number(env[VAR_PLASMA_TESTNET_DECIMALS] || 6)
    return {
      network: id,
      asset,
      name,
      version: env[VAR_PLASMA_TESTNET_VERSION] || '1',
      decimals: Number.isFinite(dec) ? dec : 6,
      symbol: env[VAR_PLASMA_TESTNET_SYMBOL] || name
    }
  }

  try {
    return { network: id, ...evm.getDefaultAsset(id) }
  } catch {
    return null
  }
}

// Las redes que este nodo puede aceptar HOY, en orden de preferencia. Puede ser
// más corta que `wallet.CHAINS`: el manifiesto declara en qué redes el nodo
// quiere cobrar, esto dice en cuáles efectivamente puede.
export async function redesDisponibles() {
  const out = []
  for (const red of ['plasma', 'plasma-testnet', 'stable']) {
    if (await activoDe(red)) out.push(red)
  }
  return out
}

// -----------------------------------------------------------------------------
// El 402
// -----------------------------------------------------------------------------

// Una entrada de `accepts[]`: qué se acepta, cuánto, a quién y en qué red.
//
// D9(a) — esquema `exact`: un monto FIJO declarado antes de generar. Un LLM no
// sabe cuántos tokens va a producir, así que lo honesto es lo que el DoD pide
// textualmente: que el 402 declare el tope. El `accepts[]` dice "hasta N tokens
// de salida por $X" y el gateway aplica ese `max_tokens` aunque el cliente no
// lo mande. Cobrar un precio fijo sin declarar el tope sería cobrar por algo
// que el cliente no puede acotar.
//
// `maxTimeoutSeconds` es cuánto vale la autorización firmada: pasado eso, el
// cliente puede volver a firmar sin riesgo de que la vieja se cobre tarde.
export function entradaAccepts({
  payTo,
  activo,
  micros,
  maxTokens,
  recurso,
  descripcion,
  maxTimeoutSeconds = 300
}) {
  if (!payTo) throw new Error('x402: no hay a quien pagarle')
  if (!activo) throw new Error('x402: no hay activo para esa red')

  // Micro-dolares -> unidades minimas del activo. USD₮0 tiene 6 decimales, o
  // sea que 1 micro-dolar ES una unidad minima; se calcula igual en vez de
  // asumirlo, porque `decimals` viene del activo y no todos los de la tabla de
  // x402 son de 6 (hay de 18).
  const amount = montoEnUnidades(micros, activo)

  return {
    scheme: 'exact',
    network: activo.network,
    // `amount`, no `maxAmountRequired`. El segundo es el nombre de x402 v1 y es
    // el que sale en media documentacion; el cliente de v2 lee `amount`
    // (`createEIP3009Payload` en @x402/evm), asi que con el nombre viejo el
    // cliente firma `BigInt(undefined)` y ni siquiera llega a mandarnos nada.
    // Preguntado al paquete, no adivinado.
    amount,
    resource: recurso,
    description: descripcion,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds,
    asset: activo.asset,
    // `extra` es donde el esquema `exact` de EVM espera el dominio EIP-712 del
    // token, que es lo que el cliente necesita para firmar la autorizacion.
    extra: { name: activo.name, version: activo.version },
    // NO es parte del spec de x402: es nuestro, y es la mitad honesta de D9(a).
    // El cliente tiene que poder saber por cuanto trabajo esta pagando ese
    // monto fijo, y "hasta N tokens de salida" es ese numero.
    outputTokenLimit: maxTokens
  }
}

// El cuerpo entero de un 402, con una entrada por red disponible.
//
// Se ordena por la preferencia de D15 y el cliente elige. Si no queda ninguna
// red usable, devuelve null: el llamador tiene que poder distinguir "hay que
// pagar" de "este nodo no puede cobrar", que terminan en respuestas distintas.
export async function desafio({ payTo, micros, maxTokens, recurso, descripcion }) {
  const { core } = await cargar()
  const accepts = []
  for (const red of await redesDisponibles()) {
    accepts.push(
      entradaAccepts({
        payTo,
        activo: await activoDe(red),
        micros,
        maxTokens,
        recurso,
        descripcion
      })
    )
  }
  if (accepts.length === 0) return null
  return { x402Version: core.x402Version, error: 'X-PAYMENT header is required', accepts }
}

// -----------------------------------------------------------------------------
// La verificación (D12)
// -----------------------------------------------------------------------------

// D12 decide: VERIFICAR sincrónico, servir, LIQUIDAR después. Esto es la
// primera parte, y es la que protege al proveedor de gastar GPU gratis.
//
// No toca la cadena, y eso no es una optimización: meter una transacción
// on-chain delante del primer token pondría su latencia delante del TTFT, que
// es el número que el proyecto mide y publica. Lo que se verifica acá es que la
// autorización esté BIEN FIRMADA y diga lo que tiene que decir. Que la wallet
// tenga saldo se sabe al liquidar, y para eso está el facilitator.
//
// Lo que esto NO prueba, y hay que decirlo: que el pagador tenga fondos, y que
// el nonce no se haya usado ya. Un firmante sin saldo pasa esta verificación y
// falla al liquidar. Es exactamente el riesgo que D12 acepta a cambio del TTFT,
// y por eso la Fase 10 (recibos en lote) existe.
export async function verificarPago(cabecera, { payTo, activo, micros, red }) {
  const no = (motivo) => ({ ok: false, motivo })

  if (!cabecera) return no('falta el header X-PAYMENT')
  if (!activo) return no('no hay activo para esa red')

  let sobre
  try {
    sobre = JSON.parse(Buffer.from(String(cabecera), 'base64').toString('utf8'))
  } catch {
    return no('el X-PAYMENT no es base64 de un JSON')
  }

  const { core } = await cargar()
  if (sobre.x402Version !== core.x402Version) {
    return no(`version de x402 no soportada: ${sobre.x402Version}`)
  }
  if (sobre.scheme && sobre.scheme !== 'exact') return no(`esquema no soportado: ${sobre.scheme}`)
  if (sobre.network && sobre.network !== activo.network) {
    return no(`red equivocada: pago en ${sobre.network}, se pidio ${activo.network}`)
  }

  const a = sobre.payload && sobre.payload.authorization
  const firma = sobre.payload && sobre.payload.signature
  if (!a || !firma) return no('el payload no trae authorization y signature')

  // A QUIEN. Se compara en minuscula porque las direcciones EVM viajan con
  // checksum de mayusculas y dos formas del MISMO valor no pueden leerse como
  // dos direcciones distintas.
  if (String(a.to || '').toLowerCase() !== String(payTo).toLowerCase()) {
    return no('la autorizacion paga a otra direccion')
  }

  // CUANTO. Mayor o igual: pagar de mas es del pagador, pagar de menos no.
  let valor
  try {
    valor = BigInt(a.value)
  } catch {
    return no('el monto de la autorizacion no es un entero')
  }
  const requerido = BigInt(montoEnUnidades(micros, activo))
  if (valor < requerido) {
    return no(`el pago es de ${valor} y se pidieron ${requerido}`)
  }

  // CUANDO. Una autorizacion vencida no se acepta aunque este bien firmada, y
  // una que todavia no empezó tampoco.
  const ahora = BigInt(Math.floor(Date.now() / 1000))
  try {
    if (BigInt(a.validBefore) <= ahora) return no('la autorizacion ya vencio')
    if (BigInt(a.validAfter) > ahora) return no('la autorizacion todavia no es valida')
  } catch {
    return no('validAfter/validBefore no son enteros')
  }

  // QUIEN FIRMO. Es lo unico que no se puede falsificar, y por eso es lo ultimo:
  // si algo de arriba esta mal, no hace falta gastar un ecrecover.
  const { evm } = await cargar()
  const viem = await import('viem')
  const chainId = Number(String(activo.network).split(':')[1])
  let firmante
  try {
    firmante = await viem.recoverTypedDataAddress({
      domain: {
        name: activo.name,
        version: activo.version,
        chainId,
        verifyingContract: activo.asset
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
      signature: firma
    })
  } catch (err) {
    return no('no se pudo recuperar el firmante: ' + ((err && err.message) || err))
  }

  if (firmante.toLowerCase() !== String(a.from || '').toLowerCase()) {
    return no('la firma no corresponde a quien dice pagar')
  }

  return {
    ok: true,
    payer: firmante,
    // El nonce es la clave de idempotencia del pago (D20): el mismo nonce
    // liquidado dos veces cobra una sola. Se devuelve para que quien sirve lo
    // pueda registrar.
    nonce: a.nonce,
    valor: valor.toString(),
    red,
    autorizacion: a,
    firma
  }
}

// Micro-dolares -> unidades minimas del activo. Vive aparte porque lo usan el
// que arma el 402, el que lo verifica y el que lo PAGA (`x402-cliente.mjs`, al
// convertir su techo de gasto), y los tres tienen que dar EXACTAMENTE lo mismo:
// declarar un monto y verificar contra otro es rechazar pagos correctos.
export function montoEnUnidades(micros, activo) {
  const enteros = BigInt(Math.max(0, Math.ceil(Number(micros) || 0)))
  const escala = BigInt(10) ** BigInt(Math.max(0, activo.decimals - 6))
  return (enteros * escala).toString()
}

// -----------------------------------------------------------------------------
// La liquidación (D12, D14)
// -----------------------------------------------------------------------------

// EL PROTOCOLO ENTRE ESTE NODO Y EL FACILITATOR, escrito acá porque es lo que la
// Fase 10 liquida en lote y un lote que no se arma con estos campos exactos se
// rechaza del otro lado sin decir por qué.
//
// El transporte lo pone `HTTPFacilitatorClient` de `@x402/core/http`, que envía
// POST JSON a `<url>/verify` y `<url>/settle` y GET a `<url>/supported`. Lo que
// viaja en cada uno, por nombre de campo (el contrato vinculante es el schema
// del paquete instalado, no el spec público, que no fija los campos de
// respuesta):
//
//   POST /verify   ->  { paymentPayload, paymentRequirements }
//   POST /settle   ->  { paymentPayload, paymentRequirements }
//
//     paymentPayload      = { x402Version, scheme: 'exact', network,
//                             payload: { authorization, signature } }
//     paymentRequirements = la entrada de `accepts[]` TAL CUAL se ofreció en el
//                           402 (`entradaAccepts`): network, amount, asset,
//                           payTo, maxTimeoutSeconds, extra:{ name, version }.
//                           Recalcularla de este lado es liquidar contra otros
//                           números que los que el cliente firmó.
//
//   /verify  <-  { isValid: boolean, invalidReason?, invalidMessage? }
//   /settle  <-  { success: boolean, transaction: string, network: string,
//                  payer: string, errorReason?, errorMessage? }
//                `transaction` y `network` vienen como string aunque falle:
//                el schema los exige y sin ellos el cliente descarta la
//                respuesta entera (ver 0-quinquies, revisión del Bloque 0).
//
// Esta es la unidad que la Fase 10 difiere: `liquidarLote` de `qvac/lote.mjs`
// llama a `liquidar()` una vez por recibo acumulado, con el mismo par
// (paymentPayload, paymentRequirements) que se hubiera mandado en la Fase 9 —
// settlement diferido, no un mecanismo nuevo.
export const PROTOCOLO_FACILITATOR = Object.freeze({
  endpoints: Object.freeze({ verify: '/verify', settle: '/settle', supported: '/supported' }),
  // Lo que este nodo MANDA en /verify y /settle.
  envia: Object.freeze(['paymentPayload', 'paymentRequirements']),
  paymentPayload: Object.freeze(['x402Version', 'scheme', 'network', 'payload']),
  paymentPayloadPayload: Object.freeze(['authorization', 'signature']),
  // Lo que este nodo LEE de /settle (SettleResponse de x402).
  settleResponse: Object.freeze(['success', 'transaction', 'network', 'payer']),
  settleResponseError: Object.freeze(['errorReason', 'errorMessage']),
  // Lo que este nodo LEE de /verify (VerifyResponse de x402).
  verifyResponse: Object.freeze(['isValid', 'invalidReason', 'invalidMessage'])
})

// D14 — el facilitator. La decisión es el HOSTED de Semantic hasta la Fase 10:
// el self-hosted está en beta, necesita una wallet adicional con gas nativo, y
// agrega un componente que no controlamos al camino crítico de la primera demo
// que cobra de verdad.
//
// Y lo que hay que decir en voz alta, que también es de D14: la documentación de
// WDK aclara que Tether *"does not endorse, operate, or assume legal or
// financial responsibility for any third-party facilitator"*. Va acá y en el
// README, no escondido.
export const FACILITATOR_DEFAULT = 'https://x402.semanticpay.io'

// Se puede apuntar a otro -- un self-hosted, o el falso de los tests -- sin
// tocar código.
export const VAR_FACILITATOR = 'PYRUS_X402_FACILITATOR'

export function facilitatorUrl() {
  return env[VAR_FACILITATOR] || FACILITATOR_DEFAULT
}

// Liquida un pago ya verificado. Devuelve el `SettleResponse` de x402:
// `{ success, transaction, network, payer, errorReason?, errorMessage? }`.
//
// Esto SÍ toca la cadena, y por eso va DESPUÉS de servir (D12). El precio de esa
// decisión hay que decirlo: si la liquidación falla, el cliente ya recibió sus
// tokens. Es deliberado —la alternativa es poner una transacción on-chain
// delante del TTFT— y es lo que la Fase 10 arregla de verdad, acumulando
// recibos en vez de liquidar de a uno.
//
// No tira nunca: una liquidación que falla no puede llevarse puesta una
// respuesta que ya salió bien. Devuelve `success: false` con el motivo.
export async function liquidar({ pago, requisito }) {
  try {
    const { HTTPFacilitatorClient } = await import('@x402/core/http')
    const { core } = await cargar()
    const cliente = new HTTPFacilitatorClient({ url: facilitatorUrl() })

    const payload = {
      x402Version: core.x402Version,
      scheme: 'exact',
      network: requisito.network,
      payload: { authorization: pago.autorizacion, signature: pago.firma }
    }
    return await cliente.settle(payload, requisito)
  } catch (err) {
    const message = (err && err.message) || String(err)
    console.error(`[x402] la liquidacion fallo: ${message}`)
    return {
      success: false,
      errorReason: 'settlement_failed',
      errorMessage: message,
      transaction: '',
      network: requisito.network,
      payer: pago.payer
    }
  }
}

// El `X-PAYMENT-RESPONSE`, con el formato que define x402 y no uno nuestro.
export async function cabeceraDeRecibo(recibo) {
  const { encodePaymentResponseHeader } = await import('@x402/core/http')
  return encodePaymentResponseHeader(recibo)
}
