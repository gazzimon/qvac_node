#!/usr/bin/env node
'use strict'

// Deshace cada arreglo, corre la suite, y comprueba que ROMPA el test que lo
// vigila. Restaura el archivo pase lo que pase.
//
// -----------------------------------------------------------------------------
// POR QUE EXISTE
//
// La regla que salio de B18: **una corrida verde no es evidencia de nada si el
// test no falla cuando se quita el arreglo.** Dos pasadas de la seccion 0-ter
// afirmaron "suite en verde" sobre una suite que fallaba la mitad de las veces,
// y ningun test se rompio para avisarlo.
//
// Un test que pasa prueba dos cosas a la vez y no las distingue: que el arreglo
// anda, y que el test mira donde tiene que mirar. La unica forma de separarlas
// es poner el bug de nuevo y ver caer el assert correcto. Eso se hacia a mano,
// una vez, el dia que se escribia el test -- o sea que la evidencia existia en
// la cabeza de quien lo hizo y se perdia ahi mismo. Aca esta escrita y se puede
// volver a correr.
//
// CUATRO RESULTADOS, y los dos del medio son los que mas informan:
//
//   OK         rompio, y rompio el test que se esperaba.
//   OTRO TEST  rompio, pero se cayo otra cosa: el arreglo esta acoplado a algo
//              mas, o el test que se creia que lo vigilaba no lo vigila.
//   NO ROMPIO  nadie lo mira. El arreglo esta sin red, y "la suite pasa" no
//              dice nada sobre el.
//   NO CORRIO  la suite no arranco. NO es un resultado sobre el arreglo: es la
//              ausencia de uno, y se cuenta como fallo por eso mismo. Sin esta
//              cuarta salida, una suite que moria antes del primer test se
//              reportaba como NO ROMPIO -- o sea, este arnes inventando el mismo
//              modo de falla que existe para atrapar. Ver `corrio()`.
//
// -----------------------------------------------------------------------------
// COMO SE AGREGA UNO
//
// Una entrada por arreglo, con el texto EXACTO del arbol en `de`. Si el ancla no
// existe se reporta SIN ANCLA en vez de pasar en silencio -- un refactor que
// mueve la linea tiene que romper esto, no volverlo decorativo.
//
//   npm run bug-puesto
//
// Tarda lo que tarden N corridas de la suite (~30 s cada una).

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const RAIZ = path.resolve(__dirname, '..')

const BUGS = [
  // ---- FASE 9 / D9 -------------------------------------------------------
  {
    n: 'D9: el tope declarado en el 402 se deja de aplicar',
    file: 'qvac/gateway.mjs',
    de: 'if (topeCobrado > 0 && estimarTokensDeSalida(contenido) >= topeCobrado) {',
    a: 'if (false && topeCobrado > 0 && estimarTokensDeSalida(contenido) >= topeCobrado) {',
    suite: 'integracion',
    espera: ['D9/D27 caso 3', 'y se corto']
  },

  // ---- FASE 9 / D27 ------------------------------------------------------
  {
    n: 'D27 caso 1: se vuelve a acumular lo que llega DESPUES del corte',
    file: 'qvac/gateway.mjs',
    de: '    if (cancelado || cortadoPorTope) return\n',
    a: '    if (cortadoPorTope) return\n',
    suite: 'integracion',
    espera: ['el tardio se descarto', 'conto UN chunk']
  },
  {
    n: 'D27 caso 1: un corte NUESTRO vuelve a leerse como falla del proveedor',
    file: 'qvac/gateway.mjs',
    de: '    if (signal.aborted && started) {\n      return { ok: true, started, cortado: true, code: null, message: null }\n    }',
    a: '',
    suite: 'integracion',
    espera: ['D27 caso 1']
  },
  {
    n: 'D27 caso 2: se liquida aunque el intento haya fallado',
    file: 'qvac/gateway.mjs',
    de: '    if (ultimo && ultimo.ok) {',
    a: '    if (ultimo) {',
    suite: 'integracion',
    espera: ['D27 caso 2', 'no puede salir como respuesta valida']
  },

  // ---- FASE 9 / D25 ------------------------------------------------------
  {
    n: 'D25: la fuente del conteo se afirma siempre como medida',
    file: 'qvac/gateway.mjs',
    de: "    tokensFuente: decodeReal && prefillReal ? 'proveedor' : 'gateway'",
    a: "    tokensFuente: 'proveedor'",
    suite: 'integracion',
    espera: ['D25', 'la fuente lo dice']
  },

  // ---- FASE 9 / D24 ------------------------------------------------------
  {
    n: 'D24: la atestacion deja de atarse a quien dice haber servido',
    file: 'qvac/atestacion.mjs',
    de: "  if (firmante.toLowerCase() !== String(atestacion.providerPubkey || '').toLowerCase()) {",
    a: '  if (false) {',
    suite: 'unit',
    espera: ['firmar con TU wallet']
  },
  {
    n: 'D24: se firma un subconjunto en vez del artefacto entero',
    file: 'qvac/atestacion.mjs',
    de: '  const { signature, ...resto } = atestacion // eslint-disable-line no-unused-vars\n  return canonicalize(resto)',
    a: '  return canonicalize({ requestId: atestacion.requestId })',
    suite: 'unit',
    espera: ['cambiar UN campo']
  },
  {
    n: 'D24: sin firmante sale igual, sin firma',
    file: 'qvac/atestacion.mjs',
    de: "  if (typeof firmarMensaje !== 'function') return null",
    a: "  if (typeof firmarMensaje !== 'function') return { ...atestacion }",
    suite: 'unit',
    espera: ['sin firmante no']
  },
  {
    n: 'D24: este nodo vuelve a atestiguar lo que sirvio un par',
    file: 'qvac/atestacion.mjs',
    de: "  if (node.kind === 'peer') {",
    a: '  if (false) {',
    suite: 'unit',
    espera: ['lo que sirvio un par, NO']
  },
  // ---- D30 / BLOQUE 0 ----------------------------------------------------
  //
  // Las precondiciones de D30. Ninguna de estas es una funcionalidad nueva: son
  // los cuatro lugares donde algo se podia perder o mandar a la red equivocada,
  // y por eso lo que hay que comprobar no es que "anden" sino que alguien mire.
  {
    n: 'D30.1: el keystore vuelve a %TEMP%, que es de donde D30 lo saco',
    file: 'qvac/wallet.mjs',
    de: '  const dir = app ? path.join(persistente, app) : path.resolve(String(persistente))',
    a: '  const dir = app ? path.join(temp, app) : path.resolve(String(temp))',
    suite: 'unit',
    espera: ['no cuelga de temp', 'no es volatil']
  },
  {
    n: 'D30.1: sin persistente se cae a temp en vez de cortar',
    file: 'qvac/wallet.mjs',
    de: "    throw new Error('wallet: no hay directorio persistente donde poner el keystore')",
    a: '    persistente = temp',
    suite: 'unit',
    espera: ['sin persistente se corta']
  },
  {
    n: 'D30.2: el rpc elegido deja de llegar a la cuenta (vuelve a ganar mainnet)',
    file: 'qvac/wallet.mjs',
    de: '  const url = rpc || elegida.rpc',
    a: '  const url = REDES[RED_DEFAULT].rpc',
    suite: 'unit',
    espera: ['contra el rpc que se pidio']
  },
  {
    n: 'D30.2: mainnet deja de estar marcada como mainnet',
    file: 'qvac/wallet.mjs',
    de: "    explorer: 'https://plasmascan.to',\n    mainnet: true",
    a: "    explorer: 'https://plasmascan.to',\n    mainnet: false",
    suite: 'unit',
    espera: ['marcada como MAINNET', 'las dos tablas coinciden']
  },
  {
    n: 'D30.3: el artefacto deja de corresponder a la fuente que esta al lado',
    file: 'scripts/activo-prueba.sol',
    de: 'string public constant symbol = "tUSD";',
    a: 'string public constant symbol = "tUSDX";',
    suite: 'unit',
    espera: ['se compilo de ESTA fuente']
  },
  {
    n: 'D30: el guardia de redes pasa de lista blanca a "todo vale"',
    file: 'scripts/redes-prueba.js',
    de: '  if (TESTNETS[id]) return null',
    a: '  return null',
    suite: 'unit',
    espera: ['NO se estrena', 'una cadena desconocida no se estrena']
  },
  {
    // Sin el guardia el facilitator TAMPOCO arranca contra 9745 -- se cae mas
    // adelante, cuando `testnetDe` devuelve null. Eso es defensa en profundidad y
    // esta bien, pero lo que se pierde es el MOTIVO: en vez de "D30 dice que no",
    // el operador ve un TypeError. Por eso lo que este ancla vigila es el mensaje,
    // que es la parte que efectivamente desaparece.
    n: 'D30.4: el facilitator deja de decir POR QUE no se levanta contra mainnet',
    file: 'scripts/facilitator.js',
    de: "  if (motivo) throw new Error('NO SE LEVANTA. ' + motivo)",
    a: "  if (false) throw new Error('NO SE LEVANTA. ' + motivo)",
    suite: 'integracion',
    espera: ['y dice por que', 'nombrando la decision']
  },
  {
    n: 'D30.4: el facilitator vuelve a anunciar las mainnets de fabrica',
    file: 'scripts/facilitator.js',
    de: '    const kinds = ((soportado && soportado.kinds) || []).filter((k) => k.network === red.caip2)',
    a: '    const kinds = (soportado && soportado.kinds) || []',
    suite: 'integracion',
    espera: [
      'no anuncia una sola red que no pueda servir',
      'ninguna mainnet de la lista de fabrica'
    ]
  },

  // ---- FASE 9 VISIBLE — los cuatro artefactos, mirables ------------------
  //
  // Estos no vigilan que la fase EMITA nada -- eso ya lo cubren los de arriba.
  // Vigilan que lo emitido llegue a la pantalla CON SU SIGNIFICADO, que es un
  // modo de falla distinto y mas silencioso: el panel se sigue sirviendo entero,
  // la suite sigue verde, y lo que se pierde es la unica forma que tiene una
  // persona de comprobar un mock, una ausencia o un hash.
  {
    n: 'panel: el BLAKE2b del panel se rompe en el limite de bloque',
    file: 'qvac/panel-x402.mjs',
    de: '  while (n - i > 128) {',
    a: '  while (n - i >= 128) {',
    suite: 'unit',
    espera: ['mismo hash para una entrada de 128 chars']
  },
  {
    n: 'panel regla 1: la ausencia de atestacion pierde el motivo',
    file: 'qvac/panel-x402.mjs',
    de: '      escaparHtml(v.motivo) +',
    a: "      '—' +",
    suite: 'unit',
    espera: ['el motivo APARECE en lo que se dibuja']
  },
  {
    n: 'panel regla 2: un runtime mock deja de verse como mock',
    file: 'qvac/panel-x402.mjs',
    de: "  const esMock = runtime === 'mock' || runtime.indexOf('mock') === 0",
    a: '  const esMock = false',
    suite: 'unit',
    espera: ['un artefacto firmado con una wallet REAL', 'el mock sale nombrado en el dibujo']
  },
  {
    n: 'panel regla 3: un conteo del gateway se afirma como medido',
    file: 'qvac/panel-x402.mjs',
    de: "  if (fuente === 'proveedor') {",
    a: '  if (fuente !== null) {',
    suite: 'unit',
    espera: ['sin usage lo que hay es una estimacion', 'dos conteos de distinta procedencia']
  },
  {
    n: 'panel regla 4: el tx del facilitator de pruebas pasa por bueno',
    file: 'qvac/panel-x402.mjs',
    de: '  const todosIguales =\n    bytes.length > 1 &&',
    a: '  const todosIguales =\n    false &&',
    suite: 'unit',
    espera: ['se reconoce por lo que es']
  },
  {
    n: 'panel: "no pude comparar" se dibuja como si coincidiera',
    file: 'qvac/panel-x402.mjs',
    de: "      estado: 'sin-material',",
    a: "      estado: 'coincide',",
    suite: 'unit',
    espera: ['should be equal']
  },
  {
    n: 'panel: el codigo deja de viajar al chat (se sirve el panel ciego)',
    file: 'qvac/pages.mjs',
    de: '${ESC}\n${FUENTE_EMBEBIDA}\n${MODAL_JS}\n${CHAT_JS}',
    a: '${ESC}\n${MODAL_JS}\n${CHAT_JS}',
    suite: 'integracion',
    espera: ['lleva embebido el codigo de panel-x402.mjs']
  },
  {
    n: 'panel: el chat deja de dibujar el 402 del turno',
    file: 'qvac/pages.mjs',
    de: "          (m.x402 ? htmlDeDesafio(m.x402) : '') +",
    a: "          '' +",
    suite: 'integracion',
    espera: ['el chat dibuja el 402 del turno']
  },
  {
    n: 'panel: el chat tira el evento SSE del recibo',
    file: 'qvac/pages.mjs',
    de: '              slot.recibo = ev',
    a: '              slot.recibo = null',
    suite: 'integracion',
    espera: ['guardando el evento SSE final de D12']
  },
  {
    n: 'panel: el rastro de /node pierde el split de D25',
    file: 'qvac/pages.mjs',
    de: '      const conteo = htmlDeConteo(vistaDeConteo(e))',
    a: "      const conteo = ''",
    suite: 'integracion',
    espera: ['pinta el split de D25']
  },
  {
    n: 'panel: el recibo se pide CON credencial, y se pierde la excepcion del 402',
    file: 'qvac/pages.mjs',
    de: "        const r = await fetch('/v1/receipts/' + encodeURIComponent(id))",
    a: "        const r = await authFetch('/v1/receipts/' + encodeURIComponent(id))",
    suite: 'integracion',
    espera: ['SIN credencial', 'excepcion deliberada a B12']
  },

  // ---- EL ARNES MISMO ----------------------------------------------------
  //
  // La sonda de puertos no es una funcionalidad del producto: es lo que hace que
  // la suite de integracion pueda correr dos veces seguidas, que es la condicion
  // para que este arnes signifique algo. Si miente, `elegirPuertos` entrega un
  // bloque ocupado, el gateway hace `Bare.exit(1)` y la corrida sale sin una
  // sola linea de TAP -- que es el caso que `corrio()` ahora reporta como NO
  // CORRIO en vez de como NO ROMPIO.
  {
    n: 'arnes: la sonda de puertos dice que un puerto ocupado esta libre',
    file: 'test/integracion.js',
    de: "    s.on('error', () => resolve(false))",
    a: "    s.on('error', () => resolve(true))",
    suite: 'integracion',
    espera: ['un puerto con un listener encima NO esta libre']
  }
]

function unaCorrida(suite) {
  try {
    return execSync('npm run test:' + suite, { cwd: RAIZ, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    // La suite roja sale por exit != 0: es el caso ESPERADO acá, no un error.
    return (e.stdout || '') + (e.stderr || '')
  }
}

// Una corrida que NO ARRANCÓ no es una corrida verde, y la diferencia importa
// más acá que en ningún otro lado: este arnés lee "no salió ningún `not ok`"
// como "nadie vigila este arreglo". O sea que una suite que ni siquiera llegó a
// correr se reporta como un agujero de cobertura que no existe -- y al revés, un
// agujero real se puede esconder detrás del mismo síntoma.
//
// Pasa de verdad y no es hipotético: `test:integracion` bindea 127.0.0.1:8899, y
// entre dos corridas seguidas el puerto queda en TIME_WAIT. La segunda muere con
// "el puerto 8899 ya esta en uso" ANTES del primer test, sin una sola línea TAP.
// Con las entradas de la Fase 9 el arnés pasó a encadenar cinco corridas de
// integración seguidas y el falso "NO ROMPIÓ" apareció en tres de ellas.
//
// La marca de que corrió es el plan de TAP (`1..N`): lo escribe brittle al
// terminar de enumerar, y no existe si el proceso murió antes.
function corrio(salida) {
  return /^1\.\.\d+/m.test(salida) || /^# tests = /m.test(salida)
}

function dormir(ms) {
  // Sincrónico a propósito: todo este script lo es, y meter async acá obligaría
  // a volver asíncrono el loop que restaura los archivos en un `finally`.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function correr(suite) {
  // Tres intentos, esperando a que el TIME_WAIT del puerto se vaya. Si igual no
  // arranca, se devuelve lo último y `main` lo reporta como NO CORRIÓ -- nunca
  // como si la suite hubiera pasado.
  let salida = ''
  for (let i = 0; i < 3; i++) {
    if (i > 0) dormir(5000)
    salida = unaCorrida(suite)
    if (corrio(salida)) return salida
  }
  return salida
}

// Los asserts que fallan salen INDENTADOS bajo su test y solo el contenedor sale
// al margen. Anclar al margen perderia los primeros, que suelen ser los que
// dicen que se rompio de verdad.
function loQueRompio(salida) {
  return (salida.match(/not ok \d+ - .*/g) || []).map(
    (l) => l.replace(/^\s*not ok \d+ - /, '').split(' #')[0]
  )
}

function main() {
  const soloEstos = process.argv.slice(2)
  const lista = soloEstos.length
    ? BUGS.filter((b) => soloEstos.some((s) => b.n.toLowerCase().includes(s.toLowerCase())))
    : BUGS

  if (lista.length === 0) {
    console.error('[bug-puesto] ningun arreglo matchea ' + JSON.stringify(soloEstos))
    process.exit(1)
  }

  console.log(`[bug-puesto] ${lista.length} arreglo(s), una corrida de la suite por cada uno\n`)

  let fallos = 0
  for (const b of lista) {
    const ruta = path.join(RAIZ, b.file)
    const original = fs.readFileSync(ruta, 'utf8')

    // El ancla que ya no existe NO se saltea en silencio: un refactor que mueve
    // la linea tiene que romper esto. Si no, el arnes queda pasando siempre y
    // deja de significar algo -- que es el mismo modo de falla que existe para
    // atrapar.
    if (original.indexOf(b.de) === -1) {
      console.log('SIN ANCLA  ' + b.n)
      console.log('           el texto de `de` ya no esta en ' + b.file)
      fallos++
      continue
    }

    fs.writeFileSync(ruta, original.replace(b.de, b.a), 'utf8')
    let salida = ''
    try {
      salida = correr(b.suite)
    } finally {
      // Pase lo que pase. Un arnes que puede dejar el arbol con un bug adentro
      // es peor que no tenerlo.
      fs.writeFileSync(ruta, original, 'utf8')
    }

    const rotos = loQueRompio(salida)
    const elCorrecto = b.espera.some((e) => rotos.some((l) => l.indexOf(e) !== -1))

    if (!corrio(salida)) {
      // El cuarto resultado, y el unico que no dice nada sobre el arreglo: la
      // suite no llego a correr. Se cuenta como fallo porque quedarse sin
      // evidencia no es lo mismo que tenerla.
      console.log('NO CORRIO  ' + b.n)
      console.log('           la suite no llego a arrancar en 3 intentos; esto NO dice nada')
      console.log('           sobre el arreglo. Ultimas lineas:')
      for (const l of salida.trim().split('\n').slice(-3)) console.log('           | ' + l.trim())
      fallos++
    } else if (rotos.length && elCorrecto) {
      console.log('OK         ' + b.n)
      console.log('           rompio: ' + rotos.join(' | ').slice(0, 140))
    } else if (rotos.length) {
      console.log('OTRO TEST  ' + b.n)
      console.log('           esperaba: ' + b.espera.join(' / '))
      console.log('           rompio:   ' + rotos.join(' | ').slice(0, 200))
      fallos++
    } else {
      console.log('NO ROMPIO  ' + b.n)
      console.log('           <-- nadie vigila este arreglo: la suite pasa con el bug puesto')
      fallos++
    }
  }

  console.log('')
  if (fallos === 0) {
    console.log(`[bug-puesto] los ${lista.length} arreglos tienen quien los vigile`)
    process.exit(0)
  }
  console.log(`[bug-puesto] ${fallos} de ${lista.length} SIN vigilancia`)
  process.exit(1)
}

main()
