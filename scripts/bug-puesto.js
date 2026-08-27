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
// TRES RESULTADOS, y el del medio es el que mas informa:
//
//   OK         rompio, y rompio el test que se esperaba.
//   OTRO TEST  rompio, pero se cayo otra cosa: el arreglo esta acoplado a algo
//              mas, o el test que se creia que lo vigilaba no lo vigila.
//   NO ROMPIO  nadie lo mira. El arreglo esta sin red, y "la suite pasa" no
//              dice nada sobre el.
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
  }
]

function correr(suite) {
  try {
    return execSync('npm run test:' + suite, { cwd: RAIZ, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    // La suite roja sale por exit != 0: es el caso ESPERADO acá, no un error.
    return (e.stdout || '') + (e.stderr || '')
  }
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

    if (rotos.length && elCorrecto) {
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
