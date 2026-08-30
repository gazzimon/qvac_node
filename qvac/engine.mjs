// QVAC-Node's local inference engine.
//
// Concentrates all dealings with `@qvac/bare-sdk` in one place: the global
// `process` shim, explicit plugin registration, resolving a model from the
// registry, and token streaming. Used by the `qvac-node prompt` command
// (Phase 1) and, later on, `serve`/`gateway` (Phase 2).
//
// This module is imported DYNAMICALLY from bin.mjs on purpose: importing the
// plugin does a dlopen of the llamacpp addon (96 MB on win32-x64) right then
// and there, because `@qvac/llm-llamacpp/addonLogging` does `require.addon()`
// at the top of the module. Starting the node shouldn't have to pay for that.

import './global-process.mjs' // FIRST: see that file's comment
import bareProcess from 'bare-process'
import path from 'bare-path'
import fs from 'bare-fs'
import env from 'bare-env'
import * as sdk from '@qvac/bare-sdk'
import { llmPlugin } from '@qvac/bare-sdk/llamacpp-completion/plugin'
import { DEFAULT_MODEL, DEFAULT_CTX_SIZE, MODELS, resolveName } from './models.mjs'

export { MODELS, DEFAULT_MODEL, DEFAULT_CTX_SIZE, resolveName } from './models.mjs'

let registered = false

// In bare-sdk NOTHING auto-registers: without this, any call throws
// WorkerPluginsNotRegisteredError.
//
// SDK registration is NOT idempotent: calling it twice throws
// PLUGIN_ALREADY_REGISTERED. The local flag isn't enough, because the SDK's
// registry is process-wide and there's more than one path that registers:
// the Pear entry point (qvac/worker.pear.entry.mjs) does
// `registerPlugin(llmPlugin)` BEFORE importing bin.mjs. That's why this
// specific error -and only this one- gets swallowed: it means the plugin is
// already there, which is exactly what we wanted.
function register() {
  if (registered) return
  try {
    sdk.plugins([llmPlugin])
  } catch (err) {
    if (err?.name !== 'PLUGIN_ALREADY_REGISTERED') throw err
  }
  registered = true
}

// Where the SDK stores the weights. It doesn't export this, so the
// computation of `getQvacPath('models')` gets replicated here
// (server/utils/qvac-paths.js + server/env.js). Only used to REPORT and to
// detect the cache; nothing depends on getting it exactly right.
export function modelsDir() {
  const home = env['SNAP_USER_COMMON'] ?? env['HOME'] ?? env['USERPROFILE'] ?? '/tmp'
  return path.join(home, '.qvac', 'models')
}

// Weights get saved as `<hash>_<name>.gguf`. The hash can't be derived from
// here, so it's looked up by suffix.
export function isCached(modelName) {
  const dir = modelsDir()
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false // directory doesn't exist yet: nothing is cached
  }
  return entries.some((f) => f.endsWith(`_${modelName}.gguf`))
}

// Returns the registry entry PLUS a usable `modelSrc`.
//
// A registry entry is NOT a valid modelSrc as-is: the schema requires a `src`
// field the entry doesn't carry, and without it it fails with
// REQUEST_VALIDATION_FAILED "Invalid input at modelSrc". The `registry://`
// scheme is the one that pulls the weights over hypercore instead of HTTP
// (same pattern as the predefined descriptors in dist/_sdk/models/registry).
export async function resolveModel(pick = DEFAULT_MODEL) {
  register()
  const name = resolveName(pick)
  const found = await sdk.modelRegistrySearch({ filter: name })
  const entry = found.find((e) => e.name === name)
  if (!entry) {
    throw new Error(
      `could not find "${name}" in the QVAC registry. Known aliases: ${Object.keys(MODELS).join(', ')}`
    )
  }
  return {
    entry,
    name,
    cached: isCached(name),
    modelSrc: { ...entry, src: `registry://${entry.registrySource}/${entry.registryPath}` }
  }
}

// `verbosity: 0` is ERROR: turns the llamacpp addon's logging down to the
// minimum.
//
// HEADS UP, it doesn't silence it entirely: the two lines "parse: load the
// model metadata..." and "initFromConfig: ..." that print on load are raw
// printfs from llama.cpp, upstream of the logging hook, and CANNOT be turned
// off from here. Tested with the SDK's setGlobalLogLevel('error') +
// setGlobalConsoleOutput(false): they still show up. Redirecting fd 1 is the
// only way and it's not worth it: it would take the response down with it.
// The combo that loads NO model at all: Linux + standalone binary. The
// bundle only registers the Vulkan backend and never enumerates the CPU
// variants, so it always fails -- measured and documented in NOTES.md,
// "Nodo Linux 24/7".
//
// This function exists because the error the SDK throws is `failed to fit
// params to free device memory`, which points at memory and has NOTHING to
// do with it: it cost us an hour of ruling things out (the file, the hash,
// two models, `--gpu-layers`, Vulkan, the context, the /tmp mount) before
// landing on the real cause. A third party would give up long before that.
// Saying what we know, where we know it, is cheap.
function pistaLinuxStandalone() {
  if (bareProcess.platform !== 'linux') return null
  // Same criterion as bin.mjs: if argv[0] is the `bare` runtime, we're
  // running from source and this problem doesn't apply.
  if (path.basename(String(Bare.argv[0] || '')) === 'bare') return null
  return (
    'On Linux the standalone binary does NOT register any CPU backend, ' +
    'so no model loads. It is not your machine or the model file: ' +
    'see NOTES.md, "Nodo Linux 24/7". In the meantime run from source ' +
    '(`node_modules/bare-runtime-linux-x64/bin/bare bin.mjs ...`).'
  )
}

export async function loadModel({
  modelSrc,
  ctxSize = DEFAULT_CTX_SIZE,
  gpuLayers,
  verbosity = 0,
  onProgress
}) {
  register()
  const modelConfig = { ctx_size: ctxSize, verbosity }
  // Only sent if requested: without the key, the SDK applies its device
  // defaults, which are the right ones on a machine with a decent GPU.
  if (Number.isFinite(gpuLayers)) modelConfig.gpu_layers = gpuLayers
  try {
    return await sdk.loadModel({ modelSrc, modelConfig, onProgress })
  } catch (err) {
    const pista = pistaLinuxStandalone()
    if (!pista) throw err
    const conPista = new Error(`${(err && err.message) || err}\n\n  ${pista}`)
    conPista.cause = err
    throw conPista
  }
}

// Text stream. Returns an async iterable of strings (the deltas), so the
// shape of the SDK's events doesn't leak to callers.
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

// `unloadModel` does NOT close the SDK's connections: the swarm, the
// registry client, and the corestore are deliberately left up, so a
// long-lived worker can survive load/unload cycles. A one-shot CLI needs
// both closed or the process never exits.
export async function shutdown(modelId) {
  if (modelId) await sdk.unloadModel({ modelId }).catch(() => {})
  await sdk.close().catch(() => {})
}

export { bareProcess, sdk }
