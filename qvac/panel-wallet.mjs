// El panel /wallet: la wallet de COBRO de este nodo, mirada. SOLO LECTURA.
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
//   1. NO manda plata. `wallet.mjs` es de cobro: la seed no sale del proceso
//      que la abre (bin.mjs), y el gateway pide firmas, no llaves. Enviar y
//      hacer swap se hacen por la CLI. Los botones Send/Swap se dibujan
//      DESHABILITADOS, no ocultos: que se vea que existen y que todavia no.
//   2. NO convierte a USD. El screenshot de referencia muestra "$0" al lado de
//      cada activo; este panel no consulta ningun feed de precios, y dividir un
//      balance por una cotizacion que nadie miro es inventar el numero que la
//      persona va a leer como "lo que tengo". El saldo va en el simbolo del
//      activo, con "sin conversion a USD" dicho al lado. Misma regla que el
//      `avisoMonto` de panel-x402.
//   3. NO afirma un balance cuando el RPC no contesto. Un error de lectura se
//      dibuja como "—" y con el motivo, NUNCA como "0" — que se leeria como
//      "esta wallet esta vacia".
//   4. La direccion del contrato de USD₮0 en Plasma NO esta verificada contra
//      la cadena (ver `qvac/x402.mjs`). Para LEER un balance eso es inocuo — no
//      se manda nada —, pero igual se marca "sin verificar" en la fila.
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
        caip2: String(d.red.caip2 || ''),
        texto: (d.red.nombre ? d.red.nombre + ' · ' : '') + String(d.red.caip2 || ''),
        // Sin `mainnet: true` explicito se asume red de prueba: el error barato
        // es una etiqueta "PRUEBA" de mas, el caro es creer que es testnet y no.
        esPrueba: !d.red.mainnet,
        explorer: d.red.explorer ? String(d.red.explorer) : null
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
      name: (d.red && d.red.nombre) || 'activo nativo',
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
        (tk.verificado ? '' : ' · dirección sin verificar contra la cadena'),
      decimals: dec,
      raw: tk.raw == null ? null : String(tk.raw),
      texto: tk.raw == null ? '—' : m.texto,
      error: tk.error ? String(tk.error) : null,
      verificado: !!tk.verificado
    })
  }

  return {
    configurada: !!d.configurada && !!d.address,
    address: d.address ? String(d.address) : null,
    addressCorta: truncarDireccion(d.address),
    red,
    items,
    n: items.length,
    // Un error de nivel wallet (no de un activo puntual): RPC caido, red sin
    // resolver. Va arriba de todo y no tapa las filas, que igual muestran "—".
    error: d.error ? String(d.error) : null,
    avisoUsd: 'sin conversión a USD — este panel no consulta precios',
    // FASE 11 — crear/importar desde el panel. `puedeCrear` es true solo si el
    // nodo tiene PYRUS_WALLET_PASSPHRASE en el entorno: sin esa clave no se
    // puede cifrar la seed NI abrirla en el proximo arranque.
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
      escaparHtml(v.configurada ? v.addressCorta : 'sin wallet') +
      '</span>'
  )
  if (v.configurada) {
    partes.push(
      '<button class="w-copy" data-copy="' +
        escaparHtml(v.address) +
        '" title="copiar la dirección">copiar</button>'
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

// Deposit lleva a la pestaña de la direccion. Send y Swap se dibujan pero
// deshabilitados: este panel no manda plata (ver el encabezado). El `title`
// dice por que, para que no se lea como un boton roto.
export function htmlDeAcciones(v) {
  const futuro = 'por CLI por ahora — el panel de envío es una fase aparte'
  return (
    '<div class="w-acc">' +
    '<button class="w-acc-b" data-w-tab="deposit"' +
    (v.configurada ? '' : ' disabled') +
    '><span>↓</span>Deposit</button>' +
    '<button class="w-acc-b" disabled title="' +
    escaparHtml(futuro) +
    '"><span>↑</span>Send</button>' +
    '<button class="w-acc-b" disabled title="' +
    escaparHtml(futuro) +
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
    'placeholder="Buscar activo o red (ej. XPL, USDT0, plasma)">'
  )
}

export function htmlDeFilas(v, q) {
  if (!v.configurada) {
    return (
      '<div class="w-vacio">Este nodo todavía no tiene wallet de cobro. ' +
      'Creala con <code>pyrusllm wallet --crear</code>.</div>'
    )
  }
  const items = filtrarItems(v.items, q)
  if (!items.length) return '<div class="w-vacio">Nada coincide con la búsqueda.</div>'
  let out = ''
  for (let i = 0; i < items.length; i++) out += filaAsset(items[i])
  return out
}

export function htmlDeDeposito(v) {
  if (!v.configurada) {
    return '<div class="w-vacio">No hay wallet: nada que depositar todavía.</div>'
  }
  const partes = ['<div class="w-dep">']
  partes.push('<div class="w-dep-lbl">Dirección de cobro de este nodo</div>')
  partes.push('<div class="w-dep-addr">' + escaparHtml(v.address) + '</div>')
  partes.push(
    '<button class="w-copy grande" data-copy="' +
      escaparHtml(v.address) +
      '">copiar la dirección</button>'
  )
  if (v.red) {
    partes.push(
      '<div class="w-dep-nota">Enviá solo activos de <b>' +
        escaparHtml(v.red.texto) +
        '</b> a esta dirección. Mandar activos de otra red los pierde.</div>'
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
  partes.push(
    '<div class="w-dep-nota tenue">El QR es una fase aparte; por ahora copiá la dirección.</div>'
  )
  partes.push('</div>')
  return partes.join('')
}

// La barra de abajo del screenshot. Solo Assets y Deposit hacen algo; Stake,
// Swap e History se dibujan deshabilitados por lo mismo que Send: no existen
// todavia y esconderlos seria fingir que el panel esta completo.
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
    boton('history', 'History', false) +
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
      '<div class="w-onb-tit">Este nodo todavía no tiene wallet de cobro</div>' +
      '<div class="w-onb-txt">El nodo todavía no está listo para crearla — probá de ' +
      'nuevo en unos segundos.</div>' +
      (v.crearMotivo ? '<div class="w-fila-err">' + escaparHtml(v.crearMotivo) + '</div>' : '') +
      '</div>'
    )
  }
  return (
    '<div class="w-onb">' +
    '<div class="w-onb-tit">Creá la wallet de cobro de este nodo</div>' +
    '<div class="w-onb-txt">Se genera acá y se guarda cifrada en la máquina del nodo. ' +
    'Las 24 palabras se muestran una sola vez para que las anotes — son el único ' +
    'respaldo. También podés importar una que ya tengas.</div>' +
    '<div class="w-onb-acc">' +
    '<button class="w-onb-b primaria" id="w-onb-crear">Crear una nueva</button>' +
    '<button class="w-onb-b" id="w-onb-importar-toggle">Importar 24 palabras</button>' +
    '</div>' +
    '<div id="w-onb-import" class="w-onb-import" hidden>' +
    '<textarea id="w-onb-frase" rows="3" autocomplete="off" spellcheck="false" ' +
    'placeholder="pegá las 12–24 palabras separadas por espacios"></textarea>' +
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
    '<div class="w-seed-tit">Anotá estas ' +
    palabras.length +
    ' palabras — en papel, no en una foto</div>' +
    '<div class="w-seed-grid">' +
    grid +
    '</div>' +
    '<button class="w-copy grande" data-copy="' +
    escaparHtml(palabras.join(' ')) +
    '">copiar al portapapeles</button>' +
    '<div class="w-aviso malo">No se vuelven a mostrar. Quien tenga estas palabras ' +
    'controla los fondos de <code>' +
    escaparHtml(address) +
    '</code>. Si las perdés y se pierde el keystore, se pierde la wallet.</div>' +
    '<label class="w-seed-ok"><input type="checkbox" id="w-seed-check"> ' +
    'Ya las anoté en un lugar seguro</label>' +
    '<button class="w-onb-b primaria" id="w-seed-listo" disabled>Listo</button>' +
    '</div>'
  )
}

export function htmlDeWallet(vista, q, tab) {
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
  } else {
    partes.push('<div class="w-assets">')
    partes.push(htmlDeBuscador(v))
    partes.push('<div id="w-filas" class="w-filas">' + htmlDeFilas(v, q) + '</div>')
    partes.push('</div>')
  }
  partes.push(htmlDeTabs(t))
  partes.push('</div>')
  return partes.join('')
}

// -----------------------------------------------------------------------------
// LO QUE VIAJA AL NAVEGADOR — ver la nota del encabezado y el gemelo de
// `qvac/panel-x402.mjs`.
// -----------------------------------------------------------------------------

const CONSTANTES_EMBEBIDAS = 'var SIMBOLO_NATIVO = ' + JSON.stringify(SIMBOLO_NATIVO) + ';\n'

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
  htmlDeDeposito,
  htmlDeTabs,
  htmlDeOnboarding,
  htmlDeSeed,
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
