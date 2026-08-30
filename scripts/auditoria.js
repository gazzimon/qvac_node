#!/usr/bin/env node
'use strict'

// Audit of QVAC-Node's trace: downloads the gateway's full series, saves it
// as evidence, and rules on whether there was REAL inference.
//
// It exists for the video. A panel showing tokens moving around proves
// nothing: anyone can record an animation. What proves something is a file
// that can be opened, counted, and hashed on camera, with numbers that only
// come from having actually generated -- TTFT, tokens, tok/s, and which node
// they came from.
//
//   node scripts/auditoria.js
//   node scripts/auditoria.js --url http://localhost:8787 --limit 1000
//   node scripts/auditoria.js --out logs/demo-final.jsonl
//
// The verdict is NOT decorative: if the trace has no request targeting
// `local` or `peer` that returned tokens, the script exits with exit code 1
// and says so. An audit script that always says yes audits nothing. `mock`
// nodes (the ones from `serve --demo`) are deliberately EXCLUDED from the
// verdict and shown separately: they're canned responses, and counting them
// as inference would be exactly the trap this detects.

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
// Presentation. Colors only if there's a TTY and nobody asked otherwise: the
// JSONL is the evidence, but this output is what shows on screen.
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

// Thousands separator without depending on Node's ICU: with `small-icu`,
// toLocaleString('es-AR') returns the bare number and the columns get
// misaligned right on the big run, which is the one that gets recorded.
const miles = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

const pad = (s, n) => String(s).padEnd(n)
const padNum = (s, n) => String(s).padStart(n)

function mediana(valores) {
  const xs = valores.filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const m = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2
}

// The median and not the average: a single request that paid for the model
// load (12s of TTFT) drags the average and makes a node look slow when it
// isn't. The median describes the typical request, which is what's claimed.
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
      `could not reach the gateway at ${URL_GATEWAY} (${(err && err.message) || err}).\n` +
        `  Start it with:  npm start -- serve --swarm --data\n` +
        `  Or point at another one with:  node scripts/auditoria.js --url http://host:port`
    )
  }
  if (!res.ok) {
    // 404 is the likely case and has a concrete cause: a gateway from an
    // older version, without the route. Saying so saves half an hour of
    // suspecting the script.
    if (res.status === 404) {
      throw new Error(
        `the gateway responded 404 at /v1/audit.\n` +
          `  This version adds that route: restart the gateway with current code.`
      )
    }
    throw new Error(`the gateway responded ${res.status} at /v1/audit`)
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
    // `ok` can be missing on old bee entries, written before the field
    // existed. They're counted as ok: that's what the trace said back then,
    // and inventing a failure for them would be worse than the ambiguity.
    if (e.ok === false) d.fallos++
    else d.ok++
    d.tokens += Number(e.tokens) || 0
    if (typeof e.ttftMs === 'number') d.ttfts.push(e.ttftMs)
    if (typeof e.tokensPerSec === 'number') d.tps.push(e.tokensPerSec)
  }

  // The core of the verdict. Three conditions, all necessary: non-simulated
  // target, successful request, and tokens actually returned. A request that
  // ended ok but with zero tokens generated nothing.
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

  // Ascending chronological order. The bee delivers newest to oldest because
  // that's what the panel wants; evidence is read the other way, from how the
  // session started to how it ended.
  const log = (datos.log || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))

  if (log.length === 0) {
    console.log('')
    console.log(rojo('  The trace is EMPTY.'))
    console.log('  The gateway hasn\'t logged any event yet: send it a chat and run again.')
    console.log('')
    process.exit(1)
  }

  const { porKind, destinos, rutas, reales, d7 } = analizar(log)

  // -------------------------------------------------------------------------
  // Evidence on disk. Written BEFORE printing the summary so that in the
  // video the file already exists when it's named.
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
  console.log(bold('   TRACE AUDIT - QVAC-Node'))
  console.log(bold('  ' + linea))
  console.log('')
  console.log(`  ${pad('Generated', 14)}: ${datos.generadoEn}`)
  console.log(`  ${pad('Gateway', 14)}: ${URL_GATEWAY}`)
  if (datos.nodo) {
    console.log(`  ${pad('Node', 14)}: ${datos.nodo.operator}`)
    console.log(`  ${pad('Public key', 14)}: ${datos.nodo.publicKey}`)
    console.log(`  ${pad('Verif. peers', 14)}: ${datos.nodo.verifiedPeers}`)
  } else {
    console.log(`  ${pad('Node', 14)}: ${gris('no swarm (standalone gateway, no P2P identity)')}`)
  }
  console.log(
    `  ${pad('Persisted', 14)}: ` +
      (datos.persistido
        ? 'yes - Hyperbee, survives restart'
        : rojo('NO') + gris(' - memory only; lost on shutdown (start with --data)'))
  )

  console.log('')
  console.log(regla('EVENTS'))
  for (const [kind, n] of [...porKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(kind, 20)} ${padNum(miles(n), 6)}`)
  }
  const desde = new Date(log[0].ts).toISOString()
  const hasta = new Date(log[log.length - 1].ts).toISOString()
  console.log(`  ${bold(pad('total', 20))} ${bold(padNum(miles(log.length), 6))}`)
  console.log(gris(`  from ${desde}  to ${hasta}`))

  console.log('')
  console.log(regla('INFERENCE BY TARGET'))
  console.log(
    gris(
      `  ${pad('target', 12)}${padNum('reqs', 6)}${padNum('ok', 5)}${padNum('fails', 8)}` +
        `${padNum('tokens', 9)}${padNum('med ttft', 11)}${padNum('med tok/s', 11)}`
    )
  )
  const orden = { peer: 0, local: 1, mock: 2 }
  const filas = [...destinos.entries()].sort((a, b) => (orden[a[0]] ?? 9) - (orden[b[0]] ?? 9))
  for (const [t, d] of filas) {
    const nota = t === 'mock' ? gris('  <- simulated, does NOT count') : ''
    console.log(
      `  ${pad(t, 12)}${padNum(miles(d.reqs), 6)}${padNum(miles(d.ok), 5)}` +
        `${padNum(miles(d.fallos), 8)}${padNum(miles(d.tokens), 9)}` +
        `${padNum(fmtMs(mediana(d.ttfts)), 11)}${padNum(fmtTps(mediana(d.tps)), 11)}${nota}`
    )
  }
  if (filas.length === 0) console.log(gris('  (no request routed in the trace)'))

  if (d7.peer_first || d7.manifest_verified) {
    console.log('')
    console.log(regla('D7 - P2P DISCOVERY'))
    if (d7.peer_first) {
      console.log(`  ${pad('first peer', 26)} ${padNum(miles(d7.peer_first.ms), 9)} ms`)
    }
    if (d7.manifest_verified) {
      console.log(
        `  ${pad('first verif. manifest', 26)} ${padNum(miles(d7.manifest_verified.ms), 9)} ms`
      )
    }
  }

  console.log('')
  console.log(regla('EVIDENCE'))
  const kb = (Buffer.byteLength(jsonl) / 1024).toFixed(1)
  console.log(`  ${pad('File', 10)}: ${cyan(destino)}`)
  console.log(`  ${pad('Content', 10)}: ${miles(log.length)} JSONL lines, ${kb} KB`)
  console.log(`  ${pad('SHA-256', 10)}: ${sha}`)
  console.log(gris(`  Verifiable with:  sha256sum ${destino}`))

  console.log('')
  console.log(regla(null))
  const mocks = destinos.get('mock')
  if (reales.length > 0) {
    const tokensReales = reales.reduce((a, e) => a + (Number(e.tokens) || 0), 0)
    console.log('  ' + bold(verde('VERDICT: THERE WAS REAL INFERENCE')))
    console.log(
      `  ${miles(reales.length)} request(s) with local or peer target returned ` +
        `${miles(tokensReales)} tokens.`
    )
    const conPeer = reales.filter((e) => e.target === 'peer').length
    if (conPeer > 0) {
      console.log(
        conPeer === 1
          ? '  1 of those was generated on ANOTHER machine, over P2P.'
          : `  ${miles(conPeer)} of those were generated on ANOTHER machine, over P2P.`
      )
    } else {
      console.log(gris('  None traveled over P2P: this machine generated all of them.'))
    }
  } else {
    console.log('  ' + bold(rojo('VERDICT: NO EVIDENCE OF REAL INFERENCE')))
    console.log('  No request with local or peer target returned tokens in this trace.')
    if (rutas.length > 0 && (!mocks || mocks.reqs < rutas.length)) {
      console.log(gris('  There were requests, but they failed or generated nothing. Check the table.'))
    }
  }
  if (mocks && mocks.reqs > 0) {
    console.log(
      gris(`  ${miles(mocks.reqs)} mock request(s) excluded from the verdict (canned responses).`)
    )
  }
  console.log('')

  process.exit(reales.length > 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('')
  console.error(rojo('  AUDIT FAILED'))
  console.error('  ' + ((err && err.message) || err))
  console.error('')
  process.exit(2)
})
