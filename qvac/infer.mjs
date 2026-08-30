// Inference test bench: compares models and measures load / TTFT / total.
//
//   ./node_modules/.bin/bare qvac/infer.mjs --download
//   ./node_modules/.bin/bare qvac/infer.mjs --model smol --download
//
// This is the tool that was used to pick the default model (see NOTES.md,
// "Eleccion de modelo"). To USE the node there's `qvac-node prompt "..."`,
// which runs on the same `engine.mjs`; this stays around as a measurement
// harness.
//
// The download is OPT-IN via --download on purpose, the opposite of the CLI:
// here the point is to measure, and downloading 800 MB by accident ruins the
// measurement.

import bareProcess from 'bare-process'
import * as engine from './engine.mjs'

// NOTE: kept in Spanish on purpose — this is the fixed benchmark prompt reused
// verbatim across docs/NOTES.md, scripts/verify-node2.sh/.ps1 and
// scripts/soak.js; translating it here alone would break that consistency and
// change what's actually being measured.
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
    `[qvac] model: ${name}  ${entry.params}  ${mb} MB  (${cached ? 'cached' : 'missing'})`
  )
  if (gpuLayers !== undefined) console.log(`[qvac] gpu_layers: ${gpuLayers}`)

  if (!cached && !allowDownload) {
    console.log('\n[qvac] without --download nothing gets downloaded. Run again with:')
    console.log('       bare qvac/infer.mjs --download\n')
    await engine.shutdown(null)
    Bare.exit(0)
  }

  let lastPct = -1
  console.log('[qvac] loading (first time downloads)...')
  modelId = await engine.loadModel({
    modelSrc,
    gpuLayers,
    onProgress: (p) => {
      if (cached) return // with the model cached the SDK still emits progress
      const pct = Math.floor((p && (p.progress ?? p.percent ?? 0)) * 100)
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct
        console.log(`[qvac] download ${pct}%`)
      }
    }
  })

  const tLoaded = Date.now()
  console.log(`[qvac] model ready in ${((tLoaded - t0) / 1000).toFixed(1)}s -> ${modelId}`)
  console.log(`\n> ${PROMPT}\n`)

  let firstTokenAt = null
  for await (const delta of engine.complete({ modelId, prompt: PROMPT })) {
    if (firstTokenAt === null) firstTokenAt = Date.now()
    bareProcess.stdout.write(delta)
  }

  const tEnd = Date.now()
  console.log('\n')
  console.log('=== MEASUREMENTS ===')
  console.log(`model load           : ${((tLoaded - t0) / 1000).toFixed(1)}s`)
  console.log(
    `first token (TTFT)   : ${firstTokenAt ? ((firstTokenAt - tLoaded) / 1000).toFixed(2) + 's' : 'n/a'}`
  )
  console.log(`total response time  : ${((tEnd - tLoaded) / 1000).toFixed(1)}s`)
} catch (err) {
  console.error('\n[qvac] FAILED:', err && err.message)
  console.error(err)
  Bare.exitCode = 1
} finally {
  await engine.shutdown(modelId)
}
