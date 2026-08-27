// Lo que la Fase 9 ya emite, traducido a algo que una PERSONA pueda auditar
// mirando. No agrega ningun dato: lee lo que devuelven los endpoints que ya
// existen y decide como se tiene que ver cada cosa.
//
// -----------------------------------------------------------------------------
// POR QUE ESTE ARCHIVO EXISTE, Y POR QUE NO ESTA ADENTRO DE pages.mjs
//
// La Fase 9 produce cuatro artefactos -- el desafio 402, el recibo de
// liquidacion, la atestacion firmada (D24) y el split prefill/decode (D25) -- y
// hasta ahora los cuatro se servian por HTTP y no se veian en ningun panel. Un
// `grep` de `attestation`, `x402`, `tokensFuente` u `outputHash` sobre pages.mjs
// devolvia CERO en todos.
//
// Eso rompe la regla de los mocks del proyecto: que la atestacion diga
// `runtime: mock`, que falte CON MOTIVO, o que el hash corresponda a lo que se
// sirvio, no lo podia comprobar nadie sin curl. Un artefacto firmado que solo se
// ve con curl no es evidencia para el que tiene que confiar en el nodo.
//
// Vive aparte de `pages.mjs` por una razon de prueba, no de orden: pages.mjs
// exporta strings de HTML, y un test no puede llamar a una funcion que vive
// adentro de un string. Aca son funciones PURAS, que la suite ejercita con las
// respuestas REALES de los endpoints; y el panel recibe EXACTAMENTE ese codigo,
// embebido por `FUENTE_EMBEBIDA` (ver el final del archivo). Una sola
// implementacion, probada del lado del test y ejecutada del lado del navegador.
// Copiadas serian dos, y el test verificaria la que el panel no corre.
//
// -----------------------------------------------------------------------------
// LAS CINCO COSAS QUE ESTE ARCHIVO EXISTE PARA NO DIBUJAR MAL
//
//   1. `attestation: null` NO es un guion. Viene junto a `attestationMissing`,
//      que dice POR QUE falta -- y el caso normal es que haya servido un par y
//      la firma sea de el (Fase 10). Una ausencia con motivo es un dato; una
//      ausencia muda es un agujero que se lee como "no hacia falta".
//   2. `runtime: "mock"` tiene que VERSE como mock. Es una atestacion firmada
//      con una wallet REAL sobre texto inventado del modo --demo: el artefacto
//      es autentico y el contenido es teatro, y las dos cosas a la vez.
//   3. `tokensFuente: "gateway"` no es `"proveedor"` y no se dibuja igual.
//      "gateway" significa que el prefill es una ESTIMACION (bytes/4) y que el
//      decode es un conteo de CHUNKS DE SSE, que no son tokens.
//   4. Un tx hash tiene que decir de donde salio. Lo devuelve el facilitator y
//      esta pagina no toca ninguna cadena: contra el facilitator de pruebas el
//      hash es inventado y en el explorer no existe.
//   5. El costo del header es el TECHO estimado, no el real -- con SSE los
//      headers salen antes del primer token. El chat ya lo dice bien ("up to
//      USD ..." / "no charge") y lo nuevo mantiene ese criterio.
//
// -----------------------------------------------------------------------------
// LO QUE ESTA PAGINA VERIFICA Y LO QUE NO
//
// VERIFICA los hashes: `outputHash` y `promptHash` se RECOMPUTAN aca, con el
// mismo BLAKE2b-256 y la misma canonicalizacion JCS que uso el nodo al firmar,
// contra el texto que el cliente efectivamente recibio. Ese es todo el punto de
// D24 -- el hash es sobre el texto, y el texto no depende de en cuantos pedazos
// viajo, asi que cualquiera puede recontarlo. Que se pueda comparar EN LA
// PANTALLA es la diferencia entre un campo y una prueba.
//
// NO VERIFICA la firma. Recuperar el firmante de un EIP-191 pide keccak256 y
// secp256k1, y este arbol no mete un CDN ni escribe curvas a mano para un panel.
// Lo que hace en cambio es mostrar los BYTES EXACTOS que se firmaron (el JCS del
// artefacto sin `signature`), que es lo que hace falta para verificarla afuera.
// Se dice cual de las dos cosas se hizo, siempre.
//
// El BLAKE2b de abajo esta contrastado contra `sodium.crypto_generichash` en la
// suite unitaria -- vector por vector, incluido el limite de bloque de 128 bytes
// y el UTF-8 multibyte. Un hash escrito a mano que nadie contrasta seria peor
// que no comparar nada: diria "NO COINCIDE" sobre una atestacion correcta.

// -----------------------------------------------------------------------------
// BLAKE2b-256 (RFC 7693)
// -----------------------------------------------------------------------------
//
// Con BigInt y no con pares de 32 bits: son ~20 lineas menos y esto corre una
// vez por respuesta, no en un loop caliente. El algoritmo lo fija `ALG` de
// `qvac/atestacion.mjs`, que hashea con sodium; los dos tienen que dar lo mismo
// y la suite lo comprueba.

const MASCARA64 = 0xffffffffffffffffn

const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n
]

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3]
]

// UTF-8 a mano y no `TextEncoder`, por una razon concreta: `TextEncoder` NO
// existe bajo Bare -- comprobado, da `undefined` --, y el navegador si lo tiene.
// Escribir cada mitad con la API que tiene disponible seria tener dos
// codificadores y contrastar solo uno. Los surrogates sueltos van a U+FFFD, que
// es lo mismo que hace `Buffer.from(s, 'utf8')`, o sea lo que el nodo hasheo al
// firmar.
export function bytesUtf8(texto) {
  const s = String(texto == null ? '' : texto)
  const out = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const sig = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (sig >= 0xdc00 && sig <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (sig - 0xdc00)
        i++
      } else {
        c = 0xfffd
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

function rotarDerecha64(x, n) {
  return ((x >> n) | (x << (64n - n))) & MASCARA64
}

function comprimir(h, bloque, contados, ultimo) {
  const v = new Array(16)
  for (let i = 0; i < 8; i++) v[i] = h[i]
  for (let i = 0; i < 8; i++) v[i + 8] = IV[i]

  v[12] ^= BigInt(contados) & MASCARA64
  v[13] ^= (BigInt(contados) >> 64n) & MASCARA64
  if (ultimo) v[14] ^= MASCARA64

  const m = new Array(16)
  for (let i = 0; i < 16; i++) {
    let x = 0n
    // Little-endian: entra el byte mas alto y se va corriendo hacia abajo.
    for (let b = 7; b >= 0; b--) x = (x << 8n) | BigInt(bloque[i * 8 + b])
    m[i] = x
  }

  function mezclar(a, b, c, d, x, y) {
    v[a] = (v[a] + v[b] + x) & MASCARA64
    v[d] = rotarDerecha64(v[d] ^ v[a], 32n)
    v[c] = (v[c] + v[d]) & MASCARA64
    v[b] = rotarDerecha64(v[b] ^ v[c], 24n)
    v[a] = (v[a] + v[b] + y) & MASCARA64
    v[d] = rotarDerecha64(v[d] ^ v[a], 16n)
    v[c] = (v[c] + v[d]) & MASCARA64
    v[b] = rotarDerecha64(v[b] ^ v[c], 63n)
  }

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r]
    mezclar(0, 4, 8, 12, m[s[0]], m[s[1]])
    mezclar(1, 5, 9, 13, m[s[2]], m[s[3]])
    mezclar(2, 6, 10, 14, m[s[4]], m[s[5]])
    mezclar(3, 7, 11, 15, m[s[6]], m[s[7]])
    mezclar(0, 5, 10, 15, m[s[8]], m[s[9]])
    mezclar(1, 6, 11, 12, m[s[10]], m[s[11]])
    mezclar(2, 7, 8, 13, m[s[12]], m[s[13]])
    mezclar(3, 4, 9, 14, m[s[14]], m[s[15]])
  }

  for (let i = 0; i < 8; i++) h[i] = h[i] ^ v[i] ^ v[i + 8]
}

export function blake2b256Hex(bytes) {
  const h = IV.slice()
  // Parametros: fanout 1, depth 1, keylen 0, digest de 32 bytes -> 0x01010020.
  h[0] ^= 0x01010020n

  const n = bytes.length
  let contados = 0
  let i = 0
  // Estrictamente `>`, no `>=`: el ultimo bloque completo tiene que procesarse
  // como FINAL y no como intermedio. Con `>=` el hash de una entrada de
  // exactamente 128 bytes sale mal, y es el error clasico de esta funcion.
  while (n - i > 128) {
    contados += 128
    comprimir(h, bytes.subarray(i, i + 128), contados, false)
    i += 128
  }
  const cola = new Uint8Array(128)
  cola.set(bytes.subarray(i))
  contados += n - i
  comprimir(h, cola, contados, true)

  let hex = ''
  for (let k = 0; k < 4; k++) {
    let x = h[k]
    for (let b = 0; b < 8; b++) {
      hex += (Number(x & 0xffn) + 256).toString(16).slice(1)
      x >>= 8n
    }
  }
  return hex
}

// El mismo formato que `atestacion.hashDe`: el algoritmo PEGADO al valor, para
// que un tercero sepa con que recomputarlo sin tener que adivinar.
export function hashDeTexto(texto) {
  return 'blake2b-256:' + blake2b256Hex(bytesUtf8(texto))
}

// JCS (RFC 8785), la misma canonicalizacion de `manifest.canonicalize`. Se
// reescribe aca en vez de importarla porque este archivo viaja ENTERO al
// navegador y un import no cruza esa frontera. La suite compara las dos salidas
// campo por campo, que es lo que impide que se separen.
export function canonicalizarJCS(valor) {
  if (valor === null) return 'null'
  const t = typeof valor
  if (t === 'boolean') return valor ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(valor)) throw new Error('JCS: numero no finito')
    return JSON.stringify(valor)
  }
  if (t === 'string') return JSON.stringify(valor)
  if (Array.isArray(valor)) return '[' + valor.map(canonicalizarJCS).join(',') + ']'
  if (t === 'object') {
    const claves = Object.keys(valor)
      .filter(function (k) {
        return valor[k] !== undefined
      })
      .sort()
    return (
      '{' +
      claves
        .map(function (k) {
          return JSON.stringify(k) + ':' + canonicalizarJCS(valor[k])
        })
        .join(',') +
      '}'
    )
  }
  throw new Error('JCS: tipo no serializable (' + t + ')')
}

export function hashDeMensajes(messages) {
  return hashDeTexto(canonicalizarJCS(messages || []))
}

// Los bytes que se firmaron: el artefacto SIN `signature`. Se muestran para que
// la firma se pueda verificar AFUERA, que es lo que esta pagina no hace.
export function bytesFirmados(atestacion) {
  const copia = {}
  const claves = Object.keys(atestacion || {})
  for (let i = 0; i < claves.length; i++) {
    if (claves[i] !== 'signature') copia[claves[i]] = atestacion[claves[i]]
  }
  return canonicalizarJCS(copia)
}

// -----------------------------------------------------------------------------
// Las redes
// -----------------------------------------------------------------------------
//
// El CAIP-2 crudo va SIEMPRE, con el nombre al lado cuando lo conocemos. Un
// panel que muestre solo "Plasma" obliga a creerle al panel; el id es el dato
// que viajo en el `accepts[]` y es contra el que el cliente firma.
const REDES = {
  'eip155:9745': { nombre: 'Plasma', prueba: false },
  'eip155:9746': { nombre: 'Plasma testnet', prueba: true },
  'eip155:988': { nombre: 'Stable', prueba: false }
}

export function etiquetaDeRed(caip2) {
  const id = String(caip2 || '')
  const r = REDES[id]
  return {
    id,
    nombre: r ? r.nombre : null,
    // Una red que no esta en la tabla no se inventa: se muestra el id pelado.
    texto: r ? r.nombre + ' · ' + id : id || 'red no declarada',
    esPrueba: !!(r && r.prueba)
  }
}

// -----------------------------------------------------------------------------
// 1 - El desafio 402
// -----------------------------------------------------------------------------
//
// Los cuatro datos que el DoD de la Fase 9 le exige al 402: CUANTO, A QUIEN, EN
// QUE CADENA y HASTA CUANTOS TOKENS.
//
// El monto va en UNIDADES MINIMAS del activo y NO se convierte a dolares, y eso
// es a proposito: el `accepts[]` declara `asset` y `extra.name`, pero NO declara
// `decimals`. Dividir por 1e6 seria asumir que todo activo tiene 6 -- la tabla
// de x402 tiene de 18 tambien -- o sea inventar el dato que falta justo en el
// numero que la persona va a leer como "lo que me van a cobrar".
export function vistaDeDesafio(cuerpo) {
  const body = cuerpo || {}
  const accepts = Array.isArray(body.accepts) ? body.accepts : []
  if (!accepts.length) return { esDesafio: false, error: null, opciones: [] }

  return {
    esDesafio: true,
    x402Version: body.x402Version == null ? null : body.x402Version,
    // Cuando el 402 es un REINTENTO -- el pago anterior no verifico -- el
    // gateway le agrega `error` con el motivo. Que se vea: sin eso, un cliente
    // que firmo mal recibe el mismo 402 dos veces y no sabe que cambio.
    error: body.error && body.error !== 'X-PAYMENT header is required' ? String(body.error) : null,
    opciones: accepts.map(function (a) {
      return {
        // CUANTO
        monto: String(a.amount == null ? '' : a.amount),
        activo: String(a.asset || ''),
        activoNombre: (a.extra && a.extra.name) || null,
        // El `accepts[]` no declara `decimals`, asi que el monto no se convierte
        // a USD sin inventar. Se dice, en vez de dividir por 1e6 y esperar.
        avisoMonto:
          'en unidades minimas del activo — el 402 no declara los decimales, ' +
          'asi que esta pagina no lo convierte a USD',
        // A QUIEN
        payTo: String(a.payTo || ''),
        // EN QUE CADENA
        red: etiquetaDeRed(a.network),
        // HASTA CUANTOS TOKENS
        tope: Number.isFinite(Number(a.outputTokenLimit)) ? Number(a.outputTokenLimit) : null,
        esquema: String(a.esquema || a.scheme || ''),
        recurso: String(a.resource || ''),
        descripcion: String(a.description || ''),
        validezSeg: Number.isFinite(Number(a.maxTimeoutSeconds))
          ? Number(a.maxTimeoutSeconds)
          : null
      }
    })
  }
}

// -----------------------------------------------------------------------------
// 2 - El recibo de liquidacion
// -----------------------------------------------------------------------------
//
// De donde sale el tx hash, y por que no se presenta como un hecho de la cadena:
// lo devuelve el FACILITATOR que liquido, y ni el gateway ni esta pagina miran
// ninguna cadena para comprobarlo. Contra el facilitator de pruebas el hash es
// inventado -- `0xfefe...fe` -- y en el explorer no existe.
//
// El sello `txSintetico` NO es una heuristica sobre "hashes que parecen falsos":
// es una propiedad del propio valor. Un hash de transaccion es la salida de
// keccak sobre la transaccion; que sus 32 bytes sean todos IGUALES no pasa en la
// practica, y si es exactamente lo que emite un facilitator de juguete. Se marca
// lo que se puede afirmar del valor; el resto se dice como advertencia para
// TODOS los hashes por igual, tambien los que parecen buenos.
export function vistaDeLiquidacion(recibo) {
  const r = recibo || {}
  const tx = String(r.transaction || '')
  const cuerpo = tx.indexOf('0x') === 0 ? tx.slice(2) : tx
  const bytes = cuerpo.length >= 2 ? cuerpo.toLowerCase().match(/../g) || [] : []
  const todosIguales =
    bytes.length > 1 &&
    bytes.every(function (b) {
      return b === bytes[0]
    })

  return {
    liquidado: r.success === true,
    // Un `success: false` NO es un detalle de forma: el nodo sirvio y no cobro.
    // D12 lo acepta a cambio de no poner una transaccion on-chain delante del
    // TTFT, y es lo que la Fase 10 arregla acumulando recibos.
    error:
      r.success === true
        ? null
        : [r.errorReason, r.errorMessage].filter(Boolean).join(': ') ||
          'la liquidacion no informo exito',
    tx: tx || null,
    txSintetico: todosIguales,
    // El origen va SIEMPRE, con hash real o de juguete. Un hash sin procedencia
    // se lee como una transaccion confirmada, y aca no se confirmo nada.
    txOrigen: tx
      ? todosIguales
        ? 'sus 32 bytes son todos iguales: es el sello de un facilitator de PRUEBAS, ' +
          'no existe en ningun explorer'
        : 'lo devolvio el facilitator que liquido; ni el nodo ni esta pagina lo ' +
          'verificaron contra la cadena'
      : null,
    red: etiquetaDeRed(r.network),
    payer: r.payer ? String(r.payer) : null
  }
}

// -----------------------------------------------------------------------------
// 3 - La atestacion del proveedor (D24)
// -----------------------------------------------------------------------------
//
// `attestation: null` viene acompanada de `attestationMissing`, que dice POR QUE
// falta. Ese motivo ES el dato: el caso normal es que haya servido un par, y
// entonces la firma que corresponde es la de EL (Fase 10) -- este nodo no
// atestigua trabajo ajeno. Dibujar un guion ahi convierte una decision de diseno
// en un agujero.
//
// `textoRecibido` y `messages` son opcionales: cuando estan, los hashes se
// RECOMPUTAN y se comparan. Cuando no, se dice que no se comparo -- que no es lo
// mismo que "coincide", y son tres estados distintos a proposito.
export function vistaDeAtestacion(recibo, contexto) {
  const r = recibo || {}
  const ctx = contexto || {}
  const a = r.attestation || null

  if (!a) {
    const motivo = r.attestationMissing ? String(r.attestationMissing) : null
    return {
      hay: false,
      // Sin atestacion Y sin motivo la respuesta esta incompleta, y eso se dice
      // asi: es distinto de "no habia que firmar".
      motivo:
        motivo ||
        'el recibo no trae atestacion NI el motivo por el que falta: es una respuesta ' +
          'incompleta, no una ausencia justificada',
      motivoDeclarado: !!motivo,
      // El unico caso en que la ausencia es lo CORRECTO y no una falla: sirvio
      // un par, cobro su wallet, y su atestacion la firma el (Fase 10).
      esDelPar: !!(motivo && motivo.indexOf('otro nodo') !== -1)
    }
  }

  const runtime = String(a.runtime || 'unknown')
  // Un mock firmado con una wallet REAL sigue siendo un mock. El artefacto es
  // autentico y el texto es inventado, y las dos cosas tienen que verse juntas.
  const esMock = runtime === 'mock' || runtime.indexOf('mock') === 0

  const hashes = [
    comparacionDeHash('outputHash', a.outputHash, ctx.textoRecibido, hashDeTexto),
    comparacionDeHash('promptHash', a.promptHash, ctx.messages, hashDeMensajes)
  ]

  return {
    hay: true,
    version: a.v == null ? null : a.v,
    requestId: String(a.requestId || ''),
    nonce: String(a.nonce || ''),
    ts: Number(a.ts) || null,
    modelId: a.modelId == null ? null : String(a.modelId),
    // DECLARADOS, no medidos (D26). No hay forma black-box publicada de
    // verificar la cuantizacion: lo que sostiene estos dos campos es que estan
    // firmados y que hay stake detras, no una medicion.
    quantization: String(a.quantization || 'unknown'),
    runtime,
    declarados: 'quantization y runtime son DECLARACIONES firmadas, no mediciones (D26)',
    esMock,
    avisoMock: esMock
      ? 'MOCK: el texto lo invento el modo --demo. La firma es de una wallet REAL sobre ' +
        'texto que ningun modelo genero — el artefacto es autentico y el contenido es teatro'
      : null,
    finishReason: String(a.finishReason || ''),
    finishTexto: textoDeFinishReason(a.finishReason),
    // La atestacion NO lleva `tokensFuente`: el que lo declara es el rastro de
    // ruteo (D25). Se pasa por `vistaDeConteo` igual para que los dos numeros
    // nunca se dibujen como una medicion cuando nadie dijo que lo sean.
    conteo: vistaDeConteo({
      tokensPrefill: a.tokensPrefill,
      tokensDecode: a.tokensDecode,
      tokensFuente: ctx.tokensFuente
    }),
    providerPubkey: String(a.providerPubkey || ''),
    signature: String(a.signature || ''),
    // Los bytes contra los que se firmo, para poder verificarla AFUERA.
    firmadoSobre: bytesFirmados(a),
    firmaVerificada: false,
    avisoFirma:
      'esta pagina NO verifica la firma — recuperar el firmante de un EIP-191 pide ' +
      'keccak256 y secp256k1, y aca no entra un CDN. Los hashes SI se recomputan; ' +
      'para verificar la firma, los bytes firmados estan abajo',
    hashes
  }
}

// Recomputa un hash y lo compara, o dice que no se comparo. Las cuatro salidas
// son distintas a proposito, y la que mas importa es `sin-material`: "no lo pude
// comparar" no es "coincide", y un panel que las mezcle convierte la falta de
// evidencia en evidencia.
function comparacionDeHash(campo, declarado, material, recomputar) {
  const dec = declarado == null ? null : String(declarado)
  if (!dec) {
    return { campo, declarado: null, estado: 'sin-dato', texto: 'la atestacion no lo trae' }
  }
  if (material === undefined || material === null) {
    return {
      campo,
      declarado: dec,
      estado: 'sin-material',
      texto: 'no se recomputo: esta vista no tiene contra que compararlo'
    }
  }
  let calculado = null
  try {
    calculado = recomputar(material)
  } catch (err) {
    return {
      campo,
      declarado: dec,
      estado: 'error',
      texto: 'no se pudo recomputar: ' + ((err && err.message) || err)
    }
  }
  const coincide = calculado === dec
  return {
    campo,
    declarado: dec,
    calculado,
    estado: coincide ? 'coincide' : 'no-coincide',
    texto: coincide
      ? 'recomputado sobre lo que se recibio: coincide'
      : 'recomputado sobre lo que se recibio: NO coincide'
  }
}

// D27 en palabras. `client_cancelled` es vocabulario propio y mas ancho que el
// de OpenAI: aplanarlo a `stop` afirmaria que la respuesta termino.
export function textoDeFinishReason(reason) {
  const r = String(reason || '')
  if (r === 'stop') return 'termino sola'
  if (r === 'length') return 'se corto en el tope de tokens que declaro el 402 (D9)'
  if (r === 'client_cancelled') {
    return 'lo corto el cliente: se atestigua el prefijo emitido (D27 caso 1)'
  }
  return r || 'no declarado'
}

// -----------------------------------------------------------------------------
// 4 - El split prefill/decode y su procedencia (D25)
// -----------------------------------------------------------------------------
//
// `proveedor` y `gateway` NO son la misma clase de numero y no pueden dibujarse
// igual. Con `gateway` el prefill es una ESTIMACION del prompt y el decode es un
// conteo de CHUNKS DE SSE -- y quien decide como se trocea el stream es el
// proveedor, o sea que ese numero lo mueve el otro lado sin mentir en ningun
// campo y sin romper ninguna validacion. Es el ataque que D24 cierra con el
// `outputHash`, y es la razon por la que la procedencia va al lado del numero y
// no en una nota al pie.
export function vistaDeConteo(entrada) {
  const e = entrada || {}
  const fuente = e.tokensFuente == null ? null : String(e.tokensFuente)
  const prefill = Number.isFinite(Number(e.tokensPrefill)) ? Number(e.tokensPrefill) : null
  const decode = Number.isFinite(Number(e.tokensDecode)) ? Number(e.tokensDecode) : null

  if (fuente === null) {
    return {
      fuente: null,
      medido: false,
      prefill,
      decode,
      // Las entradas anteriores a D25 no tienen el campo, y la atestacion no lo
      // lleva nunca. Decir "gateway" aca seria afirmar algo que el dato no dice.
      etiqueta: 'sin procedencia',
      texto:
        'no declara de donde salieron estos numeros: el que lo dice es el rastro de ruteo (D25)',
      tono: 'ausente'
    }
  }
  if (fuente === 'proveedor') {
    return {
      fuente,
      medido: true,
      prefill,
      decode,
      etiqueta: 'medido',
      texto:
        'los dos numeros salieron del `usage` del proveedor: son tokens contados por su tokenizador',
      tono: 'medido'
    }
  }
  return {
    fuente,
    medido: false,
    prefill,
    decode,
    etiqueta: 'estimado',
    texto:
      'NO son tokens medidos: el prefill es una estimacion del prompt (bytes/4) y el decode es ' +
      'un conteo de CHUNKS DE SSE, que no son tokens — quien decide como se trocea el ' +
      'stream es el proveedor',
    tono: 'estimado'
  }
}

// -----------------------------------------------------------------------------
// El costo del header (regla 5)
// -----------------------------------------------------------------------------
//
// Con SSE los headers salen ANTES del primer token, asi que
// `X-Pyrus-Cost-Estimate-Micros` es el TECHO con el que se autorizo el gasto y
// nunca lo que salio. El chat ya lo decia bien ("up to USD ..." / "no charge");
// esto es la misma regla en un solo lugar, para que lo nuevo no la afloje.
export function textoDeCostoEstimado(micros) {
  const n = Number(micros)
  if (!Number.isFinite(n)) return { texto: 'sin dato de costo', techo: false }
  if (n <= 0) return { texto: 'no charge', techo: false }
  // Seis decimales y no cuatro: con cuatro, cualquier turno de menos de 50
  // micros se muestra "USD 0.0000", o sea identico a gratis, que es justo la
  // distincion que esta linea existe para hacer.
  const s = (n / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return { texto: 'up to USD ' + s, techo: true }
}

// -----------------------------------------------------------------------------
// EL DIBUJO
// -----------------------------------------------------------------------------
//
// Los renderers viven ACA y no en pages.mjs, y no es por prolijidad: las cinco
// cosas que este trabajo existe para no dibujar mal se pierden en el dibujo, no
// en el modelo. Un `vistaDeAtestacion` perfecto que la pagina pinta como "—" no
// arregla nada. Estando aca, la suite puede afirmar sobre el HTML mismo -- que
// el motivo de la ausencia APARECE, que el mock se ve, que "estimado" no se
// pinta igual que "medido" -- y `bug-puesto` puede romperlos y ver caer el test.
//
// pages.mjs sigue siendo el dueno del CSS y del layout; lo que se decide aca es
// QUE dice cada bloque, no como se ve.

function escaparHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function filaDato(etiqueta, valor, clase) {
  return (
    '<div class="x-fila"><span class="x-k">' +
    escaparHtml(etiqueta) +
    '</span><span class="x-v ' +
    (clase || '') +
    '">' +
    escaparHtml(valor) +
    '</span></div>'
  )
}

// El 402, con los CUATRO datos que el DoD exige, cada uno nombrado. No se
// resumen en una frase: "hasta 256 tokens por 1000 unidades a 0xab...ab en
// Stable" se lee lindo y esconde cual numero es cual.
export function htmlDeDesafio(vista) {
  const v = vista || {}
  if (!v.esDesafio) return ''
  const partes = [
    '<div class="x402">',
    '<div class="x-tit">402 · este nodo pide pago antes de generar un solo token</div>'
  ]
  if (v.error) {
    partes.push(
      '<div class="x-aviso malo">el pago anterior no verifico: ' + escaparHtml(v.error) + '</div>'
    )
  }
  for (let i = 0; i < v.opciones.length; i++) {
    const o = v.opciones[i]
    partes.push('<div class="x-op">')
    partes.push(filaDato('CUANTO', o.monto + (o.activoNombre ? ' ' + o.activoNombre : ''), 'mono'))
    partes.push('<div class="x-nota">' + escaparHtml(o.avisoMonto) + '</div>')
    partes.push(filaDato('activo', o.activo, 'mono'))
    partes.push(filaDato('A QUIEN', o.payTo, 'mono'))
    partes.push(
      filaDato('EN QUE RED', o.red.texto + (o.red.esPrueba ? ' — red de PRUEBA' : ''), 'mono')
    )
    partes.push(
      filaDato(
        'HASTA CUANTOS TOKENS',
        o.tope === null ? 'no declarado' : o.tope + ' tokens de salida'
      )
    )
    partes.push(
      filaDato(
        'esquema',
        o.esquema + (o.validezSeg === null ? '' : ' · la firma vale ' + o.validezSeg + ' s')
      )
    )
    partes.push('</div>')
  }
  partes.push(
    '<div class="x-nota">El tope de salida es el mismo numero que el gateway aplica despues, ' +
      'y por eso el precio fijo es honesto (D9). Pagar es re-enviar el request con el header ' +
      'X-PAYMENT firmado.</div>'
  )
  partes.push('</div>')
  return partes.join('')
}

// El badge de procedencia del conteo. `medido` y `estimado` NO comparten clase
// ni texto: es la regla 3, y es lo unico que separa un token contado por el
// tokenizador del proveedor de un chunk de SSE.
export function htmlDeConteo(vista) {
  const c = vista || {}
  const n = function (x) {
    return x === null ? '?' : String(x)
  }
  return (
    '<span class="x-conteo tono-' +
    escaparHtml(c.tono) +
    '" title="' +
    escaparHtml(c.texto) +
    '">prefill ' +
    escaparHtml(n(c.prefill)) +
    ' · decode ' +
    escaparHtml(n(c.decode)) +
    ' · <b>' +
    escaparHtml(c.etiqueta) +
    '</b></span>'
  )
}

export function htmlDeLiquidacion(vista) {
  const v = vista || {}
  const partes = ['<div class="x-bloque">', '<div class="x-tit">Recibo de liquidacion (x402)</div>']
  partes.push(
    v.liquidado
      ? '<div class="x-aviso bueno">el facilitator informo la liquidacion como exitosa</div>'
      : '<div class="x-aviso malo">NO se cobro: ' +
          escaparHtml(v.error) +
          ' — el nodo sirvio igual, que es lo que D12 acepta a cambio de no poner una ' +
          'transaccion on-chain delante del primer token</div>'
  )
  partes.push(filaDato('red', v.red.texto + (v.red.esPrueba ? ' — red de PRUEBA' : ''), 'mono'))
  if (v.payer) partes.push(filaDato('pago', v.payer, 'mono'))
  if (v.tx) {
    partes.push(filaDato('tx hash', v.tx, 'mono'))
    // Regla 4: el hash NUNCA sale sin decir de donde vino.
    partes.push(
      '<div class="x-aviso ' +
        (v.txSintetico ? 'malo' : 'tibio') +
        '">' +
        escaparHtml(v.txOrigen) +
        '</div>'
    )
  } else {
    partes.push(filaDato('tx hash', 'no lo devolvio el facilitator'))
  }
  partes.push('</div>')
  return partes.join('')
}

export function htmlDeAtestacion(vista) {
  const v = vista || {}
  if (!v.hay) {
    // Regla 1: la ausencia va CON EL MOTIVO. El caso del par no es una falla y
    // se dice asi; cualquier otro se marca mas fuerte.
    return (
      '<div class="x-bloque">' +
      '<div class="x-tit">Atestacion del proveedor (D24)</div>' +
      '<div class="x-aviso ' +
      (v.esDelPar ? 'tibio' : v.motivoDeclarado ? 'tibio' : 'malo') +
      '"><b>no hay atestacion</b> — ' +
      escaparHtml(v.motivo) +
      '</div>' +
      (v.esDelPar
        ? '<div class="x-nota">Es lo correcto: este nodo no corrio el modelo y el 402 pago a ' +
          'la wallet del par. Firmar aca seria el artefacto que parece prueba y no lo es.</div>'
        : '') +
      '</div>'
    )
  }

  const partes = [
    '<div class="x-bloque">',
    '<div class="x-tit">Atestacion del proveedor (D24)</div>'
  ]

  // Regla 2: el mock se ve, arriba de todo y no en una nota al pie.
  if (v.esMock) {
    partes.push(
      '<div class="x-aviso malo"><b>runtime: mock</b> — ' + escaparHtml(v.avisoMock) + '</div>'
    )
  }

  partes.push(filaDato('modelo', v.modelId === null ? 'no declarado' : v.modelId, 'mono'))
  partes.push(filaDato('runtime', v.runtime, v.esMock ? 'mono malo' : 'mono'))
  partes.push(filaDato('cuantizacion', v.quantization, 'mono'))
  partes.push('<div class="x-nota">' + escaparHtml(v.declarados) + '</div>')
  partes.push(filaDato('termino', v.finishReason + ' — ' + v.finishTexto))
  partes.push(
    '<div class="x-fila"><span class="x-k">tokens</span><span class="x-v">' +
      htmlDeConteo(v.conteo) +
      '</span></div>'
  )
  partes.push(filaDato('requestId', v.requestId, 'mono'))
  partes.push(filaDato('nonce', v.nonce, 'mono'))
  partes.push(filaDato('firmada por', v.providerPubkey, 'mono'))

  // Los hashes: el corazon de D24. Cada uno dice si se recomputo y contra que.
  for (let i = 0; i < v.hashes.length; i++) {
    const h = v.hashes[i]
    partes.push(filaDato(h.campo, h.declarado === null ? '—' : h.declarado, 'mono'))
    partes.push(
      '<div class="x-aviso ' +
        (h.estado === 'coincide' ? 'bueno' : h.estado === 'no-coincide' ? 'malo' : 'tibio') +
        '">' +
        escaparHtml(h.texto) +
        (h.estado === 'no-coincide' ? ' — recomputado: ' + escaparHtml(h.calculado) : '') +
        '</div>'
    )
  }

  partes.push(filaDato('firma', v.signature, 'mono'))
  partes.push('<div class="x-aviso tibio">' + escaparHtml(v.avisoFirma) + '</div>')
  partes.push(
    '<details class="x-det"><summary>los bytes que se firmaron (JCS sin el campo signature)</summary>' +
      '<pre class="x-pre">' +
      escaparHtml(v.firmadoSobre) +
      '</pre></details>'
  )
  partes.push('</div>')
  return partes.join('')
}

// El mismo recibo llega con DOS formas y las dos hay que aceptar, porque las
// dos las emite el gateway hoy:
//
//   - evento SSE final: el recibo de liquidacion cuelga de `paymentResponse`,
//     con `x402Note` explicando por que no vino en el header (D12);
//   - `GET /v1/receipts/:id`: el mismo recibo va APLANADO en la raiz, que es la
//     forma que ya leen los clientes y el test.
//
// La atestacion, en las dos, va al lado y en su propia clave.
export function liquidacionDe(recibo) {
  const r = recibo || {}
  return r.paymentResponse ? r.paymentResponse : r
}

// El recibo entero: liquidacion y atestacion UNA AL LADO DE LA OTRA, porque
// prueban mitades distintas del mismo intercambio -- el recibo, que alguien
// pago; la atestacion, que este nodo entrego esto -- y separarlas deja a cada
// una pareciendo la prueba completa.
export function htmlDeRecibo(recibo, contexto) {
  return (
    '<div class="x402 x-par">' +
    htmlDeLiquidacion(vistaDeLiquidacion(liquidacionDe(recibo))) +
    htmlDeAtestacion(vistaDeAtestacion(recibo, contexto)) +
    '</div>'
  )
}

// -----------------------------------------------------------------------------
// LO QUE VIAJA AL NAVEGADOR
// -----------------------------------------------------------------------------
//
// El panel corre EXACTAMENTE estas funciones: se serializan con `String(fn)` y
// se pegan adentro del `<script>` de cada pagina. No es un truco de empaquetado
// -- es lo que hace que el test y el panel no puedan divergir, que es todo el
// motivo por el que este archivo esta separado de pages.mjs.
//
// `bare-pack` no minifica (no tiene minificador entre sus dependencias, se
// miro), asi que el texto que sale de `String(fn)` adentro del binario
// standalone es el mismo que en el arbol.
//
// Los NOMBRES salen de las claves de este objeto y NO de `fn.name`: si algun dia
// entra un minificador, `fn.name` se mangla y las claves literales no.
//
// El orden es el de dependencia: cada funcion solo puede llamar a las que ya se
// declararon arriba, mas las constantes de `CONSTANTES_EMBEBIDAS`.
const CONSTANTES_EMBEBIDAS =
  'var MASCARA64 = ' +
  MASCARA64 +
  'n;\n' +
  'var IV = [' +
  IV.map(function (x) {
    return x + 'n'
  }).join(',') +
  '];\n' +
  'var SIGMA = ' +
  JSON.stringify(SIGMA) +
  ';\n' +
  'var REDES = ' +
  JSON.stringify(REDES) +
  ';\n'

const FUNCIONES_EMBEBIDAS = {
  bytesUtf8,
  rotarDerecha64,
  comprimir,
  blake2b256Hex,
  hashDeTexto,
  canonicalizarJCS,
  hashDeMensajes,
  bytesFirmados,
  etiquetaDeRed,
  vistaDeDesafio,
  vistaDeLiquidacion,
  comparacionDeHash,
  textoDeFinishReason,
  vistaDeConteo,
  vistaDeAtestacion,
  textoDeCostoEstimado,
  escaparHtml,
  filaDato,
  htmlDeDesafio,
  htmlDeConteo,
  htmlDeLiquidacion,
  htmlDeAtestacion,
  liquidacionDe,
  htmlDeRecibo
}

export const FUENTE_EMBEBIDA =
  '// ---- qvac/panel-x402.mjs, embebido tal cual: ver la nota de ese archivo ----\n' +
  CONSTANTES_EMBEBIDAS +
  Object.keys(FUNCIONES_EMBEBIDAS)
    .map(function (n) {
      return 'var ' + n + ' = ' + String(FUNCIONES_EMBEBIDAS[n]) + ';'
    })
    .join('\n\n') +
  '\n'
