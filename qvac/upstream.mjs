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
// Bare no tiene AbortController global -- no es el navegador ni Node-. El
// paquete es el mismo que usa bare-fetch por dentro para su `signal`, asi que
// esto no suma una dependencia nueva al arbol: la vuelve explicita.
import AbortController from 'bare-abort-controller'

const REINTENTOS = 3
const ESPERA_BASE_MS = 400

// Hasta el primer byte del proveedor. No es el mismo numero que el del camino
// P2P (120s): un par puede estar cargando 807 MB de pesos por primera vez, una
// API de internet no. El techo sale de lo medido contra integrate.api.nvidia.com
// el 2026-08-25 -- llama-3.3-70b tardo 43,4 segundos al primer byte y se
// descarto por inservible-, asi que 60s deja pasar hasta lo que ya sabemos que
// es demasiado lento y corta lo que directamente no viene.
const PRIMER_CHUNK_TIMEOUT_MS = 60000

// Ya venian tokens y se cortaron sin cerrar el stream. Un socket TCP colgado no
// avisa: sin esto el request queda abierto para siempre y, con el, la reserva
// del presupuesto que lo autorizo.
const IDLE_TIMEOUT_MS = 30000

// Techo de salida cuando ni la config ni el cliente dicen otra cosa. 1024 son
// ~4 parrafos: alcanza para una respuesta de chat y acota el peor caso de la
// reserva a un numero que se puede mirar sin susto.
const MAX_TOKENS_DEFAULT = 1024

function enteroPositivo(v, porDefecto) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto
}

function esReintentable(status) {
  return status === 429 || (status >= 500 && status < 600)
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Los nombres de header de HTTP NO distinguen mayusculas; un objeto de
// JavaScript SI. Esa diferencia era un agujero (B11): un `authorization` en
// minuscula escrito en la config no colisionaba con el `Authorization` que
// escribe el codigo, asi que sobrevivian LOS DOS y bare-fetch los mandaba
// concatenados --
//
//     authorization = Bearer <la-de-otro-proveedor>, Bearer <la-nuestra>
//
// --, o sea la credencial de un proveedor viajando al endpoint de otro. Con
// `content-type` pasaba lo mismo y el cuerpo JSON salia anunciado como
// text/plain.
//
// Se normaliza todo a minuscula al ENTRAR, y entonces la colision la resuelve
// el objeto: lo que escribe el codigo pisa lo que diga el archivo porque son la
// misma clave. No hay lista de nombres reservados, que es lo que despues hay
// que acordarse de mantener.
function enMinuscula(crudos) {
  const out = {}
  for (const [nombre, valor] of Object.entries(crudos || {})) {
    out[String(nombre).toLowerCase()] = valor
  }
  return out
}

export class Upstream {
  constructor({
    id,
    label,
    baseUrl,
    apiKeyEnv,
    model,
    anunciadoComo = null,
    displayName,
    tags = [],
    maxConcurrent = 4,
    maxTokens = MAX_TOKENS_DEFAULT,
    precio = null,
    esLocal = false,
    timeoutPrimerChunkMs = PRIMER_CHUNK_TIMEOUT_MS,
    timeoutIdleMs = IDLE_TIMEOUT_MS,
    extraBody = null,
    extraHeaders = null
  }) {
    this.id = id
    this.label = label || id
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.apiKeyEnv = apiKeyEnv
    this.model = model
    // COMO LO LLAMA EL PROVEEDOR vs COMO LO ANUNCIA ESTA RED. Son dos cosas y
    // hasta ahora eran una sola.
    //
    // El mismo modelo tiene un nombre distinto en cada puerta: NVIDIA lo llama
    // `nvidia/nemotron-3.5-lightning-30b-a3b` y OpenRouter
    // `nvidia/nemotron-3.5-lightning`. Con un solo campo, dos proveedores del
    // MISMO modelo entran al registro como dos modelos distintos y no compiten
    // nunca -- findAllByModelId filtra por nombre exacto, asi que el ruteo por
    // carga, el desempate y la degradacion por presupuesto no se ejercen jamas.
    //
    // `anunciadoComo` es el nombre con el que la fila entra al marketplace;
    // `model` es el string que viaja en el body al proveedor. Sin declararlo,
    // son el mismo y todo se comporta como antes.
    this.anunciadoComo = anunciadoComo || model
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
    this.maxTokens =
      Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : MAX_TOKENS_DEFAULT
    // { entrada, salida } en micro-dolares por 1M de tokens, o null si el
    // operador no lo declaro. Sin precio no hay reserva posible: quien
    // registra decide si eso deja al upstream afuera (bin.mjs lo deja).
    this.precio = precio
    // Un endpoint que corre en ESTA maquina: llama-server, vLLM o un NIM
    // self-hosted, hablando OpenAI en localhost. Es un upstream por como se le
    // pide -- HTTP, no el motor embebido-- y NO es un tercero por donde va el
    // prompt: no sale de la maquina, no lo ve nadie, no cuesta dolares.
    //
    // Esa diferencia no es cosmetica: decide si le aplican el opt-in, el
    // filtro de `local: true` y la condicion de "sin capacidad local" de D19.
    // A las tres les aplica que NO.
    this.esLocal = esLocal === true
    // Los dos relojes salen de la config para que un modelo lento se pueda
    // acomodar sin tocar el codigo -- y para que los tests los puedan ejercitar
    // sin esperar un minuto. Un valor invalido cae al default: nunca a cero,
    // que seria un timeout que dispara antes de empezar.
    this.timeoutPrimerChunkMs = enteroPositivo(timeoutPrimerChunkMs, PRIMER_CHUNK_TIMEOUT_MS)
    this.timeoutIdleMs = enteroPositivo(timeoutIdleMs, IDLE_TIMEOUT_MS)
    // Algunos modelos piden campos fuera del estandar de OpenAI (por ejemplo
    // chat_template_kwargs.enable_thinking). Viven en la config y no en el
    // codigo: son del modelo, no nuestros.
    this.extraBody = extraBody
    // Headers extra del proveedor. OpenRouter, por ejemplo, usa HTTP-Referer y
    // X-Title para atribuir el trafico a una app. Van en la config y no en el
    // codigo por la misma razon que extraBody: son del proveedor, no nuestros.
    //
    // Se guardan YA normalizados a minuscula, y eso es lo que hace cierta la
    // garantia de abajo: `authorization` y `content-type` no se pueden pisar
    // desde el archivo ESCRIBANSE COMO SE ESCRIBAN. Ver #headers.
    this.extraHeaders = extraHeaders ? enMinuscula(extraHeaders) : null
  }

  // La credencial se lee de una VARIABLE DE ENTORNO cuyo NOMBRE esta en la
  // config. En el repo queda el nombre; el secreto no toca el disco, y sobre
  // todo no entra al manifiesto firmado que se le anuncia a la red.
  get apiKey() {
    return env[this.apiKeyEnv] || null
  }

  disponible() {
    // Un endpoint local no lleva credencial: pedirle una lo dejaria apagado
    // para siempre. Lo que lo hace usable es que este levantado, y eso se sabe
    // recien al pedirle algo.
    return this.esLocal || !!this.apiKey
  }

  // Genera deltas de texto. MISMA forma que engine.complete(), a proposito:
  // el provider y el gateway consumen los dos con el mismo `for await`, asi
  // que cancelacion, timeouts y conteo de tokens siguen funcionando sin
  // cambios.
  // `signal` lo manda el gateway cuando el cliente se va. Los timeouts son de
  // acá: son del protocolo con el proveedor, no del cliente, y el gateway no
  // tiene por que saber cuanto tarda una API que no eligio.
  async *completar({ messages, maxTokens = 0, signal = null, onUsage = null }) {
    // Un solo controlador para las tres formas de cortar -- el cliente se fue,
    // el proveedor no arranco, el proveedor se colgo a mitad-: la que dispare
    // primero aborta el fetch, y el `motivo` dice cual fue. Sin esto el error
    // que ve el operador es un AbortError pelado, que no distingue "cerraste la
    // pestana" de "la API se murio".
    const ctl = new AbortController()
    let motivo = null
    let temporizador = null

    const cortar = (porque) => {
      if (motivo) return
      motivo = porque
      ctl.abort()
    }

    const armar = (ms, porque) => {
      clearTimeout(temporizador)
      temporizador = setTimeout(() => cortar(porque), ms)
      temporizador.unref?.()
    }

    if (signal) {
      if (signal.aborted) cortar('el cliente cerro la conexion')
      else
        signal.addEventListener('abort', () => cortar('el cliente cerro la conexion'), {
          once: true
        })
    }

    try {
      yield* this.#completar({ messages, maxTokens, onUsage, ctl, armar, motivoDe: () => motivo })
    } finally {
      clearTimeout(temporizador)
      // Si el consumidor corta el `for await` -- un `break`, o una excepcion mas
      // arriba-, el generador se cierra por acá y el fetch tiene que morir con
      // el. Sin este abort el proveedor sigue generando y facturando para un
      // stream que ya no lee nadie.
      cortar('el consumidor dejo de leer')
    }
  }

  // Los de la config PRIMERO y los nuestros despues: `authorization` no se
  // puede pisar desde un archivo -- seria mandarle la credencial de un
  // proveedor a otro-- y `content-type` tampoco, porque el cuerpo es JSON
  // aunque alguien escriba otra cosa.
  //
  // Todo en minuscula, de los dos lados. Ese detalle es el arreglo entero de
  // B11: el constructor ya bajo a minuscula lo que vino del archivo, asi que
  // estas tres lineas colisionan con el nombre que sea que alguien haya escrito
  // y lo pisan. Escritas en `Content-Type`/`Authorization` NO pisaban nada --
  // convivian con la version en minuscula y viajaban las dos.
  #headers(key) {
    const h = { ...(this.extraHeaders || {}) }
    h['content-type'] = 'application/json'
    if (key) h.authorization = 'Bearer ' + key
    else delete h.authorization
    return h
  }

  async *#completar({ messages, maxTokens, onUsage, ctl, armar, motivoDe }) {
    // El menor entre lo que pidio el cliente y lo que este nodo permite. Un
    // cliente puede pedir MENOS que el tope; no puede pedir mas.
    const tope = maxTokens > 0 ? Math.min(maxTokens, this.maxTokens) : this.maxTokens
    const key = this.apiKey
    if (!key && !this.esLocal) {
      throw new Error('falta la credencial: pone la variable de entorno ' + this.apiKeyEnv)
    }

    const mod = await import('bare-fetch')
    const fetch = mod.default || mod.fetch || mod

    // El orden importa y antes estaba al reves: `extraBody` iba ULTIMO, asi que
    // un `max_tokens` escrito en la config pisaba el tope del nodo -- el unico
    // numero con el que se calculo la reserva-, y un `stream: false` rompia el
    // parser de SSE sin decir por que. Lo que el nodo necesita para acotar el
    // gasto y para entender la respuesta va DESPUES: la config extiende, no
    // sobreescribe.
    const extra = { ...(this.extraBody || {}) }

    // `usage` en streaming es OPCIONAL en el protocolo de OpenAI: sin pedirlo,
    // la enorme mayoria de los proveedores no lo manda. Y sin `usage` la
    // liquidacion se queda sin los tokens reales -- sobre todo los de entrada,
    // que de este lado no hay forma de contar-. Lo pide el CODIGO y no la
    // config: era un campo de un archivo que se podia olvidar, y olvidarlo
    // salia barato en la factura y caro en el tope.
    const streamOptions = { ...(extra.stream_options || {}), include_usage: true }
    delete extra.stream_options

    const body = {
      ...extra,
      model: this.model,
      messages,
      stream: true,
      stream_options: streamOptions,
      max_tokens: tope
    }

    let res = null
    armar(
      this.timeoutPrimerChunkMs,
      `el proveedor no contesto en ${this.timeoutPrimerChunkMs / 1000}s`
    )

    for (let intento = 0; intento < REINTENTOS; intento++) {
      if (intento > 0) {
        const espera = ESPERA_BASE_MS * Math.pow(2, intento - 1) * (0.5 + Math.random())
        await esperar(espera)
      }
      try {
        res = await fetch(this.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: this.#headers(key),
          body: JSON.stringify(body),
          signal: ctl.signal
        })
      } catch (err) {
        res = null
        // Un corte nuestro NO es un fallo de red: reintentar seria volver a
        // pedirle al proveedor algo que ya decidimos no querer -- y pagarlo.
        const porque = motivoDe()
        if (porque) throw new Error('se corto el pedido al proveedor: ' + porque)
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
      const porque = motivoDe()
      if (porque) throw new Error('se corto el stream del proveedor: ' + porque)

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

          // B15 -- un 200 NO quiere decir que salio bien.
          //
          // El status llega con los headers, o sea antes de que el modelo
          // genere un solo token. Todo lo que se rompe despues -- el proveedor
          // de atras que se cae, la cuota que se agota a mitad, un filtro de
          // contenido -- no puede viajar como status porque ya se mando: viaja
          // como un objeto `error` adentro del cuerpo. OpenRouter lo hace, y
          // aca no se miraba.
          //
          // Sin esto el error se descartaba como cualquier evento desconocido:
          // el generador terminaba normal, el gateway lo leia como `ok: true`,
          // cortaba el recorrido de candidatos SIN probar el siguiente, y el
          // cliente recibia una respuesta exitosa y vacia. La falla mas cara de
          // todas: la que se ve igual que funcionar.
          //
          // Se tira, que es lo que hace que el gateway lo trate como un
          // candidato caido y siga con el que sigue. El detalle del proveedor
          // va al log de ESTE proceso y no al cliente, igual que en la rama de
          // los status: puede traer el nombre de la cuenta o el id interno.
          if (ev.error) {
            const detalle =
              (ev.error && (ev.error.message || ev.error.code)) || JSON.stringify(ev.error)
            console.error(
              '[upstream:' + this.id + '] error EN EL STREAM: ' + String(detalle).slice(0, 300)
            )
            // El codigo se conserva en el mensaje porque el gateway lee un 429
            // de ahi para tratarlo como saturacion en vez de como request roto.
            const codigo = ev.error && ev.error.code
            throw new Error(
              'el proveedor externo corto la respuesta' + (codigo ? ' (' + codigo + ')' : '')
            )
          }

          // El usage viaja en el ultimo chunk cuando el proveedor lo manda.
          if (ev.usage) usage = ev.usage

          const delta = ev.choices && ev.choices[0] && ev.choices[0].delta
          if (!delta) continue

          // SOLO content. `reasoning_content` se ignora sin excepcion: es el
          // pensamiento del modelo y delata al proveedor.
          if (typeof delta.content === 'string' && delta.content !== '') {
            // Cada token que llega prueba que el proveedor sigue vivo, asi que
            // el reloj se corre. Lo que se acota de acá en mas es el SILENCIO
            // entre tokens, no cuanto dura la respuesta entera: una respuesta
            // larga que fluye es legitima, treinta segundos sin nada no.
            armar(
              this.timeoutIdleMs,
              `el proveedor dejo de mandar tokens por ${this.timeoutIdleMs / 1000}s`
            )
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
    // `apiKeyEnv` deja de ser obligatorio SOLO para un proveedor local: es el
    // unico que no lleva credencial. Para uno remoto sigue siendo obligatorio,
    // porque un upstream sin nombre de variable no puede autenticarse y el
    // fallo saldria recien en el primer prompt.
    const esLocal = u && u.local === true
    if (!u || !u.id || !u.baseUrl) continue
    if (!esLocal && !u.apiKeyEnv) continue
    for (const m of u.models || []) {
      if (!m || !m.modelId) continue
      out.push(
        new Upstream({
          id: u.id + ':' + m.modelId,
          label: u.label || u.id,
          baseUrl: u.baseUrl,
          apiKeyEnv: u.apiKeyEnv,
          model: m.modelId,
          anunciadoComo: typeof m.as === 'string' && m.as !== '' ? m.as : null,
          displayName: m.displayName || m.modelId,
          tags: m.tags || [],
          maxConcurrent: Number.isFinite(m.maxConcurrent) ? m.maxConcurrent : 4,
          maxTokens: Number(m.maxTokens),
          precio: precioDe(m),
          esLocal,
          timeoutPrimerChunkMs: m.timeoutPrimerChunkMs,
          timeoutIdleMs: m.timeoutIdleMs,
          extraBody: m.extraBody || null,
          extraHeaders: u.extraHeaders || null
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
