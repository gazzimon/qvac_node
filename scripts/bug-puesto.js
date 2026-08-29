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
  {
    n: 'panel regla 5: el costo del turno vuelve a tener su propia formula',
    file: 'qvac/pages.mjs',
    de: "partes.push('<span class=\"cost\">' + esc(textoDeCostoEstimado(m.cost).texto) + '</span>')",
    a: "partes.push('<span class=\"cost\">USD ' + m.cost / 1000000 + '</span>')",
    suite: 'integracion',
    espera: ['la misma regla que las vistas nuevas']
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
  },

  // ---- D30.4 / EL FACILITATOR CONTESTA ALGO QUE EL CLIENTE PUEDA LEER -----
  //
  // Los tres vigilan el mismo principio y por caminos distintos: del otro lado
  // hay un gateway que YA sirvio los tokens (D12 liquida DESPUES) y que tiene
  // que poder registrar POR QUE no cobro. Ese campo termina en el recibo, en el
  // panel, y es lo que la Fase 10 va a leer para decidir si un fallo se
  // reintenta, se descarta o acusa a alguien.
  //
  // Los tres FALLAN EN SILENCIO si nadie mira con el cliente oficial: la
  // respuesta se ve perfecta en el JSON crudo y se rompe en el parseo.
  {
    n: 'facilitator: /verify contesta con los nombres de campo de settle',
    file: 'scripts/facilitator.js',
    de: '  const errorDeVerify = (motivo, mensaje) => ({\n    isValid: false,\n    invalidReason: motivo,\n    invalidMessage: mensaje\n  })',
    a: '  const errorDeVerify = (motivo, mensaje) => ({\n    isValid: false,\n    errorReason: motivo,\n    errorMessage: mensaje\n  })',
    suite: 'integracion',
    espera: ['y el MOTIVO llega al cliente', 'en el campo que verify declara']
  },
  {
    n: 'facilitator: /settle omite transaction y network, y el cliente descarta todo',
    file: 'scripts/facilitator.js',
    de: "    transaction: '',\n    network: network || ''",
    a: "    network: network || ''",
    suite: 'integracion',
    espera: ['settle no puede tirar', 'transaction presente aunque vacio']
  },
  {
    n: 'facilitator: el catch vuelve a contestar una sola forma para las dos rutas',
    file: 'scripts/facilitator.js',
    de: "      if (ruta === '/settle') {\n        return responder(res, 200, errorDeSettle('facilitator_error', message, redDelPago))\n      }",
    a: '',
    suite: 'integracion',
    espera: ['settle no puede tirar']
  },
  {
    n: 'arnes: el bloque de puertos deja de reservar los derivados del facilitator',
    file: 'test/integracion.js',
    de: 'const OFFSETS = [4, 5, 6, 7, 8, 9]',
    a: 'const OFFSETS = [4, 7, 8, 9]',
    suite: 'integracion',
    espera: ['esta reservado']
  },

  // ---- D30.3 / EL ACTIVO HABLA EL IDIOMA QUE LA HERRAMIENTA CLASIFICA -----
  //
  // Nota sobre lo que estas dos entradas prueban y lo que no: cualquier edicion
  // del `.sol` rompe TAMBIEN el assert del SHA-256 del artefacto, que es lo
  // correcto y es otro guardia. O sea que ver caer el test esperado no prueba
  // que ese test sea el UNICO que mira -- prueba que traducir un revert string
  // no puede pasar en silencio, que es la propiedad que importa.
  {
    n: 'activo: un revert string vuelve al castellano y deja de clasificarse',
    file: 'scripts/activo-prueba.sol',
    de: '        require(block.timestamp < validBefore, "tUSD: authorization is expired");',
    a: '        require(block.timestamp < validBefore, "tUSD: la autorizacion ya vencio");',
    suite: 'unit',
    espera: ['el contrato dice: tUSD: authorization is expired']
  },
  {
    n: 'activo: el saldo insuficiente deja de distinguirse del fallo generico',
    file: 'scripts/activo-prueba.sol',
    de: '        require(saldo >= value, "tUSD: transfer amount exceeds balance");',
    a: '        require(saldo >= value, "tUSD: saldo insuficiente");',
    suite: 'unit',
    espera: ['el contrato dice: tUSD: transfer amount exceeds balance']
  },
  {
    n: 'activo: el artefacto deja de decir con que clave de fuente se compilo',
    file: 'scripts/activo-prueba.artefacto.json',
    de: '  "claveFuente": "activo-prueba.sol",\n',
    a: '',
    suite: 'unit',
    espera: ['y con la clave de fuente']
  },

  // ---- FASE 10 / RECIBOS Y LOTE ----------------------------------------
  //
  // La liquidacion diferida es el mismo flujo de la Fase 9 con el settlement
  // aplazado (D12). Lo que se puede romper en silencio: acumular lo que NO
  // servimos, o dar por bueno un lote sin mirar las firmas de adentro -- las dos
  // fallas se ven identicas a que funcione hasta que alguien liquida.
  {
    n: 'Fase 10: el gateway deja de acumular en el lote lo que sirvio',
    file: 'qvac/gateway.mjs',
    de: '    if (paraMi) {',
    a: '    if (false && paraMi) {',
    suite: 'integracion',
    espera: ['los dos pagos verificados entraron al lote']
  },
  {
    n: 'Fase 10: un lote deja de exigir una sola red y una sola wallet',
    file: 'qvac/lote.mjs',
    de: '  const unicos = [...porNonce.values()]\n  mismoDestino(unicos)',
    a: '  const unicos = [...porNonce.values()]',
    suite: 'unit',
    espera: ['dos redes en un lote no', 'dos destinos en un lote tampoco']
  },
  {
    n: 'Fase 10: verificarLote deja de mirar la autorizacion EIP-3009 de cada recibo',
    file: 'qvac/lote.mjs',
    de: '    const motivo = await verificarAutorizacion(r, viem, evm)\n    if (motivo) recibosMal.push({ nonce: r.nonce, reason: motivo })',
    a: '    void r',
    suite: 'unit',
    espera: ['senala EXACTAMENTE el recibo malo']
  },
  {
    n: 'Fase 10: un lote alterado despues de firmar pasa igual',
    file: 'qvac/lote.mjs',
    de: "  if (sumar(lote.recibos) !== String(lote.totalAmount)) {\n    return { ok: false, reason: 'el totalAmount no es la suma de los recibos', firmante }\n  }",
    a: '',
    suite: 'unit',
    espera: ['un total cambiado no pasa']
  },
  {
    n: 'Fase 10: x402 deja de armar un accepts[] para plasma-testnet (9746)',
    file: 'qvac/x402.mjs',
    de: "  if (red === 'plasma-testnet') {",
    a: "  if (false && red === 'plasma-testnet') {",
    suite: 'integracion',
    espera: ['con ASSET y NAME declarados, la red se ofrece']
  },

  // ---- FASE 10 / PERSISTENCIA Y FLUSH DEL ACUMULADOR ----------------------
  //
  // `_pend` es memoria del proceso. Lo que se rompe en silencio: el acumulador
  // no se espeja a disco (un corte entre servir y liquidar regala el cobro), o
  // no se recarga al arrancar, o el flush no marca lo liquidado (y reanudar
  // vuelve a cobrar), o el disparador por tamano/close no corre.
  {
    n: 'Fase 10: el acumulador ya no se escribe atomico a disco',
    file: 'qvac/lote.mjs',
    de: '    fs.renameSync(tmp, _archivo)',
    a: '    void tmp',
    suite: 'unit',
    espera: ['dos lineas JSON en el archivo']
  },
  {
    n: 'Fase 10: los pendientes de una corrida anterior no se recargan',
    file: 'qvac/lote.mjs',
    de: '          if (k) _pend.set(k, r)',
    a: '          void r',
    suite: 'unit',
    espera: ['abrir devuelve cuantos recibos rescato']
  },
  {
    n: 'Fase 10: el flush no marca lo liquidado y reanudar vuelve a cobrar',
    file: 'qvac/lote.mjs',
    de: '      marcarLiquidados(res.liquidados)\n      resultados.push({',
    a: '      void res\n      resultados.push({',
    suite: 'unit',
    espera: ['un corte y reanudar no vuelve a cobrar', 'lo liquidado, no solo la memoria']
  },
  {
    n: 'Fase 10: el flush por tamano deja de mirar el umbral y corre siempre',
    file: 'qvac/lote.mjs',
    de: '  if (contar({ soloPendientes: true }) < _umbral) return null',
    a: '  if (false) return null',
    suite: 'unit',
    espera: ['el flush por tamano NO corre']
  },
  {
    n: 'Fase 10: el close deja de vaciar el lote antes de salir',
    file: 'qvac/lote.mjs',
    de: '  if (flush && _liquidar) {',
    a: '  if (false && flush && _liquidar) {',
    suite: 'unit',
    espera: ['el close arma-firma-liquida lo pendiente']
  },

  // ---- FASE 10 / TRANSPORTE POR PROTOMUX -----------------------------------
  //
  // El handoff: un request ruteado lo cobra EL PAR que corrio el modelo, no el
  // gateway. Lo que se rompe en silencio: el par sirve y no acumula (trabajo
  // regalado), o el gateway sigue liquidando un ruteado (doble via de cobro), o
  // el tope no llega y la atestacion atestigua de mas.
  {
    n: 'Fase 10: el par sirve un ruteado y NO acumula el recibo',
    file: 'qvac/provider.mjs',
    de: '      lote.agregar(recibo)',
    a: '      void recibo',
    suite: 'unit',
    espera: ['el par acumulo el recibo en SU lote']
  },
  {
    n: 'Fase 10: el gateway vuelve a liquidar un request que sirvio un par',
    file: 'qvac/gateway.mjs',
    de: "  if (node && node.kind === 'peer') {",
    a: "  if (false && node && node.kind === 'peer') {",
    suite: 'integracion',
    espera: ['el settlement es del par, diferido']
  },
  {
    n: 'Fase 10: el par deja de recortar en el tope del 402',
    file: 'qvac/provider.mjs',
    de: "        if (tope > 0 && Buffer.byteLength(contenido, 'utf8') / 4 >= tope) {",
    a: '        if (false) {',
    suite: 'unit',
    espera: ['corto en el tope', 'la atestacion dice length']
  },
  {
    n: 'Fase 10: el par atestigua un cobro cuyo payTo no es su wallet',
    file: 'qvac/provider.mjs',
    de: "      if (String(p.requirements.payTo || '').toLowerCase() !== this.walletAddress.toLowerCase()) {",
    a: '      if (false) {',
    suite: 'unit',
    espera: ['no atestigua un cobro que no es suyo', 'no acumula nada']
  },

  // ---- FASE 10 / D27 CASO 1 — LA ATESTACION DEL PAR VUELVE TRAS EL CORTE ---
  //
  // El cliente corta, el par YA sirvio un prefijo y lo atestigua. Lo que se
  // rompe en silencio: `cancelChat` borra el chat en el acto y el `chat:done`
  // tardio del par se descarta (el rastro queda con attestationMissing aunque el
  // par si cobro su prefijo), o el par ni siquiera manda ese `chat:done` cuando
  // lo cancelaron.
  {
    n: 'Fase 10 / D27 caso 1: cancelChat vuelve a borrar el chat en el acto',
    file: 'qvac/swarm.mjs',
    de: '    chat._graceTimer = setTimeout(() => {\n      if (this._chats.get(requestId) !== chat) return\n',
    a: '    this._chats.delete(requestId)\n    chat._graceTimer = setTimeout(() => {\n      if (this._chats.get(requestId) !== chat) return\n',
    suite: 'unit',
    espera: ['el chat:done tardio SI llego a onDone, no se descarto']
  },
  {
    n: 'Fase 10 / D27 caso 1: el par cancelado no manda su chat:done con la atestacion',
    file: 'qvac/provider.mjs',
    de: '      } else if (msg.payment && deltas > 0) {',
    a: '      } else if (false) {',
    suite: 'unit',
    espera: ['aun cancelado, el par manda su chat:done', 'quedo acumulado en el lote del par']
  },

  // ---- FASE 10 / SETTLEMENT batch-receipts LOCAL DIFIERE DE VERDAD -------
  //
  // Un nodo cuyo manifiesto declara `batch-receipts` NO liquida por request: el
  // schema lo decide, no un flag. Lo que se rompe en silencio: el gateway sigue
  // liquidando por request aunque el manifiesto diga batch-receipts (doble via
  // de cobro cuando el flush tambien corra, y una tx on-chain por request que el
  // modo existe para evitar).
  {
    n: 'Fase 10: un nodo batch-receipts vuelve a liquidar por request',
    file: 'qvac/gateway.mjs',
    de: "  const diferido = !!(economicPropio && economicPropio.settlement === 'batch-receipts')",
    a: '  const diferido = false',
    suite: 'integracion',
    espera: [
      'el facilitator NO recibio ninguna liquidacion por request',
      'que es diferido: settledBy = batch'
    ]
  },

  // ---- FASE 11 GROUNDWORK — qvac/x402-cliente.mjs (el rol PAGADOR) --------
  //
  // Este modulo NO es de la Fase 10: es el groundwork del pagador con
  // presupuesto de la Fase 11 (commit 3e8c764). Sus cinco tests viven en la
  // suite unit; estas anclas los cubren uno a uno. Lo que se rompe en silencio:
  // firmar un pago que el servidor rechaza, firmar por encima del techo, pagar
  // en una red que no reconocemos, no reenviar el X-PAYMENT en el reintento, o
  // arrancar un pagador sin techo.
  {
    n: 'Fase 11 groundwork: el pago que firma el cliente deja de verificar del lado servidor',
    file: 'qvac/x402-cliente.mjs',
    de: '    network: entrada.network,\n    payload: p.payload',
    a: "    network: 'eip155:1',\n    payload: p.payload",
    suite: 'unit',
    espera: ['verificarPago lo acepta']
  },
  {
    n: 'Fase 11 groundwork: crearPago deja de cortar por encima del techo',
    file: 'qvac/x402-cliente.mjs',
    de: '  if (techoUnidades != null && BigInt(entrada.amount) > BigInt(techoUnidades)) {',
    a: '  if (false) {',
    suite: 'unit',
    espera: ['se corta antes de firmar']
  },
  {
    n: 'Fase 11 groundwork: elegirEntrada deja de respetar la preferencia de D15',
    file: 'qvac/x402-cliente.mjs',
    de: "export const ORDEN_PREFERENCIA = ['plasma', 'plasma-testnet', 'stable']",
    a: "export const ORDEN_PREFERENCIA = ['stable', 'plasma-testnet', 'plasma']",
    suite: 'unit',
    espera: ['Plasma antes que Stable']
  },
  {
    n: 'Fase 11 groundwork: el reintento del baile 402 va sin el X-PAYMENT firmado',
    file: 'qvac/x402-cliente.mjs',
    de: "    headers: { ...headersBase, 'x-payment': pago.cabecera }",
    a: '    headers: { ...headersBase }',
    suite: 'unit',
    espera: ['el reintento lleva el X-PAYMENT firmado']
  },
  {
    n: 'Fase 11 groundwork: un pagador sin techo vuelve a arrancar',
    file: 'qvac/x402-cliente.mjs',
    de: "  throw new Error(\n    'x402-cliente: falta el techo de gasto (techoMicros o techoUnidades). ' +\n      'Un pagador sin límite no arranca — es la regla de la Fase 11.'\n  )",
    a: '  return 1n',
    suite: 'unit',
    espera: ['un pagador sin techo no arranca']
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
