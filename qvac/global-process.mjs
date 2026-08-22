// Shim del global `process` para el SDK de QVAC.
//
// Bare no define `process` como global y el SDK lo espera. Vive en un modulo
// aparte por una razon de ORDEN DE EVALUACION: en ESM los imports se evaluan
// antes del cuerpo del modulo que los declara, asi que poner la asignacion en
// el cuerpo de engine.mjs corre tarde —el SDK ya evaluo sus referencias al
// global y falla con errores poco descriptivos—. Importando esto primero, el
// shim ya esta puesto cuando el SDK se evalua.
//
// Este es el truco que permite que engine.mjs use imports ESTATICOS del SDK.
// Importa: bare-pack resuelve el grafo estatico para armar el binario
// standalone, y ahi es donde entra el prebuild .bare de llamacpp.

import bareProcess from 'bare-process'

if (!global.process) global.process = bareProcess

export default bareProcess
