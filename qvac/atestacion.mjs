// D24 — la atestación del proveedor: qué sirvió, firmado por quien lo sirvió.
//
// -----------------------------------------------------------------------------
// QUE PROBLEMA CIERRA, Y CUAL NO
//
// El recibo de x402 que ya existe prueba que ALGUIEN PAGO. La firma EIP-3009 la
// pone el cliente autorizando la transferencia, así que cubre una sola dirección
// del intercambio. Del otro lado no había nada: ningún artefacto donde el
// proveedor se comprometa con lo que entregó.
//
// El ataque que esto cierra NO es el de Token Inflation tal cual — acá el par no
// reporta el número que se factura, `costoDelIntento` (gateway.mjs) factura con
// el conteo propio del gateway. Es el mismo ataque con otro vector: **quien
// decide cómo se trocea el stream es el proveedor**, y el gateway cuenta un
// delta a la vez. Un proveedor que emite un carácter por delta en vez de un
// token por delta infla el conteo del que cuenta sin mentir en ningún campo y
// sin romper ninguna validación. No falsea el número: falsea la señal.
//
// Contra eso el `outputHash` es lo que cierra el agujero, y es toda la razón por
// la que este archivo existe: **el hash es sobre el texto completo, y el texto
// no depende de en cuántos pedazos viajó**. Cualquiera puede recontar los tokens
// desde el texto atestiguado, con el tokenizador que corresponda al `modelId`.
//
// Lo que esto NO prueba, y hay que decirlo en voz alta:
//
//   - que el modelo declarado sea el que corrió. Eso son sondas, y es Fase 10.5.
//   - que la CUANTIZACION declarada sea la que corrió. D26 lo cierra con la
//     literatura en la mano: no hay solución black-box publicada. `quantization`
//     y `runtime` acá son DECLARACIONES, sostenidas por stake y arbitraje, no
//     por una medición. Van firmadas justamente para que haya contra qué
//     arbitrar.
//   - nada sobre lo que sirvió OTRO nodo. Ver `PAR` abajo.
//
// -----------------------------------------------------------------------------
// LA FIRMA ES LA DE LA WALLET, NO LA DE LA RED
//
// Mismo criterio que la Fase 10 y que `manifest-v0.json:84`, que declara las dos
// claves separadas desde el día uno: la Ed25519 de red dice "este nodo es este
// nodo", y la wallet dice "a esta dirección le pagan". Una atestación de lo que
// se sirvió pertenece a la segunda: es el insumo con el que después se liquida.
//
// El gateway NUNCA ve la seed. bin.mjs abre el keystore y le inyecta una FUNCION
// que firma; acá sólo se la llama. Es la misma invariante que ya estaba escrita
// en gateway.mjs y esto no la afloja.
//
// -----------------------------------------------------------------------------
// LOS BYTES QUE SE FIRMAN
//
// JCS (RFC 8785) del artefacto SIN `signature`, exactamente el mismo patrón que
// `signManifest` — y con la MISMA función al firmar y al verificar, que es la
// única forma de que no puedan divergir. El orden de las claves de un objeto de
// JS no es estable entre implementaciones; con JCS los bytes son una función del
// contenido y no del orden en que se armó el objeto.
//
// Sobre esos bytes la firma es un personal_sign EIP-191 con la clave de la
// wallet (`account.sign` de WDK), que se verifica con `recoverMessageAddress`.
// No es EIP-712 a propósito: acá no hay un dominio de contrato contra el cual
// tipar, hay un documento canónico, y el JCS ya es la canonicalización.

import sodium from 'sodium-native'
import { canonicalize } from './manifest.mjs'

// Sube cuando cambie la FORMA del artefacto. Un verificador de otra versión no
// tiene que adivinar si le falta un campo o si el que lee significa otra cosa.
export const VERSION = 1

// El hash lleva el nombre del algoritmo pegado al valor, no en un campo aparte.
//
// Un `promptHash: "3a5f…"` suelto no es verificable por un tercero: hay que
// saber con qué recomputarlo. Y en un campo aparte el nombre y el valor pueden
// desincronizarse; pegados, no. BLAKE2b-256 y no SHA-256 porque sodium ya es
// dependencia directa de este árbol (la usa `wallet.mjs`) y corre bajo Bare sin
// import dinámico: SHA-256 saldría de `@noble/hashes`, que hoy está acá de
// arrastre de viem y no declarada.
const ALG = 'blake2b-256'

export function hashDe(texto) {
  const out = Buffer.alloc(sodium.crypto_generichash_BYTES)
  sodium.crypto_generichash(out, Buffer.from(String(texto), 'utf8'))
  return ALG + ':' + out.toString('hex')
}

// El hash del prompt es sobre los mensajes CANONICALIZADOS, no sobre el texto
// del último turno: lo que el proveedor recibió es la conversación entera, y es
// eso lo que el cliente puede recomputar de su lado para verificar.
export function hashDeMensajes(messages) {
  return hashDe(canonicalize(messages || []))
}

export function nonce() {
  const b = Buffer.alloc(16)
  sodium.randombytes_buf(b)
  return b.toString('hex')
}

// Los bytes que se firman: el artefacto canonicalizado SIN `signature`. Misma
// función al firmar y al verificar — ver el encabezado.
function bytesFirmados(atestacion) {
  const { signature, ...resto } = atestacion // eslint-disable-line no-unused-vars
  return canonicalize(resto)
}

// El artefacto SIN firmar. Se separa de `firmar` porque los tests tienen que
// poder mirar la forma sin necesitar una wallet.
//
// El orden en que se escriben las claves acá no significa nada: JCS las ordena.
export function construir({
  requestId,
  ts = Date.now(),
  modelId,
  quantization,
  runtime,
  promptHash,
  outputHash,
  tokensPrefill,
  tokensDecode,
  finishReason,
  providerPubkey,
  nonce: n = nonce()
}) {
  if (!requestId) throw new Error('atestacion: falta requestId')
  if (!providerPubkey) throw new Error('atestacion: falta providerPubkey')

  return {
    v: VERSION,
    requestId,
    nonce: n,
    ts,
    modelId: modelId || null,
    // DECLARADOS, no medidos. Ver D26 y el encabezado: no hay forma black-box
    // publicada de verificar la cuantización, así que lo que sostiene estos dos
    // campos es que están firmados y que hay stake detrás — no una medición.
    quantization: quantization || 'unknown',
    runtime: runtime || 'unknown',
    promptHash,
    outputHash,
    // D25 — las dos dimensiones separadas. `tokensDecode` puede venir del
    // `usage` del proveedor o de los deltas contados por el gateway, y no son la
    // misma cosa: por eso el gateway escribe `tokensFuente` en su rastro. Acá
    // van los números que el proveedor se compromete a sostener.
    tokensPrefill: Number.isFinite(tokensPrefill) ? tokensPrefill : 0,
    tokensDecode: Number.isFinite(tokensDecode) ? tokensDecode : 0,
    // Vocabulario propio, más ancho que el de OpenAI: además de `stop` y
    // `length` existe `client_cancelled` (D27, caso 1). Aplanar un corte del
    // cliente a `stop` sería afirmar que la respuesta terminó, que es lo único
    // que este campo no puede hacer.
    finishReason: finishReason || 'stop',
    // La direccion de COBRO, que es la que firma. Se llama `providerPubkey`
    // porque asi lo nombra D24; lo que lleva es la wallet, no la clave de red.
    providerPubkey
  }
}

// Firma con la wallet. `firmar` es la función que inyecta bin.mjs y que envuelve
// `account.sign` de WDK: acá no entra ninguna seed.
//
// No tira si la firma falla: devuelve null y que el llamador decida. Una
// atestación que no se pudo firmar NO se emite sin firma — un artefacto que
// parece una prueba y no lo es es peor que uno ausente.
export async function firmar(atestacion, firmarMensaje) {
  if (typeof firmarMensaje !== 'function') return null
  try {
    const signature = await firmarMensaje(bytesFirmados(atestacion))
    if (typeof signature !== 'string' || !signature.startsWith('0x')) return null
    return { ...atestacion, signature }
  } catch (err) {
    console.error(`[atestacion] no se pudo firmar: ${(err && err.message) || err}`)
    return null
  }
}

// Verifica que la firma corresponda al contenido Y a quien dice haberlo servido.
//
// Devuelve `{ ok, reason }` y no un booleano por el mismo motivo que
// `verifyManifest`: hay que poder loguear POR QUE se descartó, y "false" no se
// debuggea.
//
// Las dos mitades importan por separado. Que la firma valide prueba que alguien
// con esa clave firmó ese contenido; que el firmante COINCIDA con
// `providerPubkey` es lo que impide que cualquiera arme una atestación con su
// propia wallet y la presente como la de otro nodo.
export async function verificar(atestacion) {
  if (!atestacion || typeof atestacion !== 'object') {
    return { ok: false, reason: 'la atestacion no es un objeto' }
  }
  if (atestacion.v !== VERSION) {
    return { ok: false, reason: `version ${atestacion.v} desconocida` }
  }
  if (typeof atestacion.signature !== 'string' || !atestacion.signature.startsWith('0x')) {
    return { ok: false, reason: 'falta la firma o no es una firma EVM' }
  }

  const viem = await import('viem')
  let firmante
  try {
    firmante = await viem.recoverMessageAddress({
      message: bytesFirmados(atestacion),
      signature: atestacion.signature
    })
  } catch (err) {
    return { ok: false, reason: `no se pudo recuperar el firmante: ${(err && err.message) || err}` }
  }

  if (firmante.toLowerCase() !== String(atestacion.providerPubkey || '').toLowerCase()) {
    return {
      ok: false,
      reason: `firmo ${firmante} y la atestacion dice ser de ${atestacion.providerPubkey}`
    }
  }

  return { ok: true, reason: null, firmante }
}

// Por qué este nodo NO puede firmar una atestación de este request, o `null` si
// puede. Vive acá y no en el gateway para que la regla se pueda probar sola: es
// la que decide si el artefacto existe, y la que más fácil se afloja después.
//
// EL CASO QUE MAS IMPORTA ES EL DEL PAR, Y ES EL QUE NO SE FIRMA. D24 pide que
// atestigüe EL PROVEEDOR. Cuando el que sirvió fue otro nodo, este gateway no es
// el proveedor: no corrió el modelo, y además el `payTo` del 402 apuntó a la
// wallet del PAR (D10), no a la nuestra. Firmar acá una atestación sobre trabajo
// ajeno sería exactamente la clase de artefacto que parece una prueba y no lo
// es. La atestación del par la firma él y viaja por Protomux: eso es la Fase 10.
export function porQueNoSeFirma({ node, walletAddress, tieneFirmante }) {
  if (!node) return 'no contesto ningun candidato'
  if (node.kind === 'peer') {
    return 'el que sirvio fue otro nodo: su atestacion la firma el, y viaja por Protomux (Fase 10)'
  }
  if (!walletAddress) return 'este nodo no tiene wallet con que firmar'
  if (!tieneFirmante) {
    return 'el keystore no expuso un firmante: no se emite una atestacion sin firma'
  }
  return null
}

// La cuantización que el nodo DECLARA, sacada del nombre del modelo.
//
// Los nombres del registry de QVAC la llevan adentro (`…Q4_K_M`, `…q8_0`,
// `…Q4_0`), así que no hay que inventar un campo nuevo ni tocar el schema
// congelado del manifiesto — que D2 prohíbe y que B19 ya mostró que pelea con
// `additionalProperties: false`.
//
// Es una DECLARACION derivada de otra declaración: si un nodo miente en el
// nombre del modelo, esto miente igual. D26 decide que eso se cubre con stake y
// arbitraje y no con una sonda, porque hoy nadie sabe detectarlo black-box.
// Devuelve 'unknown' cuando el nombre no dice nada, que es más honesto que
// suponer F16.
export function cuantizacionDe(modelId) {
  const s = String(modelId || '')
  const q = s.match(/\b(Q\d+(?:_[A-Za-z0-9]+)*|IQ\d+(?:_[A-Za-z0-9]+)*|BF16|F16|F32)\b/i)
  return q ? q[1].toUpperCase() : 'unknown'
}
