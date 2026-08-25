// De texto a vector. La mitad "sabe de embeddings" del RAG; la que sabe de
// indice y busqueda es rag.mjs.
//
// Se separa por la misma razon que costs.mjs de budget.mjs: el indice no tiene
// por que saber contra que API se embebe, y el embebedor no tiene por que
// saber que existe un hypercore del otro lado.
//
// -----------------------------------------------------------------------------
// REMOTO PRIMERO, LOCAL DESPUES
//
// El nodo arranca sin capacidad de inferencia, asi que el primer embebedor es
// HTTP contra una API OpenAI-compatible. El dia que la maquina tenga con que,
// se cambia por el plugin local (@qvac/bare-sdk/llamacpp-embedding/plugin) y
// el indice NO se toca -- siempre que sea el mismo modelo. Si cambia el
// modelo cambian los vectores, y ahi hay que reindexar: ver el chequeo de
// `embeddingModelId` en rag.mjs.
//
// -----------------------------------------------------------------------------
// LA ASIMETRIA QUERY/PASSAGE ES REAL, Y ES SILENCIOSA
//
// Los modelos de la familia embedqa embeben distinto un documento que una
// pregunta. Medido contra nvidia/nemotron-3-embed-1b con el MISMO texto:
//
//     coseno(passage, query) = 0.72
//
// No es ruido: son dos vectores distintos a proposito. Mandar el input_type
// equivocado no da error -- la API contesta 200 y devuelve un vector util para
// otra cosa -- y el unico sintoma es que el recall baja sin que nada falle.
//
// Por eso el modo NO es un flag mutable del embebedor: se devuelven dos
// funciones ya atadas, `paraDocumentos` y `paraConsultas`. Un flag que hay que
// acordarse de poner antes de cada llamada es una carrera esperando a dos
// requests concurrentes.
// -----------------------------------------------------------------------------

import env from 'bare-env'

// El default es el que se verifico contra la cuenta: 2048 dimensiones, acepta
// lotes y respeta input_type. `nvidia/llama-3.2-nv-embedqa-1b-v1` da 404 en
// esta cuenta aunque figure en /v1/models, asi que no sirve de default.
export const MODELO_DEFAULT = 'nvidia/nemotron-3-embed-1b'
export const DIMENSION_DEFAULT = 2048
export const BASE_URL_DEFAULT = 'https://integrate.api.nvidia.com/v1'

// Cuantos textos por request. La API acepta lotes; el limite de aca es para no
// armar un body gigante con un repo entero adentro.
const LOTE_DEFAULT = 32

// Reintento SOLO para lo que puede salir distinto si se vuelve a intentar
// (D20 del ROADMAP): 429 y 5xx son transitorios, un 400 o un 401 van a fallar
// igual las tres veces y reintentarlos solo multiplica la cuenta.
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
      // Jitter, no backoff pelado: sin el, N nodos que arrancan juntos
      // reintentan todos en el mismo milisegundo y se vuelven a chocar.
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
      // Error de conexion: transitorio por definicion.
      ultimo = new Error('no se pudo llegar al servicio de embeddings: ' + ((err && err.message) || err))
      continue
    }

    if (res.ok) return await res.json()

    // El detalle del proveedor va al log de ESTE proceso y no al que pregunta:
    // puede traer el nombre de la cuenta o el id de la funcion interna.
    const detalle = await res.text().catch(() => '')
    console.error('[embeddings] ' + res.status + ': ' + detalle.slice(0, 300))

    if (!esReintentable(res.status)) {
      // 401 es el caso mas probable y el mas facil de arreglar: se dice como.
      if (res.status === 401 || res.status === 403) {
        throw new Error('la API de embeddings rechazo la credencial (HTTP ' + res.status + ')')
      }
      throw new Error('la API de embeddings contesto HTTP ' + res.status)
    }
    ultimo = new Error('la API de embeddings contesto HTTP ' + res.status)
  }
  throw ultimo || new Error('no se pudo embeber')
}

// Crea el embebedor HTTP. La key se lee de una VARIABLE DE ENTORNO cuyo nombre
// viene en la config: en el repo queda el nombre, nunca el secreto.
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
      'falta la credencial de embeddings: pone la variable de entorno ' + apiKeyEnv
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
        throw new Error('respuesta de embeddings inesperada: se pidieron ' + tanda.length + ' vectores')
      }
      // La API puede devolver desordenado: cada item trae su `index`.
      const ordenados = json.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0))
      for (const d of ordenados) out.push(d.embedding)
    }
    return out
  }

  return {
    model,
    dimension,
    origen: url,

    // Para INGESTAR. Es la que se le pasa a RAG como embeddingFunction.
    async paraDocumentos(textos, opts) {
      const vs = await embeber(textos, 'passage', opts || {})
      return Array.isArray(textos) ? vs : vs[0]
    },

    // Para BUSCAR. Va aparte y no como un modo mutable justamente para que dos
    // operaciones concurrentes no se pisen el input_type.
    async paraConsultas(texto, opts) {
      const vs = await embeber([texto], 'query', opts || {})
      return vs[0]
    }
  }
}

// Comprobacion barata de que la credencial y el modelo andan, para poder
// fallar al arrancar y no a la mitad de ingestar un repo entero.
export async function verificar(embedder) {
  const v = await embedder.paraConsultas('prueba')
  if (!Array.isArray(v) || v.length === 0) throw new Error('el embebedor no devolvio un vector')
  if (v.length !== embedder.dimension) {
    // Que la dimension declarada no sea la real rompe el indice de forma
    // dificil de leer despues: se corta aca.
    throw new Error(
      'el modelo ' + embedder.model + ' devuelve ' + v.length +
      ' dimensiones y la config declara ' + embedder.dimension
    )
  }
  return { model: embedder.model, dimension: v.length }
}
