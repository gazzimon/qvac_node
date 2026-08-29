// Live progress for a generation in flight, for the terminal running `serve`.
//
// WHY THIS EXISTS
//
// A cold 4B model on CPU took 253 seconds to answer a single request, and for
// all 253 of them the server terminal said nothing at all. There is no way to
// tell a model that is thinking from a process that has hung, and the honest
// answer to "is it working?" was "wait and see".
//
// So: one line every few seconds with what is actually measurable.
//
// WHAT IT REPORTS, AND WHAT IT REFUSES TO
//
// Bytes and CHUNKS. Not tokens. A chunk is one delta the engine emitted, and a
// delta is not a token — the provider decides how it slices the stream, and
// this repo already draws that distinction elsewhere (`tokensFuente`:
// 'proveedor' means the model counted, 'gateway' means we counted deltas). A
// progress line that printed "tokens" would be inventing a number, so it does
// not.
//
// TTFT is real and is the number that matters most here: it separates "loading
// the model" from "generating slowly".
//
// THE WORD PAIRS
//
// The wait is dead time, so it carries an English/Spanish pair from the domain
// this repo lives in — distributed systems, git, testing. Purely decorative:
// nothing reads them and removing the list changes no behaviour.

// 50 pairs, picked from the vocabulary of this codebase rather than at random.
export const WORD_PAIRS = [
  ['peer', 'par'],
  ['gateway', 'puerta de enlace'],
  ['swarm', 'enjambre'],
  ['ledger', 'libro contable'],
  ['receipt', 'recibo'],
  ['settlement', 'liquidación'],
  ['manifest', 'manifiesto'],
  ['signature', 'firma'],
  ['keypair', 'par de claves'],
  ['seed', 'semilla'],
  ['wallet', 'billetera'],
  ['throughput', 'rendimiento'],
  ['latency', 'latencia'],
  ['bottleneck', 'cuello de botella'],
  ['deadlock', 'interbloqueo'],
  ['jail', 'jaula'],
  ['sandbox', 'entorno aislado'],
  ['allowlist', 'lista blanca'],
  ['scope', 'alcance'],
  ['breach', 'brecha'],
  ['tampering', 'manipulación'],
  ['warning', 'advertencia'],
  ['constraint', 'restricción'],
  ['trade-off', 'compromiso'],
  ['workaround', 'solución provisoria'],
  ['rollback', 'reversión'],
  ['branch', 'rama'],
  ['merge', 'fusión'],
  ['commit', 'confirmación'],
  ['staging', 'preparación'],
  ['pull request', 'solicitud de incorporación'],
  ['issue', 'incidencia'],
  ['queue', 'cola'],
  ['backlog', 'trabajo pendiente'],
  ['deadline', 'plazo'],
  ['milestone', 'hito'],
  ['scaffolding', 'andamiaje'],
  ['boilerplate', 'código repetitivo'],
  ['edge case', 'caso límite'],
  ['fixture', 'caso de prueba'],
  ['assertion', 'aserción'],
  ['coverage', 'cobertura'],
  ['flaky', 'inestable'],
  ['stale', 'obsoleto'],
  ['idempotent', 'idempotente'],
  ['retry', 'reintento'],
  ['backoff', 'espera creciente'],
  ['timeout', 'tiempo de espera'],
  ['cap', 'tope'],
  ['budget', 'presupuesto']
]

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export class InferenceProgress {
  // `everyMs` is 5s and not 1s deliberately: this writes whole lines rather
  // than rewriting one in place, because `serve` output is as often piped to a
  // log or a systemd journal as it is watched in a terminal, and carriage
  // returns turn a log file into a single unreadable line.
  constructor({ model, node, everyMs = 5000, log = console.log, now = Date.now } = {}) {
    this.model = model || 'unknown'
    this.node = node || ''
    this.everyMs = everyMs
    this.logFn = log
    this.now = now

    this.startedAt = this.now()
    this.firstChunkAt = null
    this.bytes = 0
    this.chunks = 0
    this.wordIndex = Math.floor(Math.random() * WORD_PAIRS.length)
    this.timer = null
    this.printed = 0
  }

  ttftMs() {
    return this.firstChunkAt === null ? null : this.firstChunkAt - this.startedAt
  }

  elapsedMs() {
    return this.now() - this.startedAt
  }

  nextWord() {
    const pair = WORD_PAIRS[this.wordIndex % WORD_PAIRS.length]
    this.wordIndex++
    return pair
  }

  // Built as a string rather than printed so it can be asserted in a test
  // without capturing stdout.
  line() {
    const secs = (this.elapsedMs() / 1000).toFixed(0)
    const [en, es] = this.nextWord()

    if (this.firstChunkAt === null) {
      return `  [infer] ${this.model} · ${secs}s · loading or thinking, nothing emitted yet · ${en} — ${es}`
    }

    const ttft = (this.ttftMs() / 1000).toFixed(1)
    return (
      `  [infer] ${this.model} · ${secs}s · ${formatBytes(this.bytes)} · ` +
      `${this.chunks} chunks · TTFT ${ttft}s · ${en} — ${es}`
    )
  }

  start() {
    if (this.timer) return this
    this.timer = setInterval(() => {
      this.printed++
      this.logFn(this.line())
    }, this.everyMs)
    // Under Node this must not hold the process open; under Bare there is no
    // `unref` on the timer, hence the guard.
    if (typeof this.timer.unref === 'function') this.timer.unref()
    return this
  }

  chunk(delta) {
    if (this.firstChunkAt === null) this.firstChunkAt = this.now()
    this.chunks++
    this.bytes += typeof delta === 'string' ? Buffer.byteLength(delta) : 0
  }

  // Printed only if the request lasted long enough to have said anything: a
  // 200ms answer does not need a summary, and printing one for every request
  // would drown the log that made this useful in the first place.
  done(reason = 'done') {
    this.stop()
    if (this.printed === 0) return null

    const secs = this.elapsedMs() / 1000
    const ttft = this.ttftMs() === null ? 'never' : (this.ttftMs() / 1000).toFixed(1) + 's'
    const rate = secs > 0 ? (this.bytes / secs).toFixed(0) : '0'
    const line =
      `  [infer] ${reason} · ${secs.toFixed(1)}s · ${formatBytes(this.bytes)} · ` +
      `${this.chunks} chunks · ${rate} B/s · TTFT ${ttft}`
    this.logFn(line)
    return line
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
