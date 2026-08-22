// Prueba de inferencia local de Fase 1: carga un modelo <=1B y responde un
// prompt, todo adentro de Bare.
//
//   ./node_modules/.bin/bare qvac/infer.mjs --download
//
// La descarga del modelo es OPT-IN con --download a proposito. Invariante del
// runbook: el jurado nunca descarga un modelo, y el gateway tiene que arrancar
// con cero modelos en disco. Que bajar pesos sea un acto explicito, y no un
// efecto secundario de arrancar, es parte del diseño.

import bareProcess from 'bare-process'

// Bare no define el global `process` y el SDK lo espera. Va ANTES de importar
// el SDK: si se importa primero, el modulo ya evaluo sus referencias al global
// y falla con errores poco descriptivos.
if (!global.process) global.process = bareProcess

const MODEL = 'smollm2-360m-instruct-q8_0' // 360M, 386MB
const PROMPT = 'Respondé en una sola frase: ¿qué es una red peer-to-peer?'

const argv = Bare.argv.slice(2)
const allowDownload = argv.includes('--download')

const sdk = await import('@qvac/bare-sdk')
const { llmPlugin } = await import('@qvac/bare-sdk/llamacpp-completion/plugin')

// En bare-sdk nada se auto-registra: sin esta linea cualquier llamada tira
// WorkerPluginsNotRegisteredError.
sdk.plugins([llmPlugin])
console.log('[qvac] plugin registrado:', llmPlugin.modelType)

let modelId = null
const t0 = Date.now()

try {
  const found = await sdk.modelRegistrySearch({ filter: MODEL })
  const entry = found.find((e) => e.name === MODEL)
  if (!entry) throw new Error(`no se encontro ${MODEL} en el registry`)

  const mb = (entry.expectedSize / 1e6).toFixed(0)
  console.log(`[qvac] modelo: ${entry.name}  ${entry.params}  ${mb} MB`)

  // Una entrada del registry NO es un modelSrc valido tal cual: el schema exige
  // un campo `src` que la entrada no trae, y sin el falla con
  // REQUEST_VALIDATION_FAILED "Invalid input at modelSrc". El esquema
  // `registry://` es el que baja los pesos por hypercore en vez de HTTP.
  // (mismo patron que usan los descriptores predefinidos del SDK en
  //  dist/_sdk/models/registry/index.js)
  const modelSrc = {
    ...entry,
    src: `registry://${entry.registrySource}/${entry.registryPath}`
  }

  if (!allowDownload) {
    console.log('\n[qvac] sin --download no se baja nada. Volve a correr con:')
    console.log('       bare qvac/infer.mjs --download\n')
    await sdk.close().catch(() => {})
    Bare.exit(0)
  }

  let lastPct = -1
  console.log('[qvac] cargando (la primera vez descarga)...')
  modelId = await sdk.loadModel({
    modelSrc,
    modelConfig: { ctx_size: 2048 },
    onProgress: (p) => {
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

  const run = sdk.completion({
    modelId,
    history: [{ role: 'user', content: PROMPT }],
    stream: true
  })

  let firstTokenAt = null
  for await (const ev of run.events) {
    if (ev.type === 'contentDelta') {
      if (firstTokenAt === null) firstTokenAt = Date.now()
      bareProcess.stdout.write(ev.text)
    }
  }
  await run.final

  const tEnd = Date.now()
  console.log('\n')
  console.log('=== MEDICIONES ===')
  console.log(`carga del modelo    : ${((tLoaded - t0) / 1000).toFixed(1)}s`)
  console.log(`primer token (TTFT) : ${firstTokenAt ? ((firstTokenAt - tLoaded) / 1000).toFixed(2) + 's' : 'n/d'}`)
  console.log(`total de la respuesta: ${((tEnd - tLoaded) / 1000).toFixed(1)}s`)
} catch (err) {
  console.error('\n[qvac] FALLO:', err && err.message)
  console.error(err)
  Bare.exitCode = 1
} finally {
  if (modelId) await sdk.unloadModel({ modelId }).catch(() => {})
  await sdk.close().catch(() => {})
}
