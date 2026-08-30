// Text to vector. The "knows about embeddings" half of RAG; the one that
// knows about the index and search is rag.mjs.
//
// Kept separate for the same reason as costs.mjs from budget.mjs: the index
// doesn't need to know which API does the embedding, and the embedder doesn't
// need to know a hypercore exists on the other end.
//
// -----------------------------------------------------------------------------
// REMOTE FIRST, LOCAL LATER
//
// The node boots with no inference capability, so the first embedder is HTTP
// against an OpenAI-compatible API. The day the machine has what it takes,
// it swaps for the local plugin (@qvac/bare-sdk/llamacpp-embedding/plugin)
// and the index is NOT touched -- as long as it's the same model. If the
// model changes the vectors change, and then there's a reindex to do: see the
// `embeddingModelId` check in rag.mjs.
//
// -----------------------------------------------------------------------------
// THE QUERY/PASSAGE ASYMMETRY IS REAL, AND IT'S SILENT
//
// Models in the embedqa family embed a document differently from a question.
// Measured against nvidia/nemotron-3-embed-1b with the SAME text:
//
//     cosine(passage, query) = 0.72
//
// It's not noise: they're two different vectors on purpose. Sending the wrong
// input_type doesn't error out -- the API answers 200 and returns a vector
// that's useful for something else -- and the only symptom is recall dropping
// with nothing failing.
//
// That's why the mode is NOT a mutable flag on the embedder: two already-bound
// functions are returned instead, `paraDocumentos` and `paraConsultas`. A flag
// you have to remember to set before every call is a race waiting for two
// concurrent requests.
// -----------------------------------------------------------------------------

import env from 'bare-env'

// The default is the one verified against the account: 2048 dimensions,
// accepts batches and respects input_type. `nvidia/llama-3.2-nv-embedqa-1b-v1`
// gives a 404 on this account even though it shows up in /v1/models, so it's
// no good as a default.
export const MODELO_DEFAULT = 'nvidia/nemotron-3-embed-1b'
export const DIMENSION_DEFAULT = 2048
export const BASE_URL_DEFAULT = 'https://integrate.api.nvidia.com/v1'

// How many texts per request. The API accepts batches; the limit here is to
// avoid building a giant body with an entire repo inside.
const LOTE_DEFAULT = 32

// Retry ONLY for what can come out different on a retry (ROADMAP's D20): 429
// and 5xx are transient, a 400 or a 401 will fail the same way all three
// times and retrying them just multiplies the bill.
const REINTENTOS = 3
const ESPERA_BASE_MS = 500

function esReintentable(status) {
  return status === 429 || (status >= 500 && status < 600)
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postJson(url, key, body, { signal = null } = {}) {
  const mod = await import('bare-fetch')
  const fetch = mod.default || mod.fetch || mod

  let ultimo = null
  for (let intento = 0; intento < REINTENTOS; intento++) {
    if (intento > 0) {
      // Jitter, not bare backoff: without it, N nodes booting together all
      // retry in the same millisecond and collide again.
      const espera = ESPERA_BASE_MS * Math.pow(2, intento - 1) * (0.5 + Math.random())
      await esperar(espera)
    }

    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      // Connection error: transient by definition.
      ultimo = new Error('could not reach the embeddings service: ' + ((err && err.message) || err))
      continue
    }

    if (res.ok) return await res.json()

    // The provider's detail goes to THIS process's log, not to whoever's
    // asking: it might carry the account name or an internal function id.
    const detalle = await res.text().catch(() => '')
    console.error('[embeddings] ' + res.status + ': ' + detalle.slice(0, 300))

    if (!esReintentable(res.status)) {
      // 401 is the most likely case and the easiest to fix: say how.
      if (res.status === 401 || res.status === 403) {
        throw new Error('the embeddings API rejected the credential (HTTP ' + res.status + ')')
      }
      throw new Error('the embeddings API answered HTTP ' + res.status)
    }
    ultimo = new Error('the embeddings API answered HTTP ' + res.status)
  }
  throw ultimo || new Error('could not embed')
}

// Creates the HTTP embedder. The key is read from an ENVIRONMENT VARIABLE
// whose name comes from the config: the repo keeps the name, never the
// secret.
export function crearEmbedderHttp({
  baseUrl = BASE_URL_DEFAULT,
  model = MODELO_DEFAULT,
  apiKeyEnv = 'NVIDIA_API_KEY',
  dimension = DIMENSION_DEFAULT,
  lote = LOTE_DEFAULT
} = {}) {
  const key = env[apiKeyEnv]
  if (!key) {
    throw new Error(
      'missing embeddings credential: set the environment variable ' + apiKeyEnv
    )
  }

  const url = baseUrl.replace(/\/+$/, '') + '/embeddings'

  async function embeber(textos, inputType, { signal = null } = {}) {
    const lista = Array.isArray(textos) ? textos : [textos]
    if (lista.length === 0) return []

    const out = []
    for (let i = 0; i < lista.length; i += lote) {
      const tanda = lista.slice(i, i + lote)
      const json = await postJson(url, key, {
        model,
        input: tanda,
        input_type: inputType,
        encoding_format: 'float'
      }, { signal })

      if (!json || !Array.isArray(json.data) || json.data.length !== tanda.length) {
        throw new Error('unexpected embeddings response: asked for ' + tanda.length + ' vectors')
      }
      // The API can return out of order: each item carries its own `index`.
      const ordenados = json.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0))
      for (const d of ordenados) out.push(d.embedding)
    }
    return out
  }

  return {
    model,
    dimension,
    origen: url,

    // For INGESTING. This is the one passed to RAG as embeddingFunction.
    async paraDocumentos(textos, opts) {
      const vs = await embeber(textos, 'passage', opts || {})
      return Array.isArray(textos) ? vs : vs[0]
    },

    // For SEARCHING. Kept separate and not as a mutable mode precisely so two
    // concurrent operations don't stomp on each other's input_type.
    async paraConsultas(texto, opts) {
      const vs = await embeber([texto], 'query', opts || {})
      return vs[0]
    }
  }
}

// Cheap check that the credential and the model work, so it can fail on
// startup instead of halfway through ingesting an entire repo.
export async function verificar(embedder) {
  const v = await embedder.paraConsultas('prueba')
  if (!Array.isArray(v) || v.length === 0) throw new Error('the embedder did not return a vector')
  if (v.length !== embedder.dimension) {
    // The declared dimension not matching the real one breaks the index in a
    // way that's hard to read afterwards: cut it off here.
    throw new Error(
      'model ' + embedder.model + ' returns ' + v.length +
      ' dimensions and the config declares ' + embedder.dimension
    )
  }
  return { model: embedder.model, dimension: v.length }
}
