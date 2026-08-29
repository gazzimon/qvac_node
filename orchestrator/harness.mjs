// Harness: los límites que hacen operable a un agente autónomo.
//
// Ninguno de estos controles se le confía al modelo. Un loop sin límite de
// pasos no es un bug, es una factura; un reintento sobre un error determinista
// gasta dos veces para fallar igual.

export const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])

export class LimitReached extends Error {
  constructor(kind, detail) {
    super(`límite alcanzado (${kind}): ${detail}`)
    this.kind = kind
  }
}

export class Harness {
  // Los defaults de timeout son para UNA INFERENCIA, no para una herramienta de
  // filesystem. Arrancaron en 30s, que es un numero razonable para leer un
  // archivo y absurdo para lo que esto hace: la primera request contra un
  // modelo nuevo paga la DESCARGA de los pesos (qwen4b son 2.3 GB) mas la carga
  // en RAM mas la generacion, todo en el mismo request, porque el gateway carga
  // el modelo de forma perezosa.
  //
  // 10 minutos por herramienta y 30 por tarea. Un timeout con estos numeros ya
  // no significa "es lento", significa "algo se colgo".
  constructor({
    maxSteps = 10,
    maxTokens = 8000,
    toolTimeoutMs = 600000,
    taskTimeoutMs = 1800000,
    maxRetries = 3,
    // Un timeout NO se reintenta tres veces. Con un techo de 10 minutos, tres
    // intentos son media hora pidiendole al nodo el mismo trabajo. Uno solo
    // tiene sentido -- el caso real es que el primero pago la descarga de los
    // pesos y el segundo los encuentra cacheados --; el cuarto no existe.
    maxRetriesTimeout = 1
  } = {}) {
    if (toolTimeoutMs >= taskTimeoutMs) {
      throw new Error('harness: el timeout por herramienta tiene que ser menor que el de la tarea')
    }
    this.maxSteps = maxSteps
    this.maxTokens = maxTokens
    this.toolTimeoutMs = toolTimeoutMs
    this.taskTimeoutMs = taskTimeoutMs
    this.maxRetries = maxRetries
    this.maxRetriesTimeout = maxRetriesTimeout

    this.steps = 0
    this.tokensUsed = 0
    this.tokensEstimados = 0
    this.fuentes = new Set()
    this.startedAt = Date.now()
    this.events = []
  }

  record(event) {
    const entry = { ts: new Date().toISOString(), ...event }
    this.events.push(entry)
    return entry
  }

  // Se chequea ANTES de gastar, no después: cortar tarde es cobrar de más.
  checkBudget() {
    if (this.steps >= this.maxSteps) {
      throw new LimitReached('steps', `${this.steps}/${this.maxSteps}`)
    }
    if (this.tokensUsed >= this.maxTokens) {
      throw new LimitReached('tokens', `${this.tokensUsed}/${this.maxTokens}`)
    }
    const elapsed = Date.now() - this.startedAt
    if (elapsed >= this.taskTimeoutMs) {
      throw new LimitReached('task-timeout', `${elapsed}ms/${this.taskTimeoutMs}ms`)
    }
  }

  // `tokensFuente` viaja con el numero y no se pierde: `proveedor` es lo que
  // conto el modelo, `gateway` es una estimacion nuestra por bytes. Un tope
  // calculado sobre estimaciones sigue siendo util, pero el resumen tiene que
  // decir cual de los dos es -- es la misma distincion que el rastro de ruteo
  // ya hace en este repo, y por el mismo motivo.
  spend({ tokens = 0, tokensFuente = null } = {}) {
    this.steps++
    this.tokensUsed += tokens
    if (tokensFuente === 'gateway') this.tokensEstimados += tokens
    if (tokensFuente) this.fuentes.add(tokensFuente)
  }

  remaining() {
    return {
      steps: Math.max(0, this.maxSteps - this.steps),
      tokens: Math.max(0, this.maxTokens - this.tokensUsed),
      ms: Math.max(0, this.taskTimeoutMs - (Date.now() - this.startedAt))
    }
  }

  // Un timeout por herramienta más chico que el de la tarea: una herramienta
  // colgada falla ella sola, no se lleva puesta la tarea entera.
  async runTool(name, fn) {
    this.checkBudget()
    const started = Date.now()

    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`tool ${name} timed out after ${this.toolTimeoutMs}ms`)),
        this.toolTimeoutMs
      )
    })

    try {
      const result = await Promise.race([fn(), timeout])
      this.record({ type: 'tool', name, ok: true, ms: Date.now() - started })
      return result
    } catch (err) {
      this.record({ type: 'tool', name, ok: false, error: err.message, ms: Date.now() - started })
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  // Backoff exponencial con jitter, SOLO para transitorios. Un 400 o un test
  // que falla no se reintenta: reintentar un error determinista es gastar dos
  // veces para fallar igual.
  //
  // Un timeout es transitorio pero tiene SU PROPIO techo de intentos, mas bajo:
  // un 503 es barato de reintentar, un timeout de 10 minutos no.
  async withRetry(label, fn) {
    let lastErr
    let intentos = 0

    while (true) {
      this.checkBudget()
      intentos++
      try {
        return await fn(intentos)
      } catch (err) {
        lastErr = err

        if (!isTransient(err)) {
          this.record({ type: 'retry', label, attempt: intentos, retried: false, error: err.message })
          throw err
        }

        const techo = esTimeout(err) ? this.maxRetriesTimeout + 1 : this.maxRetries
        if (intentos >= techo) {
          this.record({
            type: 'retry',
            label,
            attempt: intentos,
            retried: false,
            agotado: true,
            error: err.message
          })
          break
        }

        const delay = backoffMs(intentos)
        this.record({
          type: 'retry',
          label,
          attempt: intentos,
          retried: true,
          delay,
          error: err.message
        })
        await sleep(delay)
      }
    }

    throw lastErr
  }

  summary() {
    return {
      steps: this.steps,
      maxSteps: this.maxSteps,
      tokensUsed: this.tokensUsed,
      tokensEstimados: this.tokensEstimados,
      tokensFuentes: [...this.fuentes],
      maxTokens: this.maxTokens,
      elapsedMs: Date.now() - this.startedAt,
      events: this.events.length
    }
  }
}

// Un timeout NUESTRO: el que arma `runTool` al vencer `toolTimeoutMs`. Se
// distingue de un 503 porque cuesta muchísimo más reintentarlo.
export function esTimeout(err) {
  return !!err && /timed out after \d+ms/.test(err.message || '')
}

export function isTransient(err) {
  if (!err) return false
  if (typeof err.status === 'number') return TRANSIENT_STATUS.has(err.status)
  if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    return true
  }
  return /timed out|timeout|socket hang up|network/i.test(err.message || '')
}

function backoffMs(attempt) {
  const base = 500 * 2 ** (attempt - 1)
  return base + Math.floor(Math.random() * base)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
