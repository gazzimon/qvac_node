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
  constructor({
    maxSteps = 10,
    maxTokens = 8000,
    toolTimeoutMs = 30000,
    taskTimeoutMs = 300000,
    maxRetries = 3
  } = {}) {
    if (toolTimeoutMs >= taskTimeoutMs) {
      throw new Error('harness: el timeout por herramienta tiene que ser menor que el de la tarea')
    }
    this.maxSteps = maxSteps
    this.maxTokens = maxTokens
    this.toolTimeoutMs = toolTimeoutMs
    this.taskTimeoutMs = taskTimeoutMs
    this.maxRetries = maxRetries

    this.steps = 0
    this.tokensUsed = 0
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

  spend({ tokens = 0 } = {}) {
    this.steps++
    this.tokensUsed += tokens
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
  async withRetry(label, fn) {
    let lastErr

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      this.checkBudget()
      try {
        return await fn(attempt)
      } catch (err) {
        lastErr = err
        if (!isTransient(err)) {
          this.record({ type: 'retry', label, attempt, retried: false, error: err.message })
          throw err
        }
        if (attempt === this.maxRetries) break
        const delay = backoffMs(attempt)
        this.record({ type: 'retry', label, attempt, retried: true, delay, error: err.message })
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
      maxTokens: this.maxTokens,
      elapsedMs: Date.now() - this.startedAt,
      events: this.events.length
    }
  }
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
