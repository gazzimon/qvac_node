#!/usr/bin/env node
'use strict'

// Le agrega a `@noble/hashes` una condición `bare` en su export `./crypto`.
//
// -----------------------------------------------------------------------------
// POR QUE HACE FALTA
//
// `bare-pack` --el que arma el binario standalone-- resuelve el grafo de módulos
// con estas condiciones (bare-module-traverse/lib/resolve/bare.js):
//
//     ['bare', 'node', <platform>, <arch>]
//
// Incluye `node` a propósito: casi todo el ecosistema publica código compatible
// con Node, y Bare lo es en su mayor parte. Pero `@noble/hashes@1.x` usa esa
// condición justamente para elegir la variante que NO sirve:
//
//     "./crypto": {
//       "node":   { "import": "./esm/cryptoNode.js" },   <- importa node:crypto
//       "import": "./esm/crypto.js"                      <- WebCrypto, sí sirve
//     }
//
// y `node:crypto` no existe bajo Bare. Resultado: el binario no compila.
//
//     MODULE_NOT_FOUND: node:crypto
//       desde @noble/hashes/esm/cryptoNode.js
//
// Y no es un problema de x402: la cadena arranca en `qvac/wallet.mjs`, que
// importa `@scure/bip39` -> `@noble/hashes/utils.js` -> `@noble/hashes/crypto`.
// Está roto desde la Fase 7; no se vio antes porque `npm test` corre desde
// fuente, donde el runtime de Bare resuelve distinto que el packer.
//
// -----------------------------------------------------------------------------
// POR QUE ASI Y NO DE OTRA FORMA
//
// `bare` se evalúa ANTES que `node`, así que alcanza con declararla. El parche
// es UNA clave en un mapa de exports: no toca una línea de código criptográfico.
//
// Lo demás se probó y no sirve:
//
//   - forzar `@noble/hashes@2.x` con overrides: la 2.x no tiene el export
//     condicional, pero sacó los subpaths sin extensión y rompe a viem, ethers
//     y curves con `PACKAGE_PATH_NOT_EXPORTED: './sha3'`;
//   - `bare-pack --imports` es el lever correcto, pero `bare-build` llama a
//     `pack()` con opciones literales y no lo reenvía (bare-build 1.0.4, que es
//     la última);
//   - `--builtins` no ayuda: la lista del packer no tiene ningún `node:`.
//
// El arreglo de verdad es upstream --que `bare-build` reenvíe opciones al
// packer, o que `@noble/hashes` declare la condición-- y esto se saca el día que
// pase.
//
// -----------------------------------------------------------------------------
// FALLA RUIDOSO
//
// Si el mapa de exports cambia de forma, este script CORTA con exit 1 en vez de
// parchar a ciegas: un parche que se aplica mal sobre una librería de cripto es
// peor que uno que no se aplica. El build se rompería igual, pero acá el error
// dice qué pasó.

const fs = require('fs')
const path = require('path')

// De donde salen las copias de @noble/hashes a parchar. Depende de como se
// instalo el paquete:
//   - checkout del repo, o `npm i -g pyrusllm`: las deps cuelgan de
//     <paquete>/node_modules, asi que alcanza con `../node_modules`.
//   - `pyrusllm` como dependencia de otro proyecto: npm iza @noble/hashes al
//     node_modules del consumidor -- un ANCESTRO de este archivo, no un hijo
//     del paquete. Sin mirar ahi, el postinstall no encuentra ninguna copia y
//     el stack x402 revienta bajo Bare con `MODULE_NOT_FOUND: node:crypto`.
function raicesNodeModules() {
  const raices = new Set([path.resolve(__dirname, '..', 'node_modules')])
  let dir = __dirname
  let padre = path.dirname(dir)
  while (padre !== dir) {
    if (path.basename(dir) === 'node_modules') raices.add(dir)
    dir = padre
    padre = path.dirname(dir)
  }
  return [...raices].filter((d) => fs.existsSync(d))
}

// Todas las copias: el árbol tiene una por dependencia que la pinea distinto
// (viem, ox, ethers, curves, bip32, wdk...), y el packer puede llegar a
// cualquiera. Parchar sólo la de la raíz deja el build roto según cómo npm haya
// acomodado el árbol ese día.
function copias(dir, encontradas = []) {
  let entradas
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return encontradas
  }
  for (const e of entradas) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (e.name === 'hashes' && path.basename(dir) === '@noble') {
      encontradas.push(p)
      continue
    }
    if (
      e.name === 'node_modules' ||
      e.name.startsWith('@') ||
      fs.existsSync(path.join(p, 'node_modules'))
    ) {
      copias(p, encontradas)
    }
  }
  return encontradas
}

let parchadas = 0
let yaEstaban = 0
const problemas = []

const copiasEncontradas = new Set()
for (const raiz of raicesNodeModules()) {
  for (const c of copias(raiz)) copiasEncontradas.add(c)
}

for (const dir of copiasEncontradas) {
  const archivo = path.join(dir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(archivo, 'utf8'))
  } catch (err) {
    problemas.push(`${archivo}: ilegible (${err.message})`)
    continue
  }

  const crypto = pkg.exports && pkg.exports['./crypto']
  // La 2.x no tiene este export y no necesita nada. No es un error.
  if (!crypto || typeof crypto !== 'object') continue
  if (crypto.bare) {
    yaEstaban++
    continue
  }
  if (!crypto.node) continue

  // La rama que NO es de node es la que sirve bajo Bare. Se toma del propio
  // mapa en vez de escribirla acá: si upstream renombra el archivo, esto sigue
  // apuntando a donde tiene que apuntar.
  const seguro = {}
  if (typeof crypto.import === 'string') seguro.import = crypto.import
  if (typeof crypto.default === 'string') seguro.default = crypto.default

  if (!seguro.import && !seguro.default) {
    problemas.push(
      `${dir}: el export "./crypto" no tiene una rama sin condicion \`node\` de donde sacar el archivo. ` +
        `Forma encontrada: ${JSON.stringify(crypto)}`
    )
    continue
  }

  // `bare` PRIMERO: el orden del objeto es el orden en que se evaluan las
  // condiciones, y la gracia es ganarle a `node`.
  pkg.exports['./crypto'] = { bare: seguro, ...crypto }
  fs.writeFileSync(archivo, JSON.stringify(pkg, null, 2) + '\n')
  parchadas++
}

if (problemas.length) {
  console.error('[parche-noble] la forma del package.json cambio y no se parcha a ciegas:')
  for (const p of problemas) console.error('  ' + p)
  console.error('[parche-noble] ver scripts/parche-noble-bare.js')
  process.exit(1)
}

if (parchadas > 0) {
  console.log(`[parche-noble] condicion \`bare\` agregada a ${parchadas} copia(s) de @noble/hashes`)
} else if (yaEstaban > 0) {
  console.log(`[parche-noble] ${yaEstaban} copia(s) ya parchadas`)
}
