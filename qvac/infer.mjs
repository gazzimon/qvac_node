// Banco de pruebas de inferencia: compara modelos y mide carga / TTFT / total.
//
//   ./node_modules/.bin/bare qvac/infer.mjs --download
//   ./node_modules/.bin/bare qvac/infer.mjs --model smol --download
//
// Es la herramienta con la que se eligio el modelo default (ver NOTES.md,
// "Eleccion de modelo"). Para USAR el nodo esta `qvac-node prompt "..."`, que
// corre sobre el mismo `engine.mjs`; esto queda como harness de medicion.
//
// La descarga es OPT-IN con --download a proposito, al reves que en el CLI:
// aca el punto es medir, y bajar 800 MB sin querer arruina la medicion.

import bareProcess from 'bare-process'
import * as engine from './engine.mjs'

const PROMPT = 'Respondé en una sola frase: ¿qué es una red peer-to-peer?'

const argv = Bare.argv.slice(2)
const allowDownload = argv.includes('--download')

const mi = argv.indexOf('--model')
const pick = mi !== -1 ? argv[mi + 1] : engine.DEFAULT_MODEL

const gi = argv.indexOf('--gpu-layers')
const gpuLayers = gi !== -1 ? Number(argv[gi + 1]) : undefined

let modelId = null
const t0 = Date.now()

try {
  const { entry, name, cached, modelSrc } = await engine.resolveModel(pick)
  const mb = (entry.expectedSize / 1e6).toFixed(0)
  console.log(
    `[qvac] modelo: ${name}  ${entry.params}  ${mb} MB  (${cached ? 'cacheado' : 'falta'})`
  )
  if (gpuLayers !== undefined) console.log(`[qvac] gpu_layers: ${gpuLayers}`)

  if (!cached && !allowDownload) {
    console.log('\n[qvac] sin --download no se baja nada. Volve a correr con:')
    console.log('       bare qvac/infer.mjs --download\n')
    await engine.shutdown(null)
    Bare.exit(0)
  }

  let lastPct = -1
  console.log('[qvac] cargando (la primera vez descarga)...')
  modelId = await engine.loadModel({
    modelSrc,
    gpuLayers,
    onProgress: (p) => {
      if (cached) return // con el modelo en cache el SDK igual emite progreso
      const pct = Math.floor((p && (p.progress ?? p.percent ?? 0)) * 100)
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct
        console.log(`[qvac] descarga ${pct}%`)
      }
    }
  })

  const tLoaded = Date.now()
  console.log(`[qvac] modelo listo en ${((tLoaded - t0) / 1000).toFixed(1)}s -> ${modelId}`)
  console.log(`\n> ${PROMPT}\n`)

  let firstTokenAt = null
  for await (const delta of engine.complete({ modelId, prompt: PROMPT })) {
    if (firstTokenAt === null) firstTokenAt = Date.now()
    bareProcess.stdout.write(delta)
  }

  const tEnd = Date.now()
  console.log('\n')
  console.log('=== MEDICIONES ===')
  console.log(`carga del modelo    : ${((tLoaded - t0) / 1000).toFixed(1)}s`)
  console.log(
    `primer token (TTFT) : ${firstTokenAt ? ((firstTokenAt - tLoaded) / 1000).toFixed(2) + 's' : 'n/d'}`
  )
  console.log(`total de la respuesta: ${((tEnd - tLoaded) / 1000).toFixed(1)}s`)
} catch (err) {
  console.error('\n[qvac] FALLO:', err && err.message)
  console.error(err)
  Bare.exitCode = 1
} finally {
  await engine.shutdown(modelId)
}
