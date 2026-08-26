// El nodo que no tiene GPU igual contesta: le pregunta a una API externa.
// Fase 8.5 del ROADMAP -- el asistente externo como UN CANDIDATO MAS.
//
// -----------------------------------------------------------------------------
// POR QUE ES UN CANDIDATO Y NO UNA RAMA APARTE
//
// La Fase 8 hizo que el ruteo eligiera por carga en vez de tomar el primero.
// Con eso, un upstream no necesita ningun camino especial: se registra en el
// store como una fila mas -- kind 'upstream' -- y todo lo que ya existe
// empieza a funcionar solo. findAllByModelId lo considera, /v1/models y
// /v1/nodes lo listan, el log de ruteo lo registra con su motivo, y los
// headers de procedencia lo declaran al cliente.
//
// Si en vez de eso fuera un `if (noHayNadie) llamarAOpenAI()` metido en
// handleChat, todo eso habria que escribirlo de nuevo y quedaria fuera del
// rastro.
//
// -----------------------------------------------------------------------------
// LO QUE OBDIENT-SEED YA APRENDIO
//
// El proxy de obdient-seed (src/proxy/senior.mjs) lleva meses hablando con
// esta misma API. Dos cosas que le costaron y que aca vienen de fabrica:
//
//   1. Se lee SOLO delta.content. Los modelos con razonamiento mandan tambien
//      `reasoning_content`, que expone el pensamiento del modelo y, con el, el
//      proveedor detras. Se descarta por construccion, no por un filtro que
//      alguien puede olvidar.
//   2. El detalle del error del proveedor va al log de ESTE proceso, nunca al
//      cliente: puede traer el nombre de la cuenta o el id interno de la
//      funcion.
//
// Y dos que a obdient-seed le faltan y aca si hacen falta:
//
//   3. Backoff con jitter SOLO para 429/5xx/errores de conexion. Un 400 o un
//      401 van a fallar igual las tres veces (D20: sin idempotencia, el
//      backoff no es tolerancia a fallos, es un multiplicador de la cuenta).
//   4. Se lee `usage` del proveedor. obdient-seed lo descarta y su propia app
//      lo esta esperando; aca es lo que alimenta la liquidacion del budget.
// -----------------------------------------------------------------------------

import env from 'bare-env'

const REINTENTOS = 3
const ESPERA_BASE_MS = 400

// Techo de salida cuando ni la config ni el cliente dicen otra cosa. 1024 son
// ~4 parrafos: alcanza para una respuesta de chat y acota el peor caso de la
// reserva a un numero que se puede mirar sin susto.
const MAX_TOKENS_DEFAULT = 1024

function esReintentable(status) {
  return status === 429 || (status >= 500 && status < 600)
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export class Upstream {
  constructor({
    id,
    label,
    baseUrl,
    apiKeyEnv,
    model,
    displayName,
    tags = [],
    maxConcurrent = 4,
    maxTokens = MAX_TOKENS_DEFAULT,
    precio = null,
    extraBody = null
  }) {
    this.id = id
    this.label = label || id
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.apiKeyEnv = apiKeyEnv
    this.model = model
    this.displayName = displayName || model
    this.tags = tags
    this.maxConcurrent = maxConcurrent
    // TOPE DE SALIDA PROPIO, y con default distinto de cero a proposito.
    //
    // La reserva del presupuesto es `promptTokens*entrada + maxTokens*salida`:
    // con maxTokens en cero la cota superior da CERO y el tope deja de cortar
    // justo en el unico camino que cuesta dolares. Un cliente de OpenAI que no
    // manda `max_tokens` -que son casi todos- no puede desactivar el corte sin
    // querer, asi que el limite lo pone el nodo.
    this.maxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : MAX_TOKENS_DEFAULT
    // { entrada, salida } en micro-dolares por 1M de tokens, o null si el
    // operador no lo declaro. Sin precio no hay reserva posible: quien
    // registra decide si eso deja al upstream afuera (bin.mjs lo deja).
    this.precio = precio
    // Algunos modelos piden campos fuera del estandar de OpenAI (por ejemplo
    // chat_template_kwargs.enable_thinking). Viven en la config y no en el
    // codigo: son del modelo, no nuestros.
    this.extraBody = extraBody
  }

  // La credencial se lee de una VARIABLE DE ENTORNO cuyo NOMBRE esta en la
  // config. En el repo queda el nombre; el secreto no toca el disco, y sobre
  // todo no entra al manifiesto firmado que se le anuncia a la red.
  get apiKey() {
    return env[this.apiKeyEnv] || null
  }

  disponible() {
    return !!this.apiKey
  }

  // Genera deltas de texto. MISMA forma que engine.complete(), a proposito:
  // el provider y el gateway consumen los dos con el mismo `for await`, asi
  // que cancelacion, timeouts y conteo de tokens siguen funcionando sin
  // cambios.
  async * completar({ messages, maxTokens = 0, signal = null, onUsage = null }) {
    // El menor entre lo que pidio el cliente y lo que este nodo permite. Un
    // cliente puede pedir MENOS que el tope; no puede pedir mas.
    const tope = maxTokens > 0 ? Math.min(maxTokens, this.maxTokens) : this.maxTokens
    const key = this.apiKey
    if (!key) {
      throw new Error('falta la credencial: pone la variable de entorno ' + this.apiKeyEnv)
    }

    const mod = await import('bare-fetch')
    const fetch = mod.default || mod.fetch || mod

    const body = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: tope,
      ...(this.extraBody || {})
    }

    let res = null
    for (let intento = 0; intento < REINTENTOS; intento++) {
      if (intento > 0) {
        const espera = ESPERA_BASE_MS * Math.pow(2, intento - 1) * (0.5 + Math.random())
        await esperar(espera)
      }
      try {
        res = await fetch(this.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
          signal
        })
      } catch (err) {
        res = null
        if (intento === REINTENTOS - 1) {
          throw new Error('no se pudo llegar al proveedor: ' + ((err && err.message) || err))
        }
        continue
      }

      if (res.ok) break

      const detalle = await res.text().catch(() => '')
      console.error('[upstream:' + this.id + '] HTTP ' + res.status + ': ' + detalle.slice(0, 300))

      if (!esReintentable(res.status)) {
        // El mensaje que sale al cliente NO lleva el detalle del proveedor.
        throw new Error('el proveedor externo rechazo el request (HTTP ' + res.status + ')')
      }
      if (intento === REINTENTOS - 1) {
        throw new Error('el proveedor externo no esta disponible (HTTP ' + res.status + ')')
      }
      res = null
    }

    // SSE a mano: mismo formato que ya parsea el chat del panel.
    let buffer = ''
    let usage = null

    for await (const chunk of res.body) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')

      let corte
      while ((corte = buffer.indexOf('\n\n')) !== -1) {
        const bloque = buffer.slice(0, corte)
        buffer = buffer.slice(corte + 2)

        for (const linea of bloque.split('\n')) {
          if (!linea.startsWith('data:')) continue
          const dato = linea.slice(5).trim()
          if (dato === '' || dato === '[DONE]') continue

          let ev
          try {
            ev = JSON.parse(dato)
          } catch {
            continue
          }

          // El usage viaja en el ultimo chunk cuando el proveedor lo manda.
          if (ev.usage) usage = ev.usage

          const delta = ev.choices && ev.choices[0] && ev.choices[0].delta
          if (!delta) continue

          // SOLO content. `reasoning_content` se ignora sin excepcion: es el
          // pensamiento del modelo y delata al proveedor.
          if (typeof delta.content === 'string' && delta.content !== '') {
            yield delta.content
          }
        }
      }
    }

    if (usage && onUsage) onUsage(usage)
  }
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

// Los upstreams salen de un archivo del directorio de datos, NO del codigo:
// que APIs usa este nodo es una decision del operador, no del programa.
export function cargarDesde(objeto) {
  if (!objeto || !Array.isArray(objeto.upstreams)) return []
  const out = []
  for (const u of objeto.upstreams) {
    if (!u || !u.id || !u.baseUrl || !u.apiKeyEnv) continue
    for (const m of u.models || []) {
      if (!m || !m.modelId) continue
      out.push(
        new Upstream({
          id: u.id + ':' + m.modelId,
          label: u.label || u.id,
          baseUrl: u.baseUrl,
          apiKeyEnv: u.apiKeyEnv,
          model: m.modelId,
          displayName: m.displayName || m.modelId,
          tags: m.tags || [],
          maxConcurrent: Number.isFinite(m.maxConcurrent) ? m.maxConcurrent : 4,
          maxTokens: Number(m.maxTokens),
          precio: precioDe(m),
          extraBody: m.extraBody || null
        })
      )
    }
  }
  return out
}

// El precio que declara el operador, en USD por 1M de tokens, pasado a los
// micro-dolares enteros con los que trabaja costs.mjs. Nunca floats mas alla
// de esta conversion: es el unico punto donde un numero escrito por una
// persona entra al contador.
//
// Se redondea HACIA ARRIBA. Un precio subestimado hace que la reserva se
// quede corta, y una reserva corta es un tope que se pasa.
function precioDe(m) {
  const p = m && m.pricePerMTok
  if (!p) return null
  const entrada = Number(p.input)
  const salida = Number(p.output)
  if (!Number.isFinite(entrada) || !Number.isFinite(salida)) return null
  if (entrada < 0 || salida < 0) return null
  if (entrada === 0 && salida === 0) return null
  return {
    entrada: Math.ceil(entrada * 1_000_000),
    salida: Math.ceil(salida * 1_000_000)
  }
}

// El OPT-IN de D19: mandarle el prompt a un tercero es una decision del
// operador y tiene que ser explicita. Ausente significa APAGADO -- un archivo
// de config a medio escribir no puede terminar sacando prompts de la maquina.
export function optInDe(objeto) {
  return !!(objeto && objeto.optIn === true)
}

// Revender la API de un tercero a la red es OTRA decision, y tambien apagada
// por default. Todavia no la consume nadie: se lee aca para que el dia que se
// cablee el broker el default seguro ya este escrito donde corresponde.
export function brokerDe(objeto) {
  return !!(objeto && objeto.brokerEnabled === true)
}

// -----------------------------------------------------------------------------
// El archivo
// -----------------------------------------------------------------------------

// `<storage>/upstreams.json`, el mismo directorio donde ya viven budget.json e
// identity.json. NO se lee del repo: la config lleva el nombre de la variable
// con la credencial y la lista de proveedores de esta persona.
//
// Que el archivo no exista es el caso NORMAL, no un error: la enorme mayoria
// de los nodos no habla con ninguna API externa. Se devuelve la config vacia y
// nadie se entera. Un archivo que existe pero esta roto SI se avisa, porque
// ahi alguien quiso configurar algo y no le funciono.
export async function leerConfig(dir) {
  const vacia = { upstreams: [], optIn: false, brokerEnabled: false, error: null }
  if (!dir) return vacia

  let crudo = null
  try {
    const fs = await import('bare-fs')
    const path = await import('bare-path')
    crudo = fs.default.readFileSync(path.default.join(dir, 'upstreams.json'), 'utf8')
  } catch {
    return vacia
  }

  let objeto = null
  try {
    objeto = JSON.parse(crudo)
  } catch (err) {
    return { ...vacia, error: 'upstreams.json no es JSON valido: ' + ((err && err.message) || err) }
  }

  return {
    upstreams: cargarDesde(objeto),
    optIn: optInDe(objeto),
    brokerEnabled: brokerDe(objeto),
    error: null
  }
}
