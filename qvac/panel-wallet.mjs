// El panel /wallet: la wallet de COBRO de este nodo.
//
// -----------------------------------------------------------------------------
// POR QUE ESTE ARCHIVO EXISTE, Y POR QUE NO ESTA ADENTRO DE pages.mjs
//
// Mismo motivo que `qvac/panel-x402.mjs`: pages.mjs exporta strings de HTML, y
// un test no puede llamar a una funcion que vive adentro de un string. Aca son
// funciones PURAS que la suite ejercita, y el panel recibe EXACTAMENTE ese
// codigo, serializado con `String(fn)` por `FUENTE_EMBEBIDA_WALLET`. Una sola
// implementacion, probada del lado del test y ejecutada del lado del navegador.
//
// -----------------------------------------------------------------------------
// LO QUE ESTE PANEL NO HACE, Y NO POR AHORA NADA MAS
//
//   1. NO convierte a USD. El screenshot de referencia muestra "$0" al lado de
//      cada activo; este panel no consulta ningun feed de precios, y dividir un
//      balance por una cotizacion que nadie miro es inventar el numero que la
//      persona va a leer como "lo que tengo". El saldo va en el simbolo del
//      activo, con "sin conversion a USD" dicho al lado. Misma regla que el
//      `avisoMonto` de panel-x402.
//   2. NO afirma un balance cuando el RPC no contesto. Un error de lectura se
//      dibuja como "—" y con el motivo, NUNCA como "0" — que se leeria como
//      "esta wallet esta vacia". Lo mismo el historial: una lectura que fallo
//      no se dibuja como "no hay movimientos".
//   3. La direccion del contrato de USD₮0 en Plasma NO esta verificada contra
//      la cadena (ver `qvac/x402.mjs`), y los tokens que alguien agrega a mano
//      en Settings tampoco. Para LEER un balance eso es inocuo — no se manda
//      nada —, pero igual se marca "sin verificar" en la fila. Para ENVIAR no
//      lo es, y la pantalla de revision lo repite ahi.
//   4. Swap, Stake, el connect flow de dApps y revelar la frase NO estan, y sus
//      botones se dibujan DESHABILITADOS, no ocultos: que se vea que existen y
//      que todavia no.
//
// -----------------------------------------------------------------------------
// FASE 12 — LAS TRES DECISIONES DE ESTA FASE
//
// (a) LA CONFIGURACION SE VA DETRAS DEL ☰. Antes el selector de red vivia
//     suelto abajo de la lista de activos: una billetera que muestra su
//     configuracion permanentemente al lado del saldo. Ahora `htmlDeWallet` NO
//     dibuja NADA de configuracion — todo esta en `htmlDeSettings`, que es un
//     overlay adentro de la tarjeta. Y mientras esta abierto el poll de 15 s no
//     repinta, por el mismo motivo que no repinta sobre la pantalla de la frase:
//     un formulario a medio llenar no se puede pisar solo.
//
// (b) EL QR SE DIBUJA ACA, SIN LIBRERIAS. R2 prohibe dependencias nuevas y
//     `bare-pack` sigue el grafo de imports, asi que no hay CDN ni archivo
//     suelto: el encoder es JS propio, serializable con `String(fn)` como todo
//     lo demas. Version fija v3-L — ver el bloque de `qrMatriz`.
//
// (c) ENVIAR SE PIDE, NO SE FIRMA. La invariante de `wallet.mjs` no se afloja:
//     la seed no sale del proceso que la abre. El panel POSTEA a
//     `/v1/wallet/send` y el gateway le pide la transaccion a un closure que
//     `bin.mjs` le inyecto (`setWalletSender`), igual que ya hacia con
//     `setWalletSigner` para las atestaciones de D24. Del navegador salen tres
//     strings —destino, monto, activo—; nunca una clave.
//
// -----------------------------------------------------------------------------
// LO QUE VIAJA AL NAVEGADOR
//
// El panel corre EXACTAMENTE estas funciones. `bare-pack` no minifica, asi que
// el texto de `String(fn)` adentro del binario standalone es el mismo que en el
// arbol. Los NOMBRES salen de las claves de `FUNCIONES_EMBEBIDAS`, no de
// `fn.name`. El orden es el de dependencia: cada funcion solo llama a las que
// ya se declararon arriba, mas `SIMBOLO_NATIVO`.

// El simbolo del activo nativo (gas) de cada red, para pantalla. Es un dato de
// display: si una red no esta en la tabla, la fila dice "nativo" y no se
// inventa un ticker. Plasma mainnet y su testnet comparten token.
const SIMBOLO_NATIVO = {
  'eip155:9745': 'XPL',
  'eip155:9746': 'XPL'
}

// Las redes que el selector del panel ofrece — las mismas de `wallet.REDES`.
// `stable` (988) NO está: es un fallback de cobro x402, no una red de wallet
// (no tiene RPC ni explorer propios acá). El orden pone la testnet primero: es
// donde D30 dice que se estrena todo lo que mueve valor.
const REDES_PANEL = [
  { nombre: 'plasma-testnet', etiqueta: 'Plasma testnet · 9746', mainnet: false },
  { nombre: 'plasma', etiqueta: 'Plasma mainnet · 9745 — real money', mainnet: true }
]

export function escaparHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Un balance llega como hex ('0x1a') del `eth_call`/`eth_getBalance` o, por las
// dudas, como decimal. Cualquier cosa que no parsee es 0n y no un throw: el
// panel tiene que dibujar algo, y el caso "no se pudo leer" ya viaja aparte en
// `error`.
export function aBigInt(v) {
  const s = String(v == null ? '0' : v).trim()
  if (s === '') return 0n
  try {
    return BigInt(s)
  } catch (e) {
    return 0n
  }
}

// Unidades minimas -> texto humano, SIN redondear. La fraccion se RECORTA a
// `maxFrac` digitos (no se redondea: mostrar 1.235 cuando hay 1.2349 es decir
// que hay mas plata de la que hay) y despues se le sacan los ceros de la cola.
// Si no queda fraccion, se muestra el entero pelado.
export function formatearMonto(raw, decimals, maxFrac) {
  let d = Number(decimals)
  if (!Number.isFinite(d) || d < 0) d = 0
  const n = aBigInt(raw)
  const base = 10n ** BigInt(d)
  const entero = (n / base).toString()
  const fraccion = d ? (n % base).toString().padStart(d, '0') : ''
  let frac = fraccion
  if (maxFrac != null && maxFrac >= 0) frac = frac.slice(0, maxFrac)
  frac = frac.replace(/0+$/, '')
  return { entero, fraccion, texto: frac ? entero + '.' + frac : entero }
}

// '0x1234abcd…' -> '0x1234…abcd'. Lo que no parezca una direccion se devuelve
// tal cual: el que llama a veces pasa null o '' y el panel ya lo maneja.
export function truncarDireccion(addr) {
  const s = String(addr || '')
  if (!/^0x[0-9a-fA-F]{8,}$/.test(s)) return s
  return s.slice(0, 6) + '…' + s.slice(-4)
}

export function simboloNativo(caip2) {
  return SIMBOLO_NATIVO[String(caip2 || '')] || 'nativo'
}

// Normaliza lo que alguien pega en el textarea de importar: colapsa espacios y
// saltos de linea, baja a minuscula, tira los vacios. BIP-39 es todo minuscula
// y una sola palabra por token.
export function palabrasDeFrase(texto) {
  return String(texto || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

// Chequeo de FORMA para el boton de importar, no de validez: el checksum
// BIP-39 lo valida el nodo (`wallet.fraseValida`), que es el unico que puede.
// Esto solo evita mandar al server algo que obviamente no es una frase.
export function fraseParecePlausible(texto) {
  const p = palabrasDeFrase(texto)
  if ([12, 15, 18, 21, 24].indexOf(p.length) === -1) return false
  return p.every(function (w) {
    return /^[a-z]+$/.test(w)
  })
}

// Filtra la lista por el texto del buscador. Mira simbolo, nombre y la linea
// de abajo (la red del nativo, la direccion del token): "9745" o "plasma"
// tienen que encontrar el activo nativo igual que "XPL".
export function filtrarItems(items, q) {
  const arr = Array.isArray(items) ? items : []
  const s = String(q || '')
    .trim()
    .toLowerCase()
  if (!s) return arr
  return arr.filter(function (it) {
    return (
      String(it.symbol || '')
        .toLowerCase()
        .indexOf(s) !== -1 ||
      String(it.name || '')
        .toLowerCase()
        .indexOf(s) !== -1 ||
      String(it.sub || '')
        .toLowerCase()
        .indexOf(s) !== -1
    )
  })
}

// Lo que devuelve `GET /v1/wallet/balances`, normalizado para el dibujo. El
// endpoint es un lector fino: la forma de cada numero se decide ACA.
export function vistaDeSaldos(data) {
  const d = data || {}

  const red = d.red
    ? {
        nombre: String(d.red.nombre || ''),
        caip2: String(d.red.caip2 || ''),
        texto: (d.red.nombre ? d.red.nombre + ' · ' : '') + String(d.red.caip2 || ''),
        // Sin `mainnet: true` explicito se asume red de prueba: el error barato
        // es una etiqueta "PRUEBA" de mas, el caro es creer que es testnet y no.
        esPrueba: !d.red.mainnet,
        mainnet: !!d.red.mainnet,
        explorer: d.red.explorer ? String(d.red.explorer) : null,
        // FASE 11 — si el entorno la fija, el selector se dibuja como texto.
        fijadaPorEnv: !!d.red.fijadaPorEnv
      }
    : null

  const items = []

  if (d.nativo) {
    const dec = d.nativo.decimals == null ? 18 : d.nativo.decimals
    const m = formatearMonto(d.nativo.raw, dec, 6)
    items.push({
      clave: 'nativo',
      esNativo: true,
      symbol: simboloNativo(red && red.caip2),
      name: (d.red && d.red.nombre) || 'native asset',
      sub: red ? red.texto : '',
      decimals: dec,
      raw: d.nativo.raw == null ? null : String(d.nativo.raw),
      // Regla 3: sin dato se dice "—", nunca "0".
      texto: d.nativo.raw == null ? '—' : m.texto,
      error: d.nativo.error ? String(d.nativo.error) : null,
      verificado: true
    })
  }

  const toks = Array.isArray(d.tokens) ? d.tokens : []
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i] || {}
    const dec = tk.decimals == null ? 6 : tk.decimals
    const m = formatearMonto(tk.raw, dec, 6)
    items.push({
      clave: 'tok:' + String(tk.address || i),
      esNativo: false,
      symbol: String(tk.symbol || '???'),
      name: String(tk.name || tk.symbol || 'token'),
      sub:
        truncarDireccion(tk.address) +
        (tk.verificado ? '' : ' · address unverified against the chain'),
      decimals: dec,
      raw: tk.raw == null ? null : String(tk.raw),
      texto: tk.raw == null ? '—' : m.texto,
      error: tk.error ? String(tk.error) : null,
      verificado: !!tk.verificado
    })
  }

  // FASE 12 — los tokens que este nodo tiene GUARDADOS para la red activa, tal
  // como salieron del archivo. Es la lista que administra Settings, y no es lo
  // mismo que `items`: ahi estan mezclados con el nativo y con USD₮0, ya con su
  // balance leido. Aca van pelados, que es lo que hace falta para poder
  // quitarlos.
  const guardados = []
  const gs = Array.isArray(d.tokensGuardados) ? d.tokensGuardados : []
  for (let i = 0; i < gs.length; i++) {
    const t = gs[i] || {}
    guardados.push({
      address: String(t.address || ''),
      addressCorta: truncarDireccion(t.address),
      symbol: String(t.symbol || '???'),
      decimals: t.decimals == null ? 0 : Number(t.decimals)
    })
  }

  return {
    configurada: !!d.configurada && !!d.address,
    address: d.address ? String(d.address) : null,
    addressCorta: truncarDireccion(d.address),
    red,
    items,
    n: items.length,
    tokensGuardados: guardados,
    // FASE 12 — lo que Settings muestra de solo lectura. Sin dato NO se inventa
    // un default: si el nodo no lo mando, la fila no se dibuja.
    info: d.info
      ? {
          rpc: d.info.rpc ? String(d.info.rpc) : null,
          rpcFijadoPorEnv: !!d.info.rpcFijadoPorEnv,
          keystore: d.info.keystore ? String(d.info.keystore) : null,
          version: d.info.version ? String(d.info.version) : null
        }
      : null,
    // Un error de nivel wallet (no de un activo puntual): RPC caido, red sin
    // resolver. Va arriba de todo y no tapa las filas, que igual muestran "—".
    error: d.error ? String(d.error) : null,
    avisoUsd: 'no USD conversion — this panel does not look up prices',
    // FASE 11 — `puedeCrear` es true salvo durante los ms del arranque previos
    // a que bin.mjs cablee el creator; el nodo resuelve la passphrase solo.
    puedeCrear: !!d.puedeCrear,
    crearMotivo: d.crearMotivo ? String(d.crearMotivo) : null
  }
}

export function filaAsset(it) {
  const i = it || {}
  const inicial = escaparHtml(
    String(i.symbol || '?')
      .slice(0, 3)
      .toUpperCase()
  )
  return (
    '<div class="w-fila' +
    (i.error ? ' con-error' : '') +
    '">' +
    '<div class="w-ico">' +
    inicial +
    '</div>' +
    '<div class="w-fila-txt">' +
    '<div class="w-sym">' +
    escaparHtml(i.symbol) +
    '</div>' +
    '<div class="w-name">' +
    escaparHtml(i.name) +
    (i.sub ? ' · ' + escaparHtml(i.sub) : '') +
    '</div>' +
    (i.error ? '<div class="w-fila-err">' + escaparHtml(i.error) + '</div>' : '') +
    '</div>' +
    '<div class="w-amt' +
    (i.esNativo ? ' es-nativo' : '') +
    '">' +
    escaparHtml(i.texto) +
    '</div>' +
    '</div>'
  )
}

export function htmlDeHeader(v) {
  const partes = ['<div class="w-head">', '<div class="w-acct">']
  partes.push('<span class="w-acct-dot">P</span>')
  partes.push(
    '<span class="w-acct-name">' +
      escaparHtml(v.configurada ? v.addressCorta : 'no wallet') +
      '</span>'
  )
  if (v.configurada) {
    partes.push(
      '<button class="w-copy" data-copy="' +
        escaparHtml(v.address) +
        '" title="copy the address">copy</button>'
    )
    // FASE 12 — la puerta a la configuracion. Lo que antes estaba suelto en la
    // tarjeta (el selector de red) vive detras de esto.
    partes.push(
      '<button class="w-copy w-set-toggle" id="w-set-abrir" ' +
        'title="settings: network, tokens, node data">☰</button>'
    )
  }
  partes.push('</div>')
  if (v.red) {
    partes.push(
      '<div class="w-red' +
        (v.red.esPrueba ? ' es-prueba' : '') +
        '">' +
        escaparHtml(v.red.texto) +
        (v.red.esPrueba ? ' — red de PRUEBA' : '') +
        '</div>'
    )
  }
  partes.push('</div>')
  return partes.join('')
}

export function htmlDeBalance(v) {
  let nativo = null
  for (let i = 0; i < v.items.length; i++) if (v.items[i].esNativo) nativo = v.items[i]
  const grande = nativo ? nativo.texto + ' ' + nativo.symbol : '—'
  return (
    '<div class="w-balance">' +
    '<div class="w-balance-num">' +
    escaparHtml(grande) +
    '</div>' +
    '<div class="w-balance-sub">' +
    escaparHtml(v.avisoUsd) +
    '</div>' +
    '</div>'
  )
}

// Deposit y Send hacen algo; Swap se dibuja pero deshabilitado, con el `title`
// diciendo por que — un boton apagado sin explicacion se lee como uno roto.
export function htmlDeAcciones(v) {
  return (
    '<div class="w-acc">' +
    '<button class="w-acc-b" data-w-tab="deposit"' +
    (v.configurada ? '' : ' disabled') +
    '><span>↓</span>Deposit</button>' +
    '<button class="w-acc-b" id="w-acc-send"' +
    (v.configurada ? '' : ' disabled') +
    '><span>↑</span>Send</button>' +
    '<button class="w-acc-b" disabled title="' +
    escaparHtml(
      'swapping one asset for another is a separate phase: this node talks to no DEX'
    ) +
    '"><span>⇄</span>Swap</button>' +
    '</div>'
  )
}

// El input del buscador se dibuja aparte de las filas: en cada poll se repinta
// SOLO `#w-filas`, asi el foco y el texto tipeado no se pierden cada 15 s.
export function htmlDeBuscador(v) {
  return (
    '<div class="w-assets-head">' +
    escaparHtml(String(v.n)) +
    ' ' +
    (v.n === 1 ? 'activo' : 'activos') +
    '</div>' +
    '<input class="w-filtro" id="w-filtro" type="text" autocomplete="off" ' +
    'placeholder="Search asset or network (e.g. XPL, USDT0, plasma)">'
  )
}

export function htmlDeFilas(v, q) {
  if (!v.configurada) {
    return (
      '<div class="w-vacio">This node has no payout wallet yet. ' +
      'Create it with <code>pyrusllm wallet --create</code>.</div>'
    )
  }
  const items = filtrarItems(v.items, q)
  if (!items.length) return '<div class="w-vacio">Nothing matches the search.</div>'
  let out = ''
  for (let i = 0; i < items.length; i++) out += filaAsset(items[i])
  return out
}

// -----------------------------------------------------------------------------
// EL QR, Y POR QUE ESTA ESCRITO A MANO
// -----------------------------------------------------------------------------
//
// R2 no admite dependencias nuevas y `bare-pack` sigue el grafo de imports: no
// hay CDN que cargar ni archivo suelto que servir. Asi que el encoder es JS
// propio, serializable con `String(fn)` como todo lo demas de este archivo.
//
// VERSION FIJA 3-L (29x29, correccion L, modo byte). No hay autoseleccion de
// version y es a proposito: lo que se codifica es UNA cosa —una direccion EVM,
// 42 caracteres ASCII, siempre— y v3-L entra 53 bytes. Elegir version en tiempo
// de ejecucion seria codigo de mas para un caso que no existe, y cada linea de
// mas acá viaja adentro del HTML de todos los paneles.
//
// LO QUE ESO CUESTA, dicho: correccion L tolera ~7% de daño, que es el nivel mas
// bajo de los cuatro. Para un QR en pantalla —que nadie va a imprimir, doblar ni
// pegar en una pared— alcanza; para uno impreso no seria la eleccion. Y si
// alguna vez hubiera que codificar algo mas largo que 53 bytes, `qrBytesDeDatos`
// devuelve `null` y `htmlDeQR` dibuja el motivo en vez de un QR roto: prefiero
// que no haya QR a que haya uno que escanea cualquier otra cosa.

// Bytes del segmento de datos, ya con relleno, listos para Reed-Solomon.
// Devuelve `null` si el texto no entra: un QR truncado escanearia una direccion
// que no es, y eso es peor que no tener QR.
export function qrBytesDeDatos(texto) {
  const s = String(texto == null ? '' : texto)

  // UTF-8 a mano. `TextEncoder` existe en el navegador pero no en todos lados
  // donde corre la suite, y este archivo tiene que dar lo mismo en los dos.
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    // Un par subrogado es UN code point: partirlo daria dos secuencias invalidas.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    } else {
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      )
    }
  }

  // v3-L: 55 codewords de datos, de los cuales el encabezado (modo + longitud)
  // se come 12 bits. Quedan 53 bytes utiles. Una direccion EVM son 42.
  if (bytes.length === 0 || bytes.length > 53) return null

  const bits = []
  function meter(valor, n) {
    for (let k = n - 1; k >= 0; k--) bits.push((valor >> k) & 1)
  }
  // Modo byte (0100) + longitud en 8 bits (lo que corresponde a las versiones
  // 1 a 9) + el payload.
  meter(4, 4)
  meter(bytes.length, 8)
  for (let i = 0; i < bytes.length; i++) meter(bytes[i], 8)

  // Terminador de hasta 4 ceros y relleno hasta cerrar el byte.
  const TOTAL_BITS = 55 * 8
  for (let i = 0; i < 4 && bits.length < TOTAL_BITS; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const datos = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k]
    datos.push(b)
  }
  // Los bytes de relleno que fija la norma, alternados, hasta los 55 codewords.
  const RELLENO = [0xec, 0x11]
  let p = 0
  while (datos.length < 55) datos.push(RELLENO[p++ % 2])
  return datos
}

// Los codewords de correccion de errores: division polinomica en GF(256) con el
// polinomio primitivo 0x11d, que es el que usa QR.
//
// Las tablas se arman en cada llamada en vez de vivir en una constante embebida:
// son 768 entradas, se calculan en microsegundos, y esto corre una vez por
// pintada. Meterlas como constante engordaria el HTML de todos los paneles con
// un blob de numeros para ahorrar un tiempo que nadie mide.
export function qrReedSolomon(datos, nEc) {
  const exp = new Array(512)
  const log = new Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]
  function mul(a, b) {
    return a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]
  }

  // Generador: (x + α⁰)(x + α¹)…(x + α^(nEc-1)).
  let gen = [1]
  for (let i = 0; i < nEc; i++) {
    const siguiente = new Array(gen.length + 1)
    for (let j = 0; j < siguiente.length; j++) siguiente[j] = 0
    for (let j = 0; j < gen.length; j++) {
      siguiente[j] ^= gen[j]
      siguiente[j + 1] ^= mul(gen[j], exp[i])
    }
    gen = siguiente
  }

  const resto = new Array(nEc)
  for (let i = 0; i < nEc; i++) resto[i] = 0
  for (let i = 0; i < datos.length; i++) {
    const factor = datos[i] ^ resto[0]
    resto.shift()
    resto.push(0)
    if (factor !== 0) {
      for (let j = 0; j < nEc; j++) resto[j] ^= mul(gen[j + 1], factor)
    }
  }
  return resto
}

// La matriz 29x29 de booleanos (true = modulo oscuro), o `null` si el texto no
// entra en v3-L. Patrones de posicion, separadores, timing, alineacion, la
// informacion de formato, los datos en zigzag y la mascara 0.
//
// MASCARA 0 FIJA —`(fila+columna) % 2 === 0`— sin evaluar las otras siete. La
// norma dice elegir la de menor penalizacion, y eso es para que un QR no quede
// con manchas grandes que confundan al lector. Para una direccion hexadecimal,
// que es texto de alta entropia, ninguna mascara produce esas manchas; evaluar
// las ocho serian ~150 lineas mas de codigo viajando en cada panel para elegir
// entre opciones que acá son equivalentes. Queda dicho porque es una desviacion
// de la norma, no un olvido.
export function qrMatriz(texto) {
  const datos = qrBytesDeDatos(texto)
  if (!datos) return null
  const todo = datos.concat(qrReedSolomon(datos, 15))

  const N = 29
  const m = []
  for (let r = 0; r < N; r++) {
    const fila = new Array(N)
    for (let c = 0; c < N; c++) fila[c] = null
    m.push(fila)
  }

  // Patrones de posicion, con su separador de un modulo claro alrededor.
  function posicion(fr, fc) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = fr + r
        const cc = fc + c
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue
        const dentro = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const anillo = r === 0 || r === 6 || c === 0 || c === 6
        const centro = r >= 2 && r <= 4 && c >= 2 && c <= 4
        m[rr][cc] = dentro && (anillo || centro)
      }
    }
  }
  posicion(0, 0)
  posicion(0, N - 7)
  posicion(N - 7, 0)

  // Timing: la fila 6 y la columna 6, alternando desde el modulo oscuro.
  for (let i = 8; i < N - 8; i++) {
    m[6][i] = i % 2 === 0
    m[i][6] = i % 2 === 0
  }

  // Alineacion. La tabla de v3 da centros en 6 y 22, o sea cuatro posiciones —
  // pero tres caen encima de los patrones de posicion y no se dibujan. Queda
  // una sola, en (22,22).
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const d = Math.max(Math.abs(r), Math.abs(c))
      m[22 + r][22 + c] = d !== 1
    }
  }

  // Informacion de formato: nivel L (01) y mascara 0, con el BCH(15,5) y el XOR
  // con 0x5412 que manda la norma. Se calcula en vez de escribir la constante
  // 111011111000100 a mano: el test la compara contra el valor publicado, asi
  // que el calculo queda verificado y no hay un numero magico sin origen.
  const NIVEL_L = 1
  const MASCARA = 0
  const formatoDatos = (NIVEL_L << 3) | MASCARA
  let bch = formatoDatos << 10
  function digitos(v) {
    let n = 0
    while (v !== 0) {
      n++
      v >>>= 1
    }
    return n
  }
  const G15 = 0x537
  while (digitos(bch) - digitos(G15) >= 0) bch ^= G15 << (digitos(bch) - digitos(G15))
  const formato = ((formatoDatos << 10) | bch) ^ 0x5412

  for (let i = 0; i < 15; i++) {
    const bit = ((formato >> i) & 1) === 1
    // La copia vertical, sobre la columna 8.
    if (i < 6) m[i][8] = bit
    else if (i < 8) m[i + 1][8] = bit
    else m[N - 15 + i][8] = bit
    // Y la horizontal, sobre la fila 8.
    if (i < 8) m[8][N - i - 1] = bit
    else if (i < 9) m[8][15 - i - 1 + 1] = bit
    else m[8][15 - i - 1] = bit
  }
  // El modulo oscuro fijo, que siempre esta y nunca lleva datos.
  m[N - 8][8] = true

  // Los datos, en zigzag de a dos columnas desde abajo a la derecha, salteando
  // la columna 6 (el timing vertical) y todo lo que ya esta escrito. La mascara
  // se aplica en el momento de escribir cada modulo.
  let inc = -1
  let fila = N - 1
  let bitEnByte = 7
  let indiceByte = 0
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (;;) {
      for (let k = 0; k < 2; k++) {
        if (m[fila][col - k] !== null) continue
        // Pasados los 70 codewords quedan 7 bits de relleno: van en cero, y la
        // mascara los toca igual que a los demas.
        let oscuro = false
        if (indiceByte < todo.length) oscuro = ((todo[indiceByte] >>> bitEnByte) & 1) === 1
        if ((fila + (col - k)) % 2 === 0) oscuro = !oscuro
        m[fila][col - k] = oscuro
        bitEnByte--
        if (bitEnByte === -1) {
          indiceByte++
          bitEnByte = 7
        }
      }
      fila += inc
      if (fila < 0 || fila >= N) {
        fila -= inc
        inc = -inc
        break
      }
    }
  }

  return m
}

// El QR como SVG inline. Sin `<img>`, sin data URI y sin canvas: es un puñado
// de rectangulos y asi escala solo.
//
// EL FONDO ES BLANCO FIJO Y NO SIGUE EL TEMA OSCURO. No es un descuido de
// estilo: un lector de QR necesita contraste oscuro-sobre-claro, y un QR
// invertido no escanea en muchos telefonos. Es la unica cosa de este panel que
// no es oscura, y tiene que serlo.
export function htmlDeQR(texto) {
  const m = qrMatriz(texto)
  if (!m) {
    return (
      '<div class="w-dep-nota tenue">No se pudo dibujar el QR de este texto ' +
      '(it does not fit the format this panel generates). Copy the address.</div>'
    )
  }
  const N = m.length
  // Zona de silencio: 4 modulos, lo que pide la norma. Sin ella muchos lectores
  // no encuentran los patrones de posicion.
  const Q = 4
  const lado = N + Q * 2

  let rects = ''
  for (let r = 0; r < N; r++) {
    // Los modulos oscuros contiguos de una fila se juntan en UN rect: son ~400
    // modulos y un rect por cada uno infla el HTML sin cambiar el dibujo.
    let c = 0
    while (c < N) {
      if (!m[r][c]) {
        c++
        continue
      }
      let largo = 1
      while (c + largo < N && m[r][c + largo]) largo++
      rects += '<rect x="' + (c + Q) + '" y="' + (r + Q) + '" width="' + largo + '" height="1"/>'
      c += largo
    }
  }

  return (
    '<div class="w-qr">' +
    '<svg viewBox="0 0 ' +
    lado +
    ' ' +
    lado +
    '" width="176" height="176" shape-rendering="crispEdges" ' +
    'role="img" aria-label="QR of this node payout address">' +
    '<rect width="' +
    lado +
    '" height="' +
    lado +
    '" fill="#ffffff"/>' +
    '<g fill="#000000">' +
    rects +
    '</g>' +
    '</svg>' +
    '</div>'
  )
}

export function htmlDeDeposito(v) {
  if (!v.configurada) {
    return '<div class="w-vacio">There is no wallet: nothing to deposit yet.</div>'
  }
  const partes = ['<div class="w-dep">']
  partes.push('<div class="w-dep-lbl">This node payout address</div>')
  // El QR codifica la direccion PELADA, sin `ethereum:` ni chainId adelante: es
  // lo que leen todas las wallets, y un prefijo de mas hace que algunas peguen
  // la URI entera en el campo de destino.
  partes.push(htmlDeQR(v.address))
  partes.push('<div class="w-dep-addr">' + escaparHtml(v.address) + '</div>')
  partes.push(
    '<button class="w-copy grande" data-copy="' +
      escaparHtml(v.address) +
      '">copy the address</button>'
  )
  if (v.red) {
    partes.push(
      '<div class="w-dep-nota">Send only assets from <b>' +
        escaparHtml(v.red.texto) +
        '</b> to this address. Sending assets from another network loses them.</div>'
    )
    if (v.red.explorer) {
      partes.push(
        '<a class="w-dep-link" href="' +
          escaparHtml(v.red.explorer) +
          '/address/' +
          escaparHtml(v.address) +
          '" target="_blank" rel="noreferrer">ver en el explorer</a>'
      )
    }
  }
  partes.push('</div>')
  return partes.join('')
}

// Lo que devuelve `GET /v1/wallet/history`, normalizado. La direccion de cada
// movimiento (entra o sale) se decide comparando `from` contra la address de
// esta wallet, no confiando en un campo del explorer.
export function vistaDeHistorial(data) {
  const d = data || {}
  const mia = String(d.address || '').toLowerCase()
  const explorer = d.explorer ? String(d.explorer).replace(/\/+$/, '') : null

  const items = []
  const crudos = Array.isArray(d.items) ? d.items : []
  for (let i = 0; i < crudos.length; i++) {
    const it = crudos[i] || {}
    const from = String(it.from || '').toLowerCase()
    const to = String(it.to || '').toLowerCase()

    // Sin decimales conocidos NO se formatea el monto: dividir por un numero
    // que nadie sabe es inventar la cifra que la persona va a leer. Se muestran
    // las unidades crudas, dicho.
    let texto = '—'
    let crudo = false
    if (it.valor == null) {
      texto = '—'
    } else if (it.decimals == null) {
      texto = String(formatearMonto(it.valor, 0, 0).texto)
      crudo = true
    } else {
      texto = formatearMonto(it.valor, it.decimals, 6).texto
    }

    items.push({
      clave: 'h:' + i + ':' + String(it.hash || ''),
      // Una transferencia de la wallet a si misma sale como 'out': es plata que
      // salio y volvio, y contarla como entrada seria contarla dos veces.
      direccion: mia && from === mia ? 'out' : mia && to === mia ? 'in' : 'otro',
      tipo: it.tipo === 'native' ? 'native' : 'erc20',
      symbol: it.symbol ? String(it.symbol) : it.tipo === 'native' ? simboloNativo(d.caip2) : null,
      contrato: it.contrato ? truncarDireccion(it.contrato) : null,
      texto,
      montoCrudo: crudo,
      contraparte: truncarDireccion(mia && from === mia ? it.to : it.from),
      hash: it.hash ? String(it.hash) : null,
      hashCorto: truncarDireccion(it.hash),
      link: explorer && it.hash ? explorer + '/tx/' + String(it.hash) : null,
      // El respaldo por `eth_getLogs` no trae fecha —un log no la lleva— y el
      // numero de bloque viene en hex. Se pasa a decimal: "bloque 0x64" no le
      // dice nada a nadie, y pedirle otro request al RPC por cada fila para
      // convertirlo en una fecha es mucho por un dato secundario.
      cuando: it.timestamp
        ? String(it.timestamp)
        : it.bloque
          ? 'bloque ' + aBigInt(it.bloque).toString()
          : '—',
      estado: it.estado ? String(it.estado) : 'confirmada'
    })
  }

  return {
    ok: d.ok !== false,
    configurada: !!d.configurada,
    items,
    n: items.length,
    fuente: d.fuente ? String(d.fuente) : null,
    // Lo que la fuente de respaldo NO ve. Se dibuja siempre que este: la
    // diferencia entre "esto es todo" y "esto es lo que se pudo leer" no puede
    // quedar entre el nodo y la pantalla.
    parcial: d.parcial ? String(d.parcial) : null,
    error: d.error ? String(d.error) : null
  }
}

export function htmlDeHistorial(v) {
  const h = v || {}
  const partes = ['<div class="w-hist">']

  // Regla 2 del encabezado, otra vez: una lectura que fallo NO se dibuja como
  // "no hay movimientos". Se dice que no se pudo leer, y por que.
  if (h.error) {
    partes.push('<div class="w-aviso malo">' + escaparHtml(h.error) + '</div>')
  }
  if (h.parcial) {
    partes.push('<div class="w-aviso tibio">' + escaparHtml(h.parcial) + '</div>')
  }

  if (!h.ok) {
    partes.push('<div class="w-hist-vacio">—</div>')
    partes.push('</div>')
    return partes.join('')
  }
  if (!h.n) {
    partes.push('<div class="w-vacio">Sin movimientos en lo que se pudo leer.</div>')
    partes.push('</div>')
    return partes.join('')
  }

  for (let i = 0; i < h.items.length; i++) {
    const it = h.items[i]
    const entra = it.direccion === 'in'
    const flecha = entra ? '↓' : it.direccion === 'out' ? '↑' : '·'
    const signo = entra ? '+' : it.direccion === 'out' ? '−' : ''

    partes.push(
      '<div class="w-hist-fila' +
        (it.estado === 'fallida' ? ' con-error' : '') +
        '">' +
        '<div class="w-ico ' +
        (entra ? 'entra' : 'sale') +
        '">' +
        flecha +
        '</div>' +
        '<div class="w-fila-txt">' +
        '<div class="w-sym">' +
        (entra ? 'Received' : it.direccion === 'out' ? 'Sent' : 'Movement') +
        (it.contraparte
          ? ' <span class="w-hist-quien">' + escaparHtml(it.contraparte) + '</span>'
          : '') +
        '</div>' +
        '<div class="w-name">' +
        escaparHtml(it.cuando) +
        (it.hashCorto ? ' · ' : '') +
        (it.link
          ? '<a href="' +
            escaparHtml(it.link) +
            '" target="_blank" rel="noreferrer">' +
            escaparHtml(it.hashCorto) +
            '</a>'
          : escaparHtml(it.hashCorto || '')) +
        (it.estado !== 'confirmada' ? ' · ' + escaparHtml(it.estado) : '') +
        (it.contrato && !it.symbol ? ' · token ' + escaparHtml(it.contrato) : '') +
        '</div>' +
        '</div>' +
        '<div class="w-amt' +
        (entra ? ' entra' : '') +
        '">' +
        escaparHtml(signo + it.texto + (it.symbol ? ' ' + it.symbol : '')) +
        (it.montoCrudo
          ? '<div class="w-hist-crudo">unidades crudas — decimales desconocidos</div>'
          : '') +
        '</div>' +
        '</div>'
    )
  }

  partes.push('</div>')
  return partes.join('')
}

// -----------------------------------------------------------------------------
// ENVIAR — ver el punto (c) del encabezado. Acá NO se firma nada: estas
// funciones dibujan un formulario, una revisión y un estado. Lo que sale del
// navegador son tres strings.
// -----------------------------------------------------------------------------

// Chequeo de FORMA, gemelo del que hace el endpoint. Lo que NO chequea, y no
// puede: si esa dirección existe, si es de esta red, o si hay saldo. Eso lo dice
// la cadena y llega como error del envío.
export function envioParecePlausible(envio) {
  const e = envio || {}
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(e.destino || '').trim())) return false
  if (!/^\d+(\.\d+)?$/.test(String(e.monto == null ? '' : e.monto).trim())) return false
  if (Number(e.monto) <= 0) return false
  const a = String(e.asset || 'native').trim()
  if (a !== 'native' && !/^0x[0-9a-fA-F]{40}$/.test(a)) return false
  return true
}

// El formulario. El <select> de activos sale de los MISMOS items que la lista de
// saldos: no se puede elegir para mandar algo que el panel no está leyendo.
export function htmlDeEnvio(v) {
  const partes = ['<div class="w-envio">']
  partes.push('<div class="w-red-lbl">Enviar desde esta wallet</div>')

  if (v.red && v.red.mainnet) {
    partes.push(
      '<div class="w-aviso malo">' +
        escaparHtml(v.red.texto) +
        ' is MAINNET: this moves real money and cannot be undone.</div>'
    )
  }

  let opts = ''
  for (let i = 0; i < v.items.length; i++) {
    const it = v.items[i]
    opts +=
      '<option value="' +
      escaparHtml(it.esNativo ? 'native' : String(it.clave).replace(/^tok:/, '')) +
      '" data-dec="' +
      escaparHtml(String(it.decimals)) +
      '">' +
      escaparHtml(it.symbol + ' — saldo ' + it.texto) +
      (it.verificado ? '' : ' (unverified)') +
      '</option>'
  }

  partes.push(
    '<div class="w-envio-campo">' +
      '<label for="w-env-asset">Asset</label>' +
      '<select id="w-env-asset" class="w-red-sel">' +
      opts +
      '</select>' +
      '</div>' +
      '<div class="w-envio-campo">' +
      '<label for="w-env-destino">Destination address</label>' +
      '<input id="w-env-destino" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="0x…">' +
      '</div>' +
      '<div class="w-envio-campo">' +
      '<label for="w-env-monto">Monto</label>' +
      '<input id="w-env-monto" type="text" inputmode="decimal" autocomplete="off" ' +
      'placeholder="0.0">' +
      '</div>'
  )

  if (v.red) {
    partes.push(
      '<div class="w-red-nota">Se manda por <b>' +
        escaparHtml(v.red.texto) +
        '</b>. An address on another network accepts the transaction anyway and the funds ' +
        'are not recoverable.</div>'
    )
  }

  partes.push(
    '<div class="w-envio-acc">' +
      '<button class="w-onb-b" id="w-env-cancelar">Cancelar</button>' +
      '<button class="w-onb-b primaria" id="w-env-revisar">Revisar</button>' +
      '</div>' +
      '<div id="w-env-msg" class="w-onb-msg" role="status"></div>' +
      '</div>'
  )
  return partes.join('')
}

// La revisión: lo que se va a mandar, a quién, por qué red, y cuánto sale de
// gas. Es la última pantalla antes de firmar, así que repite TODO — incluido lo
// que la persona ya escribió, porque es donde se ve un dedazo.
export function htmlDeRevisionEnvio(v, datos, gas) {
  const d = datos || {}
  const g = gas || {}
  const partes = ['<div class="w-envio">']
  partes.push('<div class="w-red-lbl">Review before sending</div>')

  if (v.red && v.red.mainnet) {
    partes.push(
      '<div class="w-aviso malo">MAINNET — real money. On confirming you will be asked to ' +
        'type MAINNET.</div>'
    )
  }

  const fila = (k, valor, clase) =>
    '<div class="w-envio-rev' +
    (clase ? ' ' + clase : '') +
    '"><span>' +
    escaparHtml(k) +
    '</span><code>' +
    escaparHtml(valor) +
    '</code></div>'

  partes.push(fila('Amount', String(d.monto || '') + ' ' + String(d.simbolo || '')))
  // La dirección va ENTERA, sin truncar: es el único campo donde un carácter
  // cambiado manda los fondos a otro lado, y "0x1234…abcd" esconde justo el
  // medio, que es donde no se nota.
  partes.push(fila('To the address', String(d.destino || '')))
  partes.push(fila('Red', String(d.red || '') + (d.mainnet ? ' — MAINNET' : '')))

  if (g.fee != null) {
    const f = formatearMonto(g.fee, g.feeDecimals == null ? 18 : g.feeDecimals, 8)
    partes.push(
      fila('Estimated gas', f.texto + (g.feeSymbol ? ' ' + g.feeSymbol : '') + ' (estimado)')
    )
  } else {
    // Regla 2: sin dato se dice, no se pone un cero tranquilizador.
    partes.push(fila('Estimated gas', '— could not estimate', 'tenue'))
  }

  if (d.assetVerificado === false) {
    partes.push(
      '<div class="w-aviso malo">This token is NOT verified against the chain: its symbol ' +
        'and its decimals are whatever somebody typed into the settings. If they are wrong, ' +
        'the amount sent is not the one shown here.</div>'
    )
  }

  partes.push(
    '<div class="w-envio-acc">' +
      '<button class="w-onb-b" id="w-env-volver">Volver</button>' +
      '<button class="w-onb-b primaria" id="w-env-confirmar">Send</button>' +
      '</div>' +
      '<div id="w-env-msg" class="w-onb-msg" role="status"></div>' +
      '</div>'
  )
  return partes.join('')
}

// El estado de la transacción. `pendiente` es lo que este nodo sabe después de
// difundir: que salió, no que entró en un bloque. Decir "confirmada" ahí sería
// afirmar algo que nadie miró — el que confirma es el explorer, y por eso el
// link está.
export function htmlDeEstadoEnvio(estado) {
  const e = estado || {}
  const clase = e.estado === 'fallida' ? 'malo' : e.estado === 'confirmada' ? 'bueno' : 'tibio'
  const titulo =
    e.estado === 'fallida'
      ? 'Could not send'
      : e.estado === 'confirmada'
        ? 'Transaction confirmed'
        : 'Transaction sent'

  const partes = ['<div class="w-envio">']
  partes.push('<div class="w-envio-tit">' + escaparHtml(titulo) + '</div>')

  if (e.estado === 'fallida') {
    partes.push(
      '<div class="w-aviso malo">' +
        escaparHtml(e.error || 'the chain did not accept the transaction') +
        '</div>'
    )
    // El volcado crudo de la cadena, a un click. No se descarta —a veces el
    // dato que hace falta esta ahi adentro— pero tampoco se pone al frente,
    // donde tapa la frase que si se entiende.
    if (e.detalle && e.detalle !== e.error) {
      partes.push(
        '<details class="w-envio-det"><summary>what the chain answered, in full</summary>' +
          '<pre>' +
          escaparHtml(e.detalle) +
          '</pre></details>'
      )
    }
  } else {
    partes.push(
      '<div class="w-aviso ' +
        clase +
        '">' +
        escaparHtml(
          String(e.monto || '') +
            ' ' +
            String(e.simbolo || '') +
            ' a ' +
            truncarDireccion(e.destino)
        ) +
        (e.estado === 'confirmada'
          ? ''
          : ' — broadcast to the network. Confirming it is the chain business, not this node.') +
        '</div>'
    )
  }

  if (e.hash) {
    partes.push(
      '<div class="w-envio-rev"><span>Hash</span><code>' + escaparHtml(e.hash) + '</code></div>'
    )
    if (e.explorer) {
      partes.push(
        '<a class="w-dep-link" href="' +
          escaparHtml(e.explorer) +
          '" target="_blank" rel="noreferrer">seguirla en el explorer</a>'
      )
    }
  }

  partes.push(
    '<div class="w-envio-acc">' +
      '<button class="w-onb-b primaria" id="w-env-listo">Volver a la billetera</button>' +
      '</div>' +
      '</div>'
  )
  return partes.join('')
}

// La barra de abajo del screenshot. Assets, Deposit e History hacen algo;
// Stake y Swap se dibujan deshabilitados: no existen todavia y esconderlos
// seria fingir que el panel esta completo.
export function htmlDeTabs(tab) {
  const t = tab || 'assets'
  function boton(clave, etiqueta, activo) {
    return (
      '<button class="w-tab' +
      (t === clave ? ' on' : '') +
      '"' +
      (activo ? ' data-w-tab="' + clave + '"' : ' disabled title="fase aparte"') +
      '>' +
      escaparHtml(etiqueta) +
      '</button>'
    )
  }
  return (
    '<div class="w-tabs">' +
    boton('assets', 'Assets', true) +
    boton('deposit', 'Deposit', true) +
    boton('stake', 'Stake', false) +
    boton('swap', 'Swap', false) +
    boton('history', 'History', true) +
    '</div>'
  )
}

// La tarjeta que reemplaza a la billetera cuando el nodo todavia no tiene
// wallet. Dos caminos: crear una nueva (el nodo genera las 24 palabras) o
// importar una que ya se tiene. Si falta la passphrase en el entorno no hay
// boton: se explica ESE paso, que es de entorno y no de CLI.
export function htmlDeOnboarding(v) {
  if (!v.puedeCrear) {
    return (
      '<div class="w-onb">' +
      '<div class="w-onb-tit">This node has no payout wallet yet</div>' +
      '<div class="w-onb-txt">The node is not ready to create it yet — try again in ' +
      'nuevo en unos segundos.</div>' +
      (v.crearMotivo ? '<div class="w-fila-err">' + escaparHtml(v.crearMotivo) + '</div>' : '') +
      '</div>'
    )
  }
  return (
    '<div class="w-onb">' +
    '<div class="w-onb-tit">Create this node payout wallet</div>' +
    '<div class="w-onb-txt">It is generated here and stored encrypted on the node machine. ' +
    'The 24 words are shown once so you can write them down — they are the only ' +
    'backup. You can also import one you already have.</div>' +
    '<div class="w-onb-acc">' +
    '<button class="w-onb-b primaria" id="w-onb-crear">Crear una nueva</button>' +
    '<button class="w-onb-b" id="w-onb-importar-toggle">Importar 24 palabras</button>' +
    '</div>' +
    '<div id="w-onb-import" class="w-onb-import" hidden>' +
    '<textarea id="w-onb-frase" rows="3" autocomplete="off" spellcheck="false" ' +
    'placeholder="paste the 12–24 words separated by spaces"></textarea>' +
    '<button class="w-onb-b primaria" id="w-onb-importar">Importar</button>' +
    '</div>' +
    '<div id="w-onb-msg" class="w-onb-msg" role="status"></div>' +
    '</div>'
  )
}

// La pantalla que se muestra UNA vez despues de crear: las 24 palabras, un
// aviso fuerte, y un "Listo" que no se habilita hasta tildar que se anotaron.
// El nodo no la vuelve a servir — igual que `wallet.crear`, que devuelve la
// frase una sola vez.
export function htmlDeSeed(frase, address) {
  const palabras = palabrasDeFrase(frase)
  let grid = ''
  for (let i = 0; i < palabras.length; i++) {
    grid += '<span class="w-seed-w"><b>' + (i + 1) + '</b>' + escaparHtml(palabras[i]) + '</span>'
  }
  return (
    '<div class="w-seed">' +
    '<div class="w-seed-tit">Write down these ' +
    palabras.length +
    ' words — on paper, not in a photo</div>' +
    '<div class="w-seed-grid">' +
    grid +
    '</div>' +
    '<button class="w-copy grande" data-copy="' +
    escaparHtml(palabras.join(' ')) +
    '">copy to clipboard</button>' +
    '<div class="w-aviso malo">No se vuelven a mostrar. Quien tenga estas palabras ' +
    'controla los fondos de <code>' +
    escaparHtml(address) +
    '</code>. If you lose them and the keystore is lost, the wallet is lost.</div>' +
    '<label class="w-seed-ok"><input type="checkbox" id="w-seed-check"> ' +
    'I have written them down somewhere safe</label>' +
    '<button class="w-onb-b primaria" id="w-seed-listo" disabled>Listo</button>' +
    '</div>'
  )
}

// El selector de red. Cambia `wallet.red` y NO hace hot-swap: por eso el texto
// dice "reiniciá el nodo". Si el entorno fija la red (PYRUS_WALLET_RED), se
// dibuja como texto y no como <select>: el selector no tendría efecto.
export function htmlDeSelectorRed(v) {
  if (!v.red) return ''
  const partes = ['<div class="w-red-box">']
  partes.push('<div class="w-red-lbl">Red de cobro</div>')

  if (v.red.fijadaPorEnv) {
    partes.push(
      '<div class="w-red-val">' +
        escaparHtml(v.red.texto) +
        (v.red.esPrueba ? ' — TESTNET' : ' — MAINNET') +
        '</div>' +
        '<div class="w-red-nota">la fija <code>PYRUS_WALLET_RED</code> en el entorno; ' +
        'remove that variable to choose from here</div>'
    )
    partes.push('</div>')
    return partes.join('')
  }

  let opts = ''
  for (let i = 0; i < REDES_PANEL.length; i++) {
    const r = REDES_PANEL[i]
    opts +=
      '<option value="' +
      escaparHtml(r.nombre) +
      '" data-mainnet="' +
      (r.mainnet ? '1' : '0') +
      '"' +
      (r.nombre === v.red.nombre ? ' selected' : '') +
      '>' +
      escaparHtml(r.etiqueta) +
      '</option>'
  }
  partes.push(
    '<div class="w-red-row">' +
      '<select id="w-red-sel" class="w-red-sel">' +
      opts +
      '</select>' +
      '<button class="w-onb-b" id="w-red-aplicar">Switch</button>' +
      '</div>' +
      '<div class="w-red-nota">the change takes effect when the node restarts. Going to MAINNET ' +
      'asks for confirmation and, to charge over x402, the verified-contract flag.</div>' +
      '<div id="w-red-msg" class="w-onb-msg" role="status"></div>'
  )
  partes.push('</div>')
  return partes.join('')
}

// FASE 12 — chequeo de FORMA de un token que alguien escribe a mano, para no
// mandarle al nodo algo que obviamente no es una address. Es el gemelo de
// `fraseParecePlausible`, y la regla esta escrita igual que en
// `wallet.tokenParaGuardar`, que es quien decide si entra al disco.
//
// NO valida NADA contra la cadena. Que la address tenga 20 bytes no dice que
// ahi viva un ERC-20 ni que sus decimales sean esos. Por eso todo token
// agregado asi se dibuja "sin verificar contra la cadena", como USD₮0.
export function tokenParecePlausible(tok) {
  const t = tok || {}
  const address = String(t.address == null ? '' : t.address).trim()
  const symbol = String(t.symbol == null ? '' : t.symbol).trim()
  const decimals = Number(t.decimals)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false
  if (symbol.length < 1 || symbol.length > 12) return false
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return false
  return true
}

// La lista de tokens que el panel vigila en la red ACTIVA, mas el formulario
// para agregar uno. La red esta dicha arriba a proposito: una address de token
// no vale cross-chain, y agregar "el USDT" sin saber en que cadena se esta
// parado es como se termina mirando el balance de otro contrato.
export function htmlDeListaTokens(v) {
  const partes = ['<div class="w-set-bloque">']
  partes.push('<div class="w-red-lbl">Tokens que este panel vigila</div>')

  if (v.red) {
    partes.push(
      '<div class="w-red-nota">en <b>' +
        escaparHtml(v.red.texto) +
        '</b> — a token address is not valid on another network, so the list is per network.</div>'
    )
  }

  const toks = v.tokensGuardados || []
  if (!toks.length) {
    partes.push(
      '<div class="w-vacio">None yet. The native asset and USD₮0 are read anyway, ' +
        'without adding them.</div>'
    )
  } else {
    partes.push('<div class="w-set-toks">')
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      partes.push(
        '<div class="w-set-tok">' +
          '<div class="w-fila-txt">' +
          '<div class="w-sym">' +
          escaparHtml(t.symbol) +
          ' <span class="w-set-dec">· ' +
          escaparHtml(String(t.decimals)) +
          ' decimales</span></div>' +
          '<div class="w-name">' +
          escaparHtml(t.addressCorta) +
          ' · unverified against the chain</div>' +
          '</div>' +
          '<button class="w-onb-b w-set-quitar" data-w-token-del="' +
          escaparHtml(t.address) +
          '">quitar</button>' +
          '</div>'
      )
    }
    partes.push('</div>')
  }

  partes.push(
    '<div class="w-set-form">' +
      '<input id="w-token-addr" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="contract address (0x…40 hex)">' +
      '<div class="w-set-form-row">' +
      '<input id="w-token-sym" type="text" autocomplete="off" placeholder="symbol">' +
      '<input id="w-token-dec" type="number" min="0" max="36" step="1" placeholder="decimales">' +
      '<button class="w-onb-b primaria" id="w-token-add">Add</button>' +
      '</div>' +
      '<div class="w-red-nota">Nothing is checked against the chain: the symbol and the ' +
      'decimals are whatever you type, and a token added here is shown marked ' +
      '<b>unverified</b>. Wrong decimals show a wrong balance.</div>' +
      '<div id="w-token-msg" class="w-onb-msg" role="status"></div>' +
      '</div>'
  )
  partes.push('</div>')
  return partes.join('')
}

// FASE 12 — el panel de configuracion, detras del ☰. Es un overlay ADENTRO de
// #wallet-root, no un modal global: la billetera es una columna angosta y su
// configuracion pertenece a esa columna.
//
// Lo de abajo del todo es solo lectura y esta a proposito: cuando algo no
// cuadra —el saldo no aparece, el 402 sale en otra red— las tres preguntas son
// siempre "¿contra que RPC?", "¿donde esta el keystore?" y "¿que version es
// esta?". Estaban solo en el log de arranque, que para entonces ya scrolleo.
export function htmlDeSettings(v) {
  const partes = ['<div class="w-set-ov" id="w-set-ov"><div class="w-set">']
  partes.push(
    '<div class="w-set-head">' +
      '<div class="w-set-tit">Settings</div>' +
      '<button class="w-copy" id="w-set-cerrar" title="cerrar (Esc)">✕</button>' +
      '</div>'
  )

  // El selector de red MUDADO desde htmlDeWallet, sin cambiarle nada: sigue sin
  // hacer hot-swap y sigue pidiendo escribir MAINNET.
  partes.push(htmlDeSelectorRed(v))
  partes.push(htmlDeListaTokens(v))

  if (v.info) {
    const filas = []
    if (v.info.rpc) {
      filas.push(
        '<div class="w-set-dato"><span>RPC efectivo</span><code>' +
          escaparHtml(v.info.rpc) +
          '</code>' +
          (v.info.rpcFijadoPorEnv
            ? '<span class="w-set-flag">lo fija PYRUS_WALLET_RPC en el entorno</span>'
            : '') +
          '</div>'
      )
    }
    if (v.info.keystore) {
      filas.push(
        '<div class="w-set-dato"><span>Keystore</span><code>' +
          escaparHtml(v.info.keystore) +
          '</code></div>'
      )
    }
    if (v.info.version) {
      filas.push(
        '<div class="w-set-dato"><span>Node version</span><code>' +
          escaparHtml(v.info.version) +
          '</code></div>'
      )
    }
    if (filas.length) {
      partes.push(
        '<div class="w-set-bloque">' +
          '<div class="w-red-lbl">Este nodo</div>' +
          filas.join('') +
          '</div>'
      )
    }
  }

  partes.push('</div></div>')
  return partes.join('')
}

export function htmlDeWallet(vista, q, tab, hist) {
  const v = vista || vistaDeSaldos(null)
  // Sin wallet, la tarjeta ES el onboarding: ni balance, ni Send/Swap, ni tabs.
  if (!v.configurada) return '<div class="w-card">' + htmlDeOnboarding(v) + '</div>'
  const t = tab || 'assets'
  const partes = ['<div class="w-card">']
  partes.push(htmlDeHeader(v))
  partes.push(htmlDeBalance(v))
  partes.push(htmlDeAcciones(v))
  if (v.error) partes.push('<div class="w-aviso malo">' + escaparHtml(v.error) + '</div>')
  if (t === 'deposit') {
    partes.push(htmlDeDeposito(v))
  } else if (t === 'history') {
    // `hist` puede no haber llegado todavia (el fetch sale al entrar al tab):
    // se dibuja el esqueleto de "cargando", no una lista vacia que se leeria
    // como "no hubo movimientos".
    partes.push(
      hist
        ? htmlDeHistorial(hist)
        : '<div class="w-hist"><div class="w-vacio">Leyendo movimientos…</div></div>'
    )
  } else {
    partes.push('<div class="w-assets">')
    partes.push(htmlDeBuscador(v))
    partes.push('<div id="w-filas" class="w-filas">' + htmlDeFilas(v, q) + '</div>')
    partes.push('</div>')
  }
  // FASE 12 — aca NO va nada de configuracion. El selector de red se mudo a
  // `htmlDeSettings`, detras del ☰ del header.
  partes.push(htmlDeTabs(t))
  partes.push('</div>')
  return partes.join('')
}

// -----------------------------------------------------------------------------
// LO QUE VIAJA AL NAVEGADOR — ver la nota del encabezado y el gemelo de
// `qvac/panel-x402.mjs`.
// -----------------------------------------------------------------------------

const CONSTANTES_EMBEBIDAS =
  'var SIMBOLO_NATIVO = ' +
  JSON.stringify(SIMBOLO_NATIVO) +
  ';\n' +
  'var REDES_PANEL = ' +
  JSON.stringify(REDES_PANEL) +
  ';\n'

const FUNCIONES_EMBEBIDAS = {
  escaparHtml,
  aBigInt,
  formatearMonto,
  truncarDireccion,
  simboloNativo,
  palabrasDeFrase,
  fraseParecePlausible,
  filtrarItems,
  vistaDeSaldos,
  filaAsset,
  htmlDeHeader,
  htmlDeBalance,
  htmlDeAcciones,
  htmlDeBuscador,
  htmlDeFilas,
  qrBytesDeDatos,
  qrReedSolomon,
  qrMatriz,
  htmlDeQR,
  htmlDeDeposito,
  vistaDeHistorial,
  htmlDeHistorial,
  envioParecePlausible,
  htmlDeEnvio,
  htmlDeRevisionEnvio,
  htmlDeEstadoEnvio,
  htmlDeTabs,
  htmlDeOnboarding,
  htmlDeSeed,
  htmlDeSelectorRed,
  tokenParecePlausible,
  htmlDeListaTokens,
  htmlDeSettings,
  htmlDeWallet
}

export const FUENTE_EMBEBIDA_WALLET =
  '// ---- qvac/panel-wallet.mjs, embebido tal cual: ver la nota de ese archivo ----\n' +
  CONSTANTES_EMBEBIDAS +
  Object.keys(FUNCIONES_EMBEBIDAS)
    .map(function (n) {
      return 'var ' + n + ' = ' + String(FUNCIONES_EMBEBIDAS[n]) + ';'
    })
    .join('\n\n') +
  '\n'
