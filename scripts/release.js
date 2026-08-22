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

const TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
]

const hostOnly = process.argv.includes('--host')
const host = `${os.platform()}-${os.arch()}`
const targets = hostOnly ? [host] : TARGETS

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

// 2. carpeta de deployment: pear install busca /by-arch/<plataforma>/app/<bin>
const buildArgs = ['build', '--package', './package.json', '--target', './build']
for (const t of targets) {
  const bin = t.startsWith('win32') ? 'qvac-node.exe' : 'qvac-node'
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
