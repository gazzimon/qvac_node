// Catalogo de modelos de QVAC-Node. Datos puros, sin SDK: bin.mjs lo importa
// de forma estatica para armar el texto del `--help` sin arrastrar el addon de
// llamacpp (que se abre con dlopen apenas se importa el plugin).

// Catalogo verificado contra el registry real de QVAC (`sdk.modelRegistrySearch`
// con filtro vacio, corrido en esta sesion — no son nombres inventados: el
// track de QVAC descarta sin revision cualquier nombre de modelo alucinado).
// `sizeGB` es el `expectedSize` real que devuelve el registry, no una
// estimacion — es lo que la deteccion de hardware (qvac/hardware.mjs) usa
// para decidir que modelos entran en la RAM de una maquina dada.
export const MODEL_INFO = {
  smol: {
    name: 'smollm2-360m-instruct-q8_0',
    displayName: 'SmolLM2 360M Instruct',
    params: '360M',
    sizeGB: 386404992 / 1024 ** 3
  },
  llama1b: {
    name: 'llama_3.2_1b_intruct_tool_calling_v2.Q4_K',
    displayName: 'Llama 3.2 1B Instruct',
    params: '1B',
    sizeGB: 807691648 / 1024 ** 3
  },
  qwen1_7b: {
    name: 'Qwen3-1.7B-Q4_0',
    displayName: 'Qwen3 1.7B',
    params: '1.7B',
    sizeGB: 1056782912 / 1024 ** 3
  },
  qwen4b: {
    name: 'Qwen3-4B-Q4_K_M',
    displayName: 'Qwen3 4B',
    params: '4B',
    sizeGB: 2497281312 / 1024 ** 3
  },
  qwen8b: {
    name: 'Qwen3-8B-Q4_K_M',
    displayName: 'Qwen3 8B',
    params: '8B',
    sizeGB: 5027783488 / 1024 ** 3
  },
  gemma4b: {
    name: 'google_gemma-4-E4B-it-Q4_K_M',
    displayName: 'Gemma 4 E4B Instruct',
    params: '4B',
    sizeGB: 5405168384 / 1024 ** 3
  },

  // Added 2026-08-30 for machines well past K16's class (>=32GB RAM/VRAM
  // headroom). Verified against the real registry the same way as the rest
  // of this file (`node_modules/.bin/bare qvac/probe-registry.mjs`) — not
  // guessed names. None of these have run the orchestrator worker
  // qualification demo yet (see PROMPT_FLEET-WORKER-ONBOARDING.md step 4):
  // treat them as catalog entries, not as proven workers, until one has.
  gptoss20b: {
    name: 'gpt-oss-20b-Q4_K_M',
    displayName: 'GPT-OSS 20B',
    params: '20B',
    sizeGB: 11624759488 / 1024 ** 3
  },
  katcoder35b: {
    name: 'Kwaipilot_KAT-Coder-V2.5-Dev-Q4_K_M',
    displayName: 'KAT-Coder V2.5 Dev 35B',
    params: '35B',
    sizeGB: 21391448480 / 1024 ** 3
  },
  katcoder35b_q8: {
    name: 'Kwaipilot_KAT-Coder-V2.5-Dev-Q8_0',
    displayName: 'KAT-Coder V2.5 Dev 35B (Q8)',
    params: '35B',
    sizeGB: 36914690464 / 1024 ** 3
  },
  qwen35bmoe: {
    name: 'Qwen3.6-35B-A3B-UD-Q4_K_M',
    displayName: 'Qwen3.6 35B-A3B (MoE)',
    params: '35B-A3B',
    sizeGB: 22134528992 / 1024 ** 3
  },
  gemma31b: {
    name: 'google_gemma-4-31B-it-Q4_K_M',
    displayName: 'Gemma 4 31B Instruct',
    params: '31B',
    sizeGB: 19598488192 / 1024 ** 3
  }
}

// Compatibilidad hacia atras: alias -> nombre exacto del registry. `bin.mjs`
// y `engine.mjs` (resolveName) siguen usando esta forma; no se toca su shape
// para no tener que tocar los dos.
export const MODELS = Object.fromEntries(
  Object.entries(MODEL_INFO).map(([alias, info]) => [alias, info.name])
)

// Default medido, no elegido por gusto: el 360M responde 0.72s antes pero
// produce castellano incoherente, y la salida es lo que se lee en pantalla.
// Los numeros estan en NOTES.md.
export const DEFAULT_MODEL = 'llama1b'

export const DEFAULT_CTX_SIZE = 2048

export function resolveName(pick = DEFAULT_MODEL) {
  return MODELS[pick] || pick
}
