// Pear entrypoint for the QVAC SDK.
//
// `@qvac/sdk` ships a `pear-pre` pre-hook that generates this file by itself,
// from qvac.config.{json,mjs}. `@qvac/bare-sdk` does NOT: it follows the
// explicit-assembly model, so Pear apps that use it have to write the entry
// by hand. It's a specific requirement from bare-sdk's README (the "Pear
// pre-hook" section), and that's why the file has this exact name and is
// declared in `pear.stage.entrypoints` in package.json.
//
// WHEN IT APPLIES: only on the "Pear app from source" path —`pear run`,
// `pear dev`, or a stage of the source code instead of the binaries—, where
// Pear builds the bundle from the declared entrypoints and needs to see the
// plugin and its addon in the graph.
//
// WHEN IT DOESN'T: the QVAC-Node release does NOT go through here. We publish
// standalone binaries compiled with `bare-build` from `bin.mjs`, and
// `pear stage` uploads `./build` (only `by-arch/`). On that path, the one
// that puts the addon into the binary is bare-pack walking `bin.mjs`'s graph.
// This file exists so the from-source path also works, and so we don't fall
// out of contract with bare-sdk.

import './global-process.mjs'
import { registerPlugin } from '@qvac/bare-sdk/plugins'
import { llmPlugin } from '@qvac/bare-sdk/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

await import('../bin.mjs')
