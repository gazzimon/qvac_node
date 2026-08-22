// Catalogo de modelos de QVAC-Node. Datos puros, sin SDK: bin.mjs lo importa
// de forma estatica para armar el texto del `--help` sin arrastrar el addon de
// llamacpp (que se abre con dlopen apenas se importa el plugin).

// Modelos <=1B del registry de QVAC. El limite de 1B sale del runbook.
export const MODELS = {
  smol: 'smollm2-360m-instruct-q8_0', // 360M, 386 MB
  llama1b: 'llama_3.2_1b_intruct_tool_calling_v2.Q4_K' // 1B, 807 MB
}

// Default medido, no elegido por gusto: el 360M responde 0.72s antes pero
// produce castellano incoherente, y la salida es lo que se lee en pantalla.
// Los numeros estan en NOTES.md.
export const DEFAULT_MODEL = 'llama1b'

export const DEFAULT_CTX_SIZE = 2048

export function resolveName(pick = DEFAULT_MODEL) {
  return MODELS[pick] || pick
}
