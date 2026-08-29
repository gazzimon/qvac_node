// The harness: the limits that make an autonomous agent operable.
//
// None of these controls is entrusted to the model. A loop with no step limit
// is not a bug, it is an invoice; and retrying a deterministic error spends
// twice to fail the same way.

export const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])

export class LimitReached extends Error {
  constructor(kind, detail) {
    super(`limit reached (${kind}): ${detail}`)
    this.kind = kind
  }
}

export class Harness {
  // The timeout defaults are for AN INFERENCE, not for a filesystem tool. They
  // started at 30s, which is reasonable for reading a file and absurd for what
  // this does: the first request against a fresh model pays for DOWNLOADING the
  // weights (qwen4b is 2.3 GB) plus loading them into RAM plus generation, all
  // inside the same request, because the gateway loads models lazily.
  //
  // Ten minutes per tool, thirty per task. With these numbers a timeout no
  // longer means "this is slow", it means "something hung".
  constructor({
    maxSteps = 10,
    maxTokens = 8000,
    toolTimeoutMs = 600000,
    taskTimeoutMs = 1800000,
    maxRetries = 3,
    // A timeout is NOT retried three times. With a ten-minute ceiling, three
    // attempts are half an hour asking the node for the same work. One retry
    // does make sense — the real case is that the first attempt paid for the
    // download and the second finds the weights cached; a fourth never does.
    maxRetriesTimeout = 1
  } = {}) {
    if (toolTimeoutMs >= taskTimeoutMs) {
      throw new Error('harness: the per-tool timeout must be smaller than the per-task one')
    }
    this.maxSteps = maxSteps
    this.maxTokens = maxTokens
    this.toolTimeoutMs = toolTimeoutMs
    this.taskTimeoutMs = taskTimeoutMs
    this.maxRetries = maxRetries
    this.maxRetriesTimeout = maxRetriesTimeout

    this.steps = 0
    this.tokensUsed = 0
    this.tokensEstimated = 0
    this.tokenSources = new Set()
    this.startedAt = Date.now()
    this.events = []
  }

  record(event) {
    const entry = { ts: new Date().toISOString(), ...event }
    this.events.push(entry)
    return entry
  }

  // Checked BEFORE spending, not after: cutting late is overcharging.
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

  // `tokenSource` travels with the number and is not lost: `provider` is what
  // the model counted, `gateway` is an estimate of ours computed from bytes. A
  // budget fed on estimates is still useful, but the summary has to say which
  // of the two it is — the same distinction the routing trace already draws in
  // this repo, and for the same reason.
  spend({ tokens = 0, tokenSource = null } = {}) {
    this.steps++
    this.tokensUsed += tokens
    if (tokenSource === 'gateway') this.tokensEstimated += tokens
    if (tokenSource) this.tokenSources.add(tokenSource)
  }

  remaining() {
    return {
      steps: Math.max(0, this.maxSteps - this.steps),
      tokens: Math.max(0, this.maxTokens - this.tokensUsed),
      ms: Math.max(0, this.taskTimeoutMs - (Date.now() - this.startedAt))
    }
  }

  // A per-tool timeout smaller than the task's: a hung tool fails on its own
  // instead of taking the whole task down with it.
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

  // Exponential backoff with jitter, ONLY for transient failures. A 400 or a
  // failing test is not retried: retrying a deterministic error spends twice to
  // fail the same way.
  //
  // A timeout is transient but gets ITS OWN, lower attempt ceiling: a 503 is
  // cheap to retry, a ten-minute timeout is not.
  async withRetry(label, fn) {
    let lastErr
    let attempts = 0

    while (true) {
      this.checkBudget()
      attempts++
      try {
        return await fn(attempts)
      } catch (err) {
        lastErr = err

        if (!isTransient(err)) {
          this.record({ type: 'retry', label, attempt: attempts, retried: false, error: err.message })
          throw err
        }

        const ceiling = isTimeout(err) ? this.maxRetriesTimeout + 1 : this.maxRetries
        if (attempts >= ceiling) {
          this.record({
            type: 'retry',
            label,
            attempt: attempts,
            retried: false,
            exhausted: true,
            error: err.message
          })
          break
        }

        const delay = backoffMs(attempts)
        this.record({
          type: 'retry',
          label,
          attempt: attempts,
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
      tokensEstimated: this.tokensEstimated,
      tokenSources: [...this.tokenSources],
      maxTokens: this.maxTokens,
      elapsedMs: Date.now() - this.startedAt,
      events: this.events.length
    }
  }
}

// One of OUR timeouts: the error `runTool` builds when `toolTimeoutMs` expires.
// Told apart from a 503 because it costs far more to retry.
export function isTimeout(err) {
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
