#!/usr/bin/env node
'use strict'

// Resuelve el grafo de modulos como lo hace el packer, y CORTA si algo no
// resuelve. No arma el binario: eso tarda minutos y necesita el toolchain de la
// plataforma. Esto tarda segundos y caza el 100% de los errores de resolucion,
// que es lo unico que `npm test` estructuralmente no puede ver.
//
// -----------------------------------------------------------------------------
// POR QUE EXISTE
//
// `npm test` corre bajo `bare` DESDE FUENTE, con node_modules al lado. El
// binario standalone es otro entorno: `bare-pack` recorre el grafo estatico y
// resuelve con condiciones distintas de las del runtime. Un import que anda al
// ejecutar puede no resolver al empaquetar.
//
// Eso paso de verdad: `@noble/hashes` eligio su variante `node:crypto` en el
// packer y el binario dejo de compilar. Entro con la Fase 7 y se descubrio
// cinco fases despues, porque nadie compilo en el medio. El unico canal de
// distribucion que el README declara estuvo roto todo ese tiempo con la suite
// en verde.
//
//   node scripts/humo-build.js

const path = require('path')
const { pathToFileURL } = require('url')
const pack = require('bare-pack')
const traverse = require('bare-module-traverse')
const { readModule, listPrefix } = require('bare-pack/fs')

const root = path.resolve(__dirname, '..')
const entry = path.join(root, 'bin.mjs')

// Los mismos hosts que arma el release, para que un import condicionado por
// plataforma que solo falla en macOS no pase inadvertido en Windows.
const hosts = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

async function main() {
  const t = Date.now()
  try {
    const bundle = await pack(
      pathToFileURL(entry),
      // `linked: false` es lo que usa `--standalone`, que es como se
      // distribuye. Con `true` el grafo es mas chico y el chequeo valdria menos.
      { hosts, linked: false, resolve: traverse.resolve.bare },
      readModule,
      listPrefix
    )
    const n = Object.keys(bundle.files || {}).length
    console.log(`[humo] el grafo resuelve: ${n} modulos, ${Date.now() - t}ms`)
  } catch (err) {
    console.error('[humo] EL BINARIO NO VA A COMPILAR.')
    console.error('')
    console.error(`  ${(err && err.message) || err}`)
    if (err && err.referrer)
      console.error(`  importado desde: ${err.referrer.href || err.referrer}`)
    console.error('')
    console.error('  Esto NO lo ve `npm test`: la suite corre desde fuente, donde el')
    console.error('  runtime resuelve distinto que el packer. Ver scripts/humo-build.js')
    process.exit(1)
  }
}

main()
