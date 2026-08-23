#!/usr/bin/env node
//
// Lanzador para el canal npm. NO es el entrypoint del proyecto: ese es
// bin.mjs, y corre bajo Bare, no bajo Node.
//
// Existe porque `npm i -g pyrusllm` deja un ejecutable que arranca con
// Node, y bin.mjs importa `bare-storage`, `bare-process`, `bare-os` y
// `bare-path` -modulos del runtime Bare que Node no resuelve-. Publicar
// bin.mjs directo como "bin" daria un paquete que revienta en el primer
// import, que es peor que no publicar nada.
//
// Lo unico que hace este archivo es encontrar el binario de Bare y
// delegarle bin.mjs con los mismos argumentos. Toda la logica sigue del
// otro lado; aca no se decide nada.
//
// El binario no se descarga en runtime: `bare-runtime` declara un
// optionalDependency por plataforma (bare-runtime-<platform>-<arch>) y npm
// baja solo el que corresponde al instalar. Por eso alcanza con resolverlo.

const { spawn } = require('child_process')
const path = require('path')

let bare
try {
  // API publica de bare-runtime: devuelve la ruta al binario de esta
  // plataforma, o tira si no hay build para ella.
  bare = require('bare-runtime')('bare')
} catch (err) {
  // El caso real es win32-arm64, la misma plataforma que tampoco se publica
  // por Pear porque @qvac/llm-llamacpp no tiene prebuild ahi. Se dice cual
  // es el problema en vez de dejar el stack trace de un require.
  console.error('[pyrusllm] no hay binario de Bare para esta plataforma:', err.message)
  console.error('[pyrusllm] instalacion alternativa por P2P:')
  console.error(
    '[pyrusllm]   pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny'
  )
  process.exit(1)
}

// stdio heredado para que el streaming de tokens y `prompt -` (el prompt por
// stdin, que en Windows es la unica forma de pasar acentos) sigan andando sin
// que este proceso se meta en el medio.
const hijo = spawn(bare, [path.join(__dirname, 'bin.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit'
})

hijo.on('error', (err) => {
  console.error('[pyrusllm] no se pudo ejecutar Bare:', err.message)
  process.exit(1)
})

// Se propaga el codigo de salida porque `peers --expect` lo usa como gate en
// scripts: si el wrapper siempre saliera 0, ese chequeo dejaria de servir.
// Si Bare murio por una senal, se reporta como 128+n, que es la convencion
// que espera un shell.
hijo.on('exit', (code, signal) => {
  process.exit(signal ? 128 + (require('os').constants.signals[signal] || 0) : (code ?? 0))
})
