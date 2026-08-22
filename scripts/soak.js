#!/usr/bin/env node
'use strict'

// Soak de robustez end-to-end de QVAC-Node.
//
// Corre el ciclo real N veces seguidas y reporta la distribucion, no el mejor
// caso. Existe porque los tres modos de falla que arruinan una demo no se ven
// en una corrida sola:
//
//   1. El proceso no termina. `unloadModel` deja arriba el swarm, el registry
//      client y el corestore a proposito; si `close()` no cierra todo alguna
//      vez, el CLI responde y se queda colgado con el cursor titilando.
//   2. El registry timeoutea. Resolver el modelo pega contra el swarm de QVAC:
//      con wifi malo eso falla de a ratos, no siempre.
//   3. El install P2P se cuelga en 0 B/s. Documentado en NOTES.md: el enlace
//      cliente-a-cliente de la sala se degrado hasta desaparecer.
//
//   node scripts/soak.js                       5 prompts sobre el binario local
//   node scripts/soak.js --runs 10             mas vueltas
//   node scripts/soak.js --gpu-layers 0        pasandole flags al CLI
//   node scripts/soak.js --install --runs 3    incluye `pear install` desde el link
//   node scripts/soak.js --bin <ruta>          contra otro binario (p.ej. el instalado)
//
// Un FAIL no es opinion: es exit code distinto de 0, salida sin respuesta, o
// un proceso que hubo que matar por timeout.

const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const isWindows = os.platform() === 'win32'

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i === -1 ? def : argv[i + 1]
}
const has = (name) => argv.includes(name)

const runs = Number(flag('--runs', 5))
const doInstall = has('--install')
// Timeout por corrida. Generoso a proposito: en frio el modelo son 807 MB por
// hypercore. Lo que se busca cazar es el cuelgue infinito, no la lentitud.
const timeoutMs = Number(flag('--timeout', 600)) * 1000
const gpuLayers = flag('--gpu-layers', null)
const prompt = flag('--prompt', 'Explica en dos frases que es una red peer-to-peer.')

const hostTarget = `${os.platform()}-${os.arch()}`
const defaultBin = path.join(root, 'out', hostTarget, isWindows ? 'qvac-node.exe' : 'qvac-node')
const bin = flag('--bin', defaultBin)

if (!fs.existsSync(bin)) {
  console.error(`No existe el binario: ${bin}`)
  console.error('Compilalo con `npm run make`, o pasa --bin <ruta>.')
  process.exit(1)
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`
}

// --- una corrida del CLI -----------------------------------------------------

// La salida del hijo va a un ARCHIVO, no a un pipe, y no es un detalle de
// estilo: con `stdio: 'pipe'` el binario se cuelga para siempre.
//
// Medido: el CLI carga el modelo, imprime el banner y el prompt, y despues no
// emite un solo token. Nunca. Depende de que le toca a stdout:
//
//   consola (inherit)        -> OK, ~12s
//   archivo (fd)             -> OK, ~16s
//   pipe de libuv (spawn)    -> COLGADO, infinito
//   pipe de shell (bash, PS) -> OK
//
// libuv usa named pipes para el stdio de los hijos en Windows, y ahi es donde
// se traba; los pipes anonimos de un shell andan bien. Detalle en NOTES.md.
// Si alguien "limpia" esto volviendolo a 'pipe', el soak da 100% de cuelgues.
function runPrompt(n) {
  return new Promise((resolve) => {
    const args = ['prompt', prompt]
    if (gpuLayers !== null) args.push('--gpu-layers', gpuLayers)

    const outPath = path.join(os.tmpdir(), `qvac-soak-out-${process.pid}-${n}.txt`)
    const fd = fs.openSync(outPath, 'w')

    const t0 = Date.now()
    const child = spawn(bin, args, { cwd: root, stdio: ['ignore', fd, fd] })

    let killed = false
    const readOut = () => {
      try {
        return fs.readFileSync(outPath, 'utf8')
      } catch {
        return ''
      }
    }
    const cleanup = () => {
      try {
        fs.closeSync(fd)
      } catch {
        /* ya cerrado */
      }
      fs.rmSync(outPath, { force: true })
    }

    // El timeout es el corazon del soak: sin esto un cuelgue queda como una
    // corrida "lenta" y el modo de falla numero 1 pasa desapercibido.
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (e) => {
      clearTimeout(timer)
      cleanup()
      resolve({ ok: false, why: `no se pudo lanzar: ${e.message}`, wallMs: Date.now() - t0 })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const wallMs = Date.now() - t0
      const out = readOut()
      cleanup()

      if (killed) {
        return resolve({
          ok: false,
          why: `COLGADO: no termino en ${timeoutMs / 1000}s, hubo que matarlo`,
          wallMs
        })
      }
      if (code !== 0) {
        const last = out.trim().split('\n').slice(-1)[0] || ''
        return resolve({ ok: false, why: `exit ${code}: ${last}`, wallMs })
      }

      const ttft = /primer token \(TTFT\)\s*:\s*([\d.]+)s/.exec(out)
      const load = /carga del modelo\s*:\s*([\d.]+)s/.exec(out)
      const total = /respuesta completa\s*:\s*([\d.]+)s/.exec(out)

      // Un exit 0 no alcanza: el CLI podria haber salido sin emitir un token.
      if (!ttft) {
        return resolve({ ok: false, why: 'exit 0 pero no hubo primer token', wallMs })
      }

      const answer = answerOf(out)
      if (answer.length < 20) {
        return resolve({
          ok: false,
          why: `respuesta sospechosamente corta (${answer.length} chars)`,
          wallMs
        })
      }

      resolve({
        ok: true,
        wallMs,
        loadS: load ? Number(load[1]) : null,
        ttftS: Number(ttft[1]),
        totalS: total ? Number(total[1]) : null,
        chars: answer.length
      })
    })
  })
}

// El texto de la respuesta esta entre la linea `> <prompt>` y el bloque de
// mediciones. Se extrae para poder afirmar que de verdad hubo respuesta.
function answerOf(out) {
  const lines = out.split('\n')
  const start = lines.findIndex((l) => l.startsWith('> '))
  const end = lines.findIndex((l) => /carga del modelo\s*:/.test(l))
  if (start === -1 || end === -1 || end <= start) return ''
  return lines
    .slice(start + 1, end)
    .join(' ')
    .trim()
}

// --- una corrida de `pear install` -------------------------------------------

function runInstall(n) {
  const target = path.join(os.tmpdir(), `qvac-soak-${process.pid}-${n}`)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true }) // `pear install --to` da ENOENT si no existe

  const t0 = Date.now()
  // Con `shell: true` hay que pasar UN comando armado, no comando + args:
  // Node >=22 avisa con DEP0190 porque con shell los args no se escapan.
  const res = isWindows
    ? spawnSync(`pear install --to "${target}" ${pkg.upgrade}`, {
        cwd: root,
        encoding: 'utf8',
        shell: true,
        timeout: timeoutMs
      })
    : spawnSync('pear', ['install', '--to', target, pkg.upgrade], {
        cwd: root,
        encoding: 'utf8',
        timeout: timeoutMs
      })
  const wallMs = Date.now() - t0
  const installed = path.join(target, isWindows ? 'qvac-node.exe' : 'qvac-node')

  // Ni el exit code ni que el archivo exista alcanzan: medido en macOS,
  // `pear install` imprime "Network Timeout 30s" y "Failed", sale con codigo
  // 0, y deja un binario TRUNCADO pero ejecutable en disco. La unica prueba
  // de que el install sirve es que el binario arranque.
  const out = `${res.stdout || ''}${res.stderr || ''}`
  let result
  if (res.error && res.error.code === 'ETIMEDOUT') {
    result = { ok: false, why: `COLGADO: el install no termino en ${timeoutMs / 1000}s`, wallMs }
  } else if (res.status !== 0) {
    result = { ok: false, why: `pear install exit ${res.status}`, wallMs }
  } else if (/network timeout|failed/i.test(out)) {
    result = { ok: false, why: `el install reporto fallo: ${firstBadLine(out)}`, wallMs }
  } else if (!fs.existsSync(installed)) {
    result = { ok: false, why: 'el install dijo OK pero el binario no quedo en disco', wallMs }
  } else {
    const mb = fs.statSync(installed).size / 1e6
    const ver = spawnSync(installed, ['--version'], { encoding: 'utf8', timeout: 60000 })
    if (!/v\d+\.\d+\.\d+/.test(`${ver.stdout || ''}`)) {
      result = {
        ok: false,
        why: `el binario quedo en disco (${mb.toFixed(1)} MB) pero NO corre: install incompleto`,
        wallMs
      }
    } else {
      result = { ok: true, wallMs, mb }
    }
  }

  fs.rmSync(target, { recursive: true, force: true })
  return result
}

function firstBadLine(out) {
  const line = out.split(/\r?\n/).find((l) => /network timeout|failed/i.test(l))
  return (line || '').trim().slice(0, 80)
}

// --- reporte -----------------------------------------------------------------

function stats(values) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return { min: s[0], med: p(0.5), max: s[s.length - 1] }
}

function fmt(st, unit = 's') {
  if (!st) return 'n/d'
  const r = (v) => v.toFixed(2)
  return `min ${r(st.min)}${unit}  mediana ${r(st.med)}${unit}  max ${r(st.max)}${unit}`
}

async function main() {
  console.log('')
  console.log(C.cyan(`== soak qvac-node v${pkg.version}`))
  console.log(`   binario   : ${bin}`)
  console.log(`   corridas  : ${runs}`)
  console.log(`   timeout   : ${timeoutMs / 1000}s por corrida`)
  if (gpuLayers !== null) console.log(`   gpu-layers: ${gpuLayers}`)
  if (doInstall) console.log(`   install   : SI (${pkg.upgrade})`)
  console.log('')

  const promptResults = []
  const installResults = []

  for (let i = 1; i <= runs; i++) {
    if (doInstall) {
      process.stdout.write(C.dim(`  [${i}/${runs}] pear install ... `))
      const r = runInstall(i)
      installResults.push(r)
      console.log(
        r.ok
          ? C.green(`OK ${(r.wallMs / 1000).toFixed(1)}s  ${r.mb.toFixed(1)} MB`)
          : C.red(`FALLA ${r.why}`)
      )
    }

    process.stdout.write(C.dim(`  [${i}/${runs}] prompt ......... `))
    const r = await runPrompt(i)
    promptResults.push(r)
    console.log(
      r.ok
        ? C.green(
            `OK  TTFT ${r.ttftS.toFixed(2)}s  total ${r.totalS?.toFixed(1)}s  ${r.chars} chars`
          )
        : C.red(`FALLA ${r.why}`)
    )
  }

  const okPrompts = promptResults.filter((r) => r.ok)
  const okInstalls = installResults.filter((r) => r.ok)

  console.log('')
  console.log(C.cyan('== resultado'))

  if (doInstall) {
    console.log(`   install : ${okInstalls.length}/${installResults.length} OK`)
    console.log(`             ${fmt(stats(okInstalls.map((r) => r.wallMs / 1000)))}`)
  }

  console.log(`   prompt  : ${okPrompts.length}/${promptResults.length} OK`)
  console.log(`     carga : ${fmt(stats(okPrompts.map((r) => r.loadS).filter(Number.isFinite)))}`)
  console.log(`     TTFT  : ${fmt(stats(okPrompts.map((r) => r.ttftS)))}`)
  console.log(`     total : ${fmt(stats(okPrompts.map((r) => r.totalS).filter(Number.isFinite)))}`)

  const fails = [...promptResults, ...installResults].filter((r) => !r.ok)
  if (fails.length > 0) {
    console.log('')
    console.log(C.red(`   ${fails.length} falla(s):`))
    for (const f of fails) console.log(C.red(`     - ${f.why}`))
  }

  // La dispersion importa tanto como la mediana: un TTFT que va de 0.6s a 6s
  // es una demo que a veces se ve mal, aunque la mediana sea buena.
  const t = stats(okPrompts.map((r) => r.ttftS))
  if (t && t.max > t.med * 3 && okPrompts.length > 2) {
    console.log('')
    console.log(
      C.yellow(
        `   OJO: el TTFT max (${t.max.toFixed(2)}s) es 3x la mediana (${t.med.toFixed(2)}s).`
      )
    )
    console.log(C.yellow('   Hay varianza que en vivo se puede ver. Corre mas vueltas.'))
  }

  console.log('')
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
