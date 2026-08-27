#!/usr/bin/env node
'use strict'

// Pipeline de release de QVAC-Node, en un comando.
//
// Existe porque el OTA en vivo es parte del pitch: durante la demo hay que
// publicar una version nueva y que el jurado vea actualizarse la copia que ya
// tiene instalada. Encadenar make -> build -> stage a mano en el escenario es
// una forma barata de romper la demo.
//
//   node scripts/release.js            todas las plataformas
//   node scripts/release.js --host     solo la plataforma local (rapido, para iterar)

const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))

// win32-arm64 se saco al meter la inferencia: @qvac/llm-llamacpp no publica
// prebuild para esa plataforma y `bare-build` no tiene con que linkear el
// addon. Hasta Fase 0 se publicaba; el primer `release` completo despues de
// este cambio lo purga del hypercore. Ver NOTES.md.
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

const hostOnly = process.argv.includes('--host')
const host = `${os.platform()}-${os.arch()}`
const targets = hostOnly ? [host] : TARGETS

// El smoke corre el binario del host antes de publicar. Se puede saltear, pero
// tiene que ser una decision explicita: el default es que un artefacto roto no
// llegue al hypercore. Ver el paso 1-bis y scripts/smoke.js.
const skipSmoke = process.argv.includes('--skip-smoke')

if (hostOnly && !TARGETS.includes(host)) {
  console.error(`Plataforma no soportada: ${host}`)
  process.exit(1)
}

const link = pkg.upgrade
if (!link || link.includes('YOUR_KEY')) {
  console.error('package.json: el campo "upgrade" sigue con el placeholder.')
  console.error('Corre `pear touch` y pega el link resultante ahi.')
  console.error('Sin esto la app instalada arranca con INVALID_URL.')
  process.exit(1)
}

const isWindows = os.platform() === 'win32'
const run = (cmd, args) => {
  const res = spawnSync(isWindows ? `${cmd} ${args.join(' ')}` : cmd, isWindows ? [] : args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows
  })
  if (res.error) {
    console.error(res.error.message)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status || 1)
}

console.log(`\n== qvac-node v${pkg.version} -> ${link}\n`)

// 1. binarios standalone (bare-build cross-compila los 6 targets desde cualquier host)
for (const t of targets) {
  console.log(`-- build ${t}`)
  run(isWindows ? 'npm.cmd' : 'npm', ['run', `make:${t}`])
}

// 1-bis. El binario del host tiene que servir un token ANTES de publicarse.
//
// Compilar no es funcionar: `linux-x64` se publico release tras release sin
// poder cargar un modelo, y nadie lo noto porque este script nunca ejecuto lo
// que estaba subiendo. Ver NOTES.md, "Nodo Linux 24/7".
//
// LO QUE ESTE GATE NO CUBRE, y hay que decirlo: solo prueba el target del host.
// Los otros cuatro son cross-compilados y no corren aca. Para cubrirlos hace
// falta una matriz de CI, o correr `npm run smoke -- --bin <ruta>` a mano en
// cada plataforma antes de publicar.
if (skipSmoke) {
  console.log('\n!! smoke SALTEADO por --skip-smoke: se publica sin verificar el binario.')
} else if (!targets.includes(host)) {
  console.log(`\n!! el host (${host}) no esta entre los targets: no hay binario que probar aca.`)
} else {
  console.log(`\n-- smoke ${host}`)
  const bin = path.join(root, 'out', host, isWindows ? 'pyrusllm.exe' : 'pyrusllm')
  run('node', ['scripts/smoke.js', '--bin', bin, '--gpu-layers', '0'])
}

// 2. carpeta de deployment: pear install busca /by-arch/<plataforma>/app/<bin>
const buildArgs = ['build', '--package', './package.json', '--target', './build']
for (const t of targets) {
  const bin = t.startsWith('win32') ? 'pyrusllm.exe' : 'pyrusllm'
  buildArgs.push(`--${t}-app`, `./out/${t}/${bin}`)
}
console.log('\n-- pear build')
run('pear', buildArgs)

// 3. stage.
// --purge solo en el release completo: borra de los hypercores lo que ya no
// corresponde, para que material viejo no quede replicandose para siempre.
// En --host se stagea UNA sola plataforma, y purgar ahi borraria del hypercore
// los binarios de las otras cinco: un jurado en macOS recibiria "Not found" en
// vez de la app. El modo host es para iterar; el completo es el que limpia.
console.log('\n-- pear stage')
const stageArgs = ['stage']
if (!hostOnly) stageArgs.push('--purge')
stageArgs.push(link, './build')
run('pear', stageArgs)

if (hostOnly) {
  console.log(`\n!! modo --host: solo se publico ${host}.`)
  console.log('!! Antes de la demo corre `npm run release` (las 6 plataformas).')
}

console.log(`\n== listo. Seedea con:  pear seed ${link}\n`)
