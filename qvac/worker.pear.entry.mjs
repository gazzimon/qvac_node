// Entrypoint de Pear para el SDK de QVAC.
//
// `@qvac/sdk` trae un pre-hook `pear-pre` que genera este archivo solo, a
// partir de qvac.config.{json,mjs}. `@qvac/bare-sdk` NO: sigue el modelo de
// ensamblado explicito, asi que las apps Pear que lo usan tienen que escribir
// el entry a mano. Es un requisito puntual del README de bare-sdk (seccion
// "Pear pre-hook"), y por eso el archivo tiene este nombre exacto y esta
// declarado en `pear.stage.entrypoints` del package.json.
//
// CUANDO APLICA: solo en el camino "app Pear desde el fuente" —`pear run`,
// `pear dev`, o un stage del codigo fuente en vez de los binarios—, donde Pear
// arma el bundle a partir de los entrypoints declarados y necesita ver el
// plugin y su addon en el grafo.
//
// CUANDO NO: el release de QVAC-Node NO pasa por aca. Publicamos binarios
// standalone compilados con `bare-build` desde `bin.mjs`, y `pear stage`
// sube `./build` (solo `by-arch/`). En ese camino, quien mete el addon en el
// binario es bare-pack recorriendo el grafo de `bin.mjs`. Este archivo existe
// para que el camino desde el fuente tambien funcione, y para no quedar fuera
// de contrato con bare-sdk.

import './global-process.mjs'
import { registerPlugin } from '@qvac/bare-sdk/plugins'
import { llmPlugin } from '@qvac/bare-sdk/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

await import('../bin.mjs')
