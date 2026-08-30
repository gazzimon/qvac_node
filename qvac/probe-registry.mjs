// Phase 1 probe: registers the llamacpp plugin and asks QVAC's registry what
// models it offers. Used to pick a <=1B one without making up a URL.
//
//   ./node_modules/.bin/bare qvac/probe-registry.mjs

import bareProcess from 'bare-process'

// The `process` global doesn't exist in Bare and the SDK expects it. This
// line goes BEFORE importing the SDK: if it's imported first, the module has
// already evaluated its references to the global and fails with unhelpful
// errors.
if (!global.process) global.process = bareProcess

const { plugins, modelRegistrySearch, close } = await import('@qvac/bare-sdk')
const { llmPlugin } = await import('@qvac/bare-sdk/llamacpp-completion/plugin')

// Nothing auto-registers in bare-sdk: without this, any call throws
// WorkerPluginsNotRegisteredError.
plugins([llmPlugin])

console.log('plugin registered:', llmPlugin.modelType, '->', llmPlugin.addonPackage)
console.log('querying the registry...\n')

try {
  const entries = await modelRegistrySearch({ engine: 'llamacpp-completion' })
  console.log('models found:', entries.length, '\n')
  for (const e of entries.slice(0, 40)) {
    console.log(JSON.stringify(e))
  }
} catch (err) {
  console.error('registry query FAILED:', err && err.message)
  console.error(err)
} finally {
  await close().catch(() => {})
}
