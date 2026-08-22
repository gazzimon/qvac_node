// Sonda de Fase 1: registra el plugin de llamacpp y pregunta al registry de
// QVAC que modelos ofrece. Sirve para elegir uno <=1B sin inventar una URL.
//
//   ./node_modules/.bin/bare qvac/probe-registry.mjs

import bareProcess from 'bare-process'

// En Bare no existe el global `process` y el SDK lo espera. Esta linea va
// ANTES de importar el SDK: si se importa primero, el modulo ya evaluo sus
// referencias al global y falla con errores poco descriptivos.
if (!global.process) global.process = bareProcess

const { plugins, modelRegistrySearch, close } = await import('@qvac/bare-sdk')
const { llmPlugin } = await import('@qvac/bare-sdk/llamacpp-completion/plugin')

// En bare-sdk NADA se auto-registra: sin esto, cualquier llamada tira
// WorkerPluginsNotRegisteredError.
plugins([llmPlugin])

console.log('plugin registrado:', llmPlugin.modelType, '->', llmPlugin.addonPackage)
console.log('consultando el registry...\n')

try {
  const entries = await modelRegistrySearch({ engine: 'llamacpp-completion' })
  console.log('modelos encontrados:', entries.length, '\n')
  for (const e of entries.slice(0, 40)) {
    console.log(JSON.stringify(e))
  }
} catch (err) {
  console.error('FALLO la consulta al registry:', err && err.message)
  console.error(err)
} finally {
  await close().catch(() => {})
}
