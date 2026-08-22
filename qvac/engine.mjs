// Motor de inferencia local de QVAC-Node.
//
// Concentra todo el trato con `@qvac/bare-sdk` en un solo lugar: el shim del
// global `process`, el registro explicito del plugin, la resolucion de un
// modelo del registry y el streaming de tokens. Lo usan el comando
// `qvac-node prompt` (Fase 1) y, mas adelante, `serve`/`gateway` (Fase 2).
//
// Este modulo se importa de forma DINAMICA desde bin.mjs a proposito: importar
// el plugin hace dlopen del addon de llamacpp (96 MB en win32-x64) en el acto,
// porque `@qvac/llm-llamacpp/addonLogging` hace `require.addon()` en el tope
// del modulo. Arrancar el nodo no tiene por que pagar eso.

import './global-process.mjs' // PRIMERO: ver el comentario de ese archivo
import bareProcess from 'bare-process'
import path from 'bare-path'
import fs from 'bare-fs'
import env from 'bare-env'
import * as sdk from '@qvac/bare-sdk'
import { llmPlugin } from '@qvac/bare-sdk/llamacpp-completion/plugin'
import { DEFAULT_MODEL, DEFAULT_CTX_SIZE, MODELS, resolveName } from './models.mjs'

export { MODELS, DEFAULT_MODEL, DEFAULT_CTX_SIZE, resolveName } from './models.mjs'

let registered = false

// En bare-sdk NADA se auto-registra: sin esto, cualquier llamada tira
// WorkerPluginsNotRegisteredError.
//
// El registro del SDK NO es idempotente: llamar dos veces tira
// PLUGIN_ALREADY_REGISTERED. La bandera local no alcanza, porque el registry
// del SDK es del proceso entero y hay mas de un camino que registra: el entry
// de Pear (qvac/worker.pear.entry.mjs) hace `registerPlugin(llmPlugin)` ANTES
// de importar bin.mjs. Por eso se traga ese error especifico —y solo ese—:
// significa que el plugin ya esta, que es exactamente lo que queriamos.
function register() {
  if (registered) return
  try {
    sdk.plugins([llmPlugin])
  } catch (err) {
    if (err?.name !== 'PLUGIN_ALREADY_REGISTERED') throw err
  }
  registered = true
}

// Donde el SDK guarda los pesos. No lo exporta, asi que se replica el calculo
// de `getQvacPath('models')` (server/utils/qvac-paths.js + server/env.js).
// Solo se usa para INFORMAR y para detectar cache; nada depende de acertarle.
export function modelsDir() {
  const home = env['SNAP_USER_COMMON'] ?? env['HOME'] ?? env['USERPROFILE'] ?? '/tmp'
  return path.join(home, '.qvac', 'models')
}

// Los pesos se guardan como `<hash>_<nombre>.gguf`. El hash no se puede
// derivar desde aca, asi que se busca por sufijo.
export function isCached(modelName) {
  const dir = modelsDir()
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false // no existe el directorio todavia: no hay nada cacheado
  }
  return entries.some((f) => f.endsWith(`_${modelName}.gguf`))
}

// Devuelve la entrada del registry MAS un `modelSrc` usable.
//
// Una entrada del registry NO es un modelSrc valido tal cual: el schema exige
// un campo `src` que la entrada no trae, y sin el falla con
// REQUEST_VALIDATION_FAILED "Invalid input at modelSrc". El esquema
// `registry://` es el que baja los pesos por hypercore en vez de HTTP (mismo
// patron que los descriptores predefinidos en dist/_sdk/models/registry).
export async function resolveModel(pick = DEFAULT_MODEL) {
  register()
  const name = resolveName(pick)
  const found = await sdk.modelRegistrySearch({ filter: name })
  const entry = found.find((e) => e.name === name)
  if (!entry) {
    throw new Error(
      `no se encontro "${name}" en el registry de QVAC. Alias conocidos: ${Object.keys(MODELS).join(', ')}`
    )
  }
  return {
    entry,
    name,
    cached: isCached(name),
    modelSrc: { ...entry, src: `registry://${entry.registrySource}/${entry.registryPath}` }
  }
}

// `verbosity: 0` es ERROR: baja al minimo el logging del addon de llamacpp.
//
// OJO, no lo calla del todo: las dos lineas "parse: load the model metadata..."
// e "initFromConfig: ..." que salen al cargar son printf crudos de llama.cpp,
// anteriores al hook de logging, y NO se pueden apagar desde aca. Probado con
// setGlobalLogLevel('error') + setGlobalConsoleOutput(false) del SDK: siguen
// saliendo. Redirigir el fd 1 es la unica via y no vale la pena: se llevaria
// puesta la respuesta.
export function loadModel({
  modelSrc,
  ctxSize = DEFAULT_CTX_SIZE,
  gpuLayers,
  verbosity = 0,
  onProgress
}) {
  register()
  const modelConfig = { ctx_size: ctxSize, verbosity }
  // Solo se manda si lo pidieron: sin la clave, el SDK aplica sus device
  // defaults, que son los correctos en una maquina con GPU decente.
  if (Number.isFinite(gpuLayers)) modelConfig.gpu_layers = gpuLayers
  return sdk.loadModel({ modelSrc, modelConfig, onProgress })
}

// Stream de texto. Devuelve un async iterable de strings (los deltas), para no
// filtrar la forma de los eventos del SDK a los llamadores.
export async function* complete({ modelId, prompt, history }) {
  register()
  const run = sdk.completion({
    modelId,
    history: history || [{ role: 'user', content: prompt }],
    stream: true
  })
  for await (const ev of run.events) {
    if (ev.type === 'contentDelta') yield ev.text
  }
  await run.final
}

// `unloadModel` NO cierra las conexiones del SDK: el swarm, el cliente del
// registry y el corestore quedan arriba a proposito, para que un worker
// long-lived sobreviva ciclos de load/unload. Un CLI de un solo tiro necesita
// las dos cosas o el proceso no termina nunca.
export async function shutdown(modelId) {
  if (modelId) await sdk.unloadModel({ modelId }).catch(() => {})
  await sdk.close().catch(() => {})
}

export { bareProcess, sdk }
