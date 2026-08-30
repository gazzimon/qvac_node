// QVAC-Node model catalog. Pure data, no SDK: bin.mjs imports it statically
// to build the `--help` text without dragging in the llamacpp addon (which
// opens via dlopen as soon as the plugin is imported).

// Catalog verified against QVAC's real registry (`sdk.modelRegistrySearch`
// with an empty filter, run in this session — these aren't made-up names:
// the QVAC track rejects any hallucinated model name without review).
// `sizeGB` is the real `expectedSize` the registry returns, not an estimate —
// it's what hardware detection (qvac/hardware.mjs) uses to decide which
// models fit in a given machine's RAM.
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
  },
  // The lightest 27B in the registry: the only other Qwen3.6-27B quant is
  // Q6_K_XL at 23.9 GB, which leaves no room for context on a 25 GB box.
  qwen27b: {
    name: 'Qwen3.6-27B-UD-Q4_K_XL',
    displayName: 'Qwen3.6 27B',
    params: '27B',
    sizeGB: 17612564704 / 1024 ** 3
  },
  // Same 35B coding model as katcoder35b, at an aggressive ~2-bit quant: less
  // than half the size (9.1 GB vs 19.9 GB), so it fits with real headroom.
  // Whether 35B at 2 bits beats a smaller model at 4 bits is a measurement
  // nobody here has taken — it is in the catalog to make that measurement possible,
  // not as a recommendation.
  katcoder35b_iq2: {
    name: 'Kwaipilot_KAT-Coder-V2.5-Dev-IQ2_XXS',
    displayName: 'KAT-Coder 35B (IQ2_XXS)',
    params: '35B',
    sizeGB: 9778452896 / 1024 ** 3
  }
}

// Backward compatibility: alias -> exact registry name. `bin.mjs` and
// `engine.mjs` (resolveName) still use this shape; its shape isn't touched
// so both don't have to be touched.
export const MODELS = Object.fromEntries(
  Object.entries(MODEL_INFO).map(([alias, info]) => [alias, info.name])
)

// Default chosen by measurement, not by preference: the 360M responds 0.72s
// faster but produces incoherent Spanish, and the output is what gets read
// on screen. The numbers are in NOTES.md.
export const DEFAULT_MODEL = 'llama1b'

export const DEFAULT_CTX_SIZE = 2048

export function resolveName(pick = DEFAULT_MODEL) {
  return MODELS[pick] || pick
}
