#!/usr/bin/env node
'use strict'

// Auditoria del rastro de QVAC-Node: baja la serie completa del gateway, la
// guarda como evidencia y dictamina si hubo inferencia REAL.
//
// Existe para el video. Un panel que muestra tokens moviendose no prueba nada:
// cualquiera graba una animacion. Lo que prueba es un archivo que se puede
// abrir, contar y hashear delante de camara, con los numeros que solo salen
// de haber generado de verdad -- TTFT, tokens, tok/s, y de que nodo salieron.
//
//   node scripts/auditoria.js
//   node scripts/auditoria.js --url http://localhost:8787 --limit 1000
//   node scripts/auditoria.js --out logs/demo-final.jsonl
//
// El veredicto NO es decorativo: si en el rastro no hay ningun request con
// destino `local` o `peer` que haya devuelto tokens, el script sale con exit
// code 1 y lo dice. Un script de auditoria que siempre dice que si no audita
// nada. Los nodos `mock` (los de `serve --demo`) quedan EXCLUIDOS del
// veredicto a proposito y se muestran aparte: son respuestas enlatadas, y
// contarlas como inferencia seria exactamente la trampa que esto detecta.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function flag(nombre, porDefecto = null) {
  const i = process.argv.indexOf(nombre)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto
}

const URL_GATEWAY = (flag('--url', 'http://localhost:8787') || '').replace(/\/+$/, '')
const LIMITE = Number(flag('--limit', '1000')) || 1000
const SALIDA = flag('--out', null)

// ---------------------------------------------------------------------------
// Presentacion. Colores solo si hay TTY y nadie pidio lo contrario: el JSONL
// es la evidencia, pero esta salida es lo que se ve en pantalla.
// ---------------------------------------------------------------------------

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = (codigo, s) => (COLOR ? `\x1b[${codigo}m${s}\x1b[0m` : String(s))
const bold = (s) => c('1', s)
const verde = (s) => c('32', s)
const rojo = (s) => c('31', s)
const gris = (s) => c('90', s)
const cyan = (s) => c('36', s)

const ANCHO = 63
const regla = (titulo) =>
  titulo
    ? gris('  -- ' + titulo + ' ' + '-'.repeat(Math.max(0, ANCHO - 6 - titulo.length)))
    : gris('  ' + '-'.repeat(ANCHO - 2))

// Separador de miles sin depender del ICU de Node: con `small-icu`,
// toLocaleString('es-AR') devuelve el numero pelado y las columnas se
// desalinean justo en la corrida grande, que es la que se graba.
const miles = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

const pad = (s, n) => String(s).padEnd(n)
const padNum = (s, n) => String(s).padStart(n)

function mediana(valores) {
  const xs = valores.filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const m = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2
}

// La mediana y no el promedio: un solo request que pago la carga del modelo
// (12s de TTFT) arrastra el promedio y hace parecer lento un nodo que no lo
// es. La mediana describe el request tipico, que es lo que se esta afirmando.
const fmtMs = (v) => (v === null ? '-' : miles(Math.round(v)) + 'ms')
const fmtTps = (v) => (v === null ? '-' : v.toFixed(1))

// ---------------------------------------------------------------------------

async function bajarRastro() {
  const url = `${URL_GATEWAY}/v1/audit?limit=${LIMITE}`
  let res
  try {
    res = await fetch(url)
  } catch (err) {
    throw new Error(
      `no se pudo hablar con el gateway en ${URL_GATEWAY} (${(err && err.message) || err}).\n` +
        `  Levantalo con:  npm start -- serve --swarm --data\n` +
        `  O apunta a otro con:  node scripts/auditoria.js --url http://host:puerto`
    )
  }
  if (!res.ok) {
    // 404 es el caso probable y tiene una causa concreta: un gateway de una
    // version anterior, sin la ruta. Decirlo evita media hora de sospechar
    // del script.
    if (res.status === 404) {
      throw new Error(
        `el gateway respondio 404 en /v1/audit.\n` +
          `  Esa ruta la agrega esta version: reinicia el gateway con el codigo actual.`
      )
    }
    throw new Error(`el gateway respondio ${res.status} en /v1/audit`)
  }
  return await res.json()
}

// ---------------------------------------------------------------------------

function analizar(log) {
  const porKind = new Map()
  for (const e of log) porKind.set(e.kind || 'route', (porKind.get(e.kind || 'route') || 0) + 1)

  const rutas = log.filter((e) => (e.kind || 'route') === 'route')
  const destinos = new Map()

  for (const e of rutas) {
    const t = e.target || 'desconocido'
    if (!destinos.has(t)) {
      destinos.set(t, { reqs: 0, ok: 0, fallos: 0, tokens: 0, ttfts: [], tps: [] })
    }
    const d = destinos.get(t)
    d.reqs++
    // `ok` puede faltar en entradas viejas del bee, escritas antes de que el
    // campo existiera. Se cuentan como ok: es lo que el rastro decia entonces,
    // y inventarles un fallo seria peor que la ambiguedad.
    if (e.ok === false) d.fallos++
    else d.ok++
    d.tokens += Number(e.tokens) || 0
    if (typeof e.ttftMs === 'number') d.ttfts.push(e.ttftMs)
    if (typeof e.tokensPerSec === 'number') d.tps.push(e.tokensPerSec)
  }

  // El nucleo del veredicto. Tres condiciones, todas necesarias: destino no
  // simulado, request exitoso, y tokens efectivamente devueltos. Un request
  // que termino ok pero con cero tokens no genero nada.
  const reales = rutas.filter(
    (e) => (e.target === 'local' || e.target === 'peer') && e.ok !== false && Number(e.tokens) > 0
  )

  const d7 = {
    peer_first: log.find((e) => e.kind === 'peer_first') || null,
    manifest_verified: log.find((e) => e.kind === 'manifest_verified') || null
  }

  return { porKind, destinos, rutas, reales, d7 }
}

// ---------------------------------------------------------------------------

async function main() {
  const datos = await bajarRastro()

  // Cronologico ascendente. El bee entrega del mas nuevo al mas viejo porque
  // asi lo quiere el panel; una evidencia se lee al reves, de como empezo la
  // sesion a como termino.
  const log = (datos.log || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))

  if (log.length === 0) {
    console.log('')
    console.log(rojo('  El rastro esta VACIO.'))
    console.log('  El gateway no registro ningun evento todavia: mandale un chat y volve a correr.')
    console.log('')
    process.exit(1)
  }

  const { porKind, destinos, rutas, reales, d7 } = analizar(log)

  // -------------------------------------------------------------------------
  // Evidencia en disco. Se escribe ANTES de imprimir el resumen para que en el
  // video el archivo ya exista cuando se lo nombra.
  // -------------------------------------------------------------------------

  const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const destino = SALIDA || path.join('logs', `auditoria-${sello}.jsonl`)
  fs.mkdirSync(path.dirname(path.resolve(destino)), { recursive: true })

  const jsonl = log.map((e) => JSON.stringify(e)).join('\n') + '\n'
  fs.writeFileSync(destino, jsonl)
  const sha = crypto.createHash('sha256').update(jsonl).digest('hex')

  // -------------------------------------------------------------------------

  const linea = '='.repeat(ANCHO)
  console.log('')
  console.log(bold('  ' + linea))
  console.log(bold('   AUDITORIA DEL RASTRO - QVAC-Node'))
  console.log(bold('  ' + linea))
  console.log('')
  console.log(`  ${pad('Generado', 14)}: ${datos.generadoEn}`)
  console.log(`  ${pad('Gateway', 14)}: ${URL_GATEWAY}`)
  if (datos.nodo) {
    console.log(`  ${pad('Nodo', 14)}: ${datos.nodo.operator}`)
    console.log(`  ${pad('Clave publica', 14)}: ${datos.nodo.publicKey}`)
    console.log(`  ${pad('Pares verif.', 14)}: ${datos.nodo.verifiedPeers}`)
  } else {
    console.log(`  ${pad('Nodo', 14)}: ${gris('sin swarm (gateway suelto, sin identidad P2P)')}`)
  }
  console.log(
    `  ${pad('Persistido', 14)}: ` +
      (datos.persistido
        ? 'si - Hyperbee, sobrevive al reinicio'
        : rojo('NO') + gris(' - solo memoria; se pierde al cerrar (arranca con --data)'))
  )

  console.log('')
  console.log(regla('EVENTOS'))
  for (const [kind, n] of [...porKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(kind, 20)} ${padNum(miles(n), 6)}`)
  }
  const desde = new Date(log[0].ts).toISOString()
  const hasta = new Date(log[log.length - 1].ts).toISOString()
  console.log(`  ${bold(pad('total', 20))} ${bold(padNum(miles(log.length), 6))}`)
  console.log(gris(`  desde ${desde}  hasta ${hasta}`))

  console.log('')
  console.log(regla('INFERENCIA POR DESTINO'))
  console.log(
    gris(
      `  ${pad('destino', 12)}${padNum('reqs', 6)}${padNum('ok', 5)}${padNum('fallos', 8)}` +
        `${padNum('tokens', 9)}${padNum('ttft med', 11)}${padNum('tok/s med', 11)}`
    )
  )
  const orden = { peer: 0, local: 1, mock: 2 }
  const filas = [...destinos.entries()].sort((a, b) => (orden[a[0]] ?? 9) - (orden[b[0]] ?? 9))
  for (const [t, d] of filas) {
    const nota = t === 'mock' ? gris('  <- simulado, NO cuenta') : ''
    console.log(
      `  ${pad(t, 12)}${padNum(miles(d.reqs), 6)}${padNum(miles(d.ok), 5)}` +
        `${padNum(miles(d.fallos), 8)}${padNum(miles(d.tokens), 9)}` +
        `${padNum(fmtMs(mediana(d.ttfts)), 11)}${padNum(fmtTps(mediana(d.tps)), 11)}${nota}`
    )
  }
  if (filas.length === 0) console.log(gris('  (ningun request ruteado en el rastro)'))

  if (d7.peer_first || d7.manifest_verified) {
    console.log('')
    console.log(regla('D7 - DESCUBRIMIENTO P2P'))
    if (d7.peer_first) {
      console.log(`  ${pad('primer par', 26)} ${padNum(miles(d7.peer_first.ms), 9)} ms`)
    }
    if (d7.manifest_verified) {
      console.log(
        `  ${pad('primer manifiesto verif.', 26)} ${padNum(miles(d7.manifest_verified.ms), 9)} ms`
      )
    }
  }

  console.log('')
  console.log(regla('EVIDENCIA'))
  const kb = (Buffer.byteLength(jsonl) / 1024).toFixed(1)
  console.log(`  ${pad('Archivo', 10)}: ${cyan(destino)}`)
  console.log(`  ${pad('Contenido', 10)}: ${miles(log.length)} lineas JSONL, ${kb} KB`)
  console.log(`  ${pad('SHA-256', 10)}: ${sha}`)
  console.log(gris(`  Verificable con:  sha256sum ${destino}`))

  console.log('')
  console.log(regla(null))
  const mocks = destinos.get('mock')
  if (reales.length > 0) {
    const tokensReales = reales.reduce((a, e) => a + (Number(e.tokens) || 0), 0)
    console.log('  ' + bold(verde('VEREDICTO: HUBO INFERENCIA REAL')))
    console.log(
      `  ${miles(reales.length)} request(s) con destino local o peer devolvieron ` +
        `${miles(tokensReales)} tokens.`
    )
    const conPeer = reales.filter((e) => e.target === 'peer').length
    if (conPeer > 0) {
      console.log(
        conPeer === 1
          ? '  1 de esos se genero en OTRA maquina, por P2P.'
          : `  ${miles(conPeer)} de esos se generaron en OTRA maquina, por P2P.`
      )
    } else {
      console.log(gris('  Ninguno viajo por P2P: todos los genero este equipo.'))
    }
  } else {
    console.log('  ' + bold(rojo('VEREDICTO: NO HAY EVIDENCIA DE INFERENCIA REAL')))
    console.log('  Ningun request con destino local o peer devolvio tokens en este rastro.')
    if (rutas.length > 0 && (!mocks || mocks.reqs < rutas.length)) {
      console.log(gris('  Hubo requests, pero fallaron o no generaron nada. Mira la tabla.'))
    }
  }
  if (mocks && mocks.reqs > 0) {
    console.log(
      gris(`  ${miles(mocks.reqs)} request(s) mock excluidos del veredicto (respuestas enlatadas).`)
    )
  }
  console.log('')

  process.exit(reales.length > 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('')
  console.error(rojo('  AUDITORIA FALLIDA'))
  console.error('  ' + ((err && err.message) || err))
  console.error('')
  process.exit(2)
})
