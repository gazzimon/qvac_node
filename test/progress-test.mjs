// Tests for the live inference progress line.
//
//   node test/progress-test.mjs

import assert from 'assert'
import { InferenceProgress, WORD_PAIRS, formatBytes } from '../qvac/progress.mjs'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`  NO  ${name}\n      ${err.message}`)
  }
}

// A fake clock, so nothing here waits on real time.
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

console.log('\nword pairs')

test('there are 50 of them', () => {
  assert.equal(WORD_PAIRS.length, 50)
})

test('every pair has both languages and no blanks', () => {
  for (const [en, es] of WORD_PAIRS) {
    assert.ok(en && en.trim(), 'empty English side')
    assert.ok(es && es.trim(), `empty Spanish side for "${en}"`)
    assert.notEqual(en, es, `"${en}" is the same in both columns`)
  }
})

test('no duplicates on the English side', () => {
  const seen = new Set(WORD_PAIRS.map(([en]) => en))
  assert.equal(seen.size, WORD_PAIRS.length, 'there is a repeated English word')
})

test('the pairs rotate and wrap around', () => {
  const p = new InferenceProgress({ model: 'm' })
  p.wordIndex = 0
  const first = p.nextWord()
  for (let i = 1; i < WORD_PAIRS.length; i++) p.nextWord()
  assert.deepEqual(p.nextWord(), first, 'after a full lap it starts again')
})

console.log('\nformatting')

test('bytes are shown in a readable unit', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})

console.log('\nprogress line')

test('before the first chunk it says nothing has been emitted', () => {
  const clock = fakeClock()
  const p = new InferenceProgress({ model: 'qwen4b', now: clock.now })
  clock.advance(12000)
  const line = p.line()
  assert.match(line, /qwen4b/)
  assert.match(line, /12s/)
  assert.match(line, /nothing emitted yet/)
  assert.ok(!/TTFT/.test(line), 'there is no TTFT before the first chunk')
})

test('after the first chunk it reports TTFT, bytes and chunks', () => {
  const clock = fakeClock()
  const p = new InferenceProgress({ model: 'qwen4b', now: clock.now })
  clock.advance(3100)
  p.chunk('hello')
  clock.advance(900)
  p.chunk(' world')

  const line = p.line()
  assert.match(line, /TTFT 3\.1s/)
  assert.match(line, /2 chunks/)
  assert.match(line, /11 B/)
})

// The repo is explicit elsewhere that an SSE delta is not a token. A progress
// line that said "tokens" would be inventing a number the gateway does not have.
test('it never claims to be counting tokens', () => {
  const clock = fakeClock()
  const p = new InferenceProgress({ model: 'm', now: clock.now })
  p.chunk('x')
  clock.advance(1000)
  assert.ok(!/token/i.test(p.line()), 'the line must not say "tokens"')
  const summary = p.done()
  if (summary) assert.ok(!/token/i.test(summary))
})

test('each line carries a word pair', () => {
  const clock = fakeClock()
  const p = new InferenceProgress({ model: 'm', now: clock.now })
  p.wordIndex = 0
  const [en, es] = WORD_PAIRS[0]
  assert.ok(p.line().includes(`${en} — ${es}`))
})

console.log('\nsummary')

test('a request too short to have printed gets no summary', () => {
  const p = new InferenceProgress({ model: 'm', now: fakeClock().now })
  p.chunk('hi')
  assert.equal(p.done(), null, 'nothing was printed, so there is nothing to close')
})

test('a long request is summarised with its rate', () => {
  const clock = fakeClock()
  const lines = []
  const p = new InferenceProgress({ model: 'm', now: clock.now, log: (l) => lines.push(l) })

  clock.advance(2000)
  p.chunk('a'.repeat(100))
  p.printed = 1 // as if the interval had already fired
  clock.advance(8000)

  const summary = p.done()
  assert.match(summary, /done/)
  assert.match(summary, /10\.0s/)
  assert.match(summary, /TTFT 2\.0s/)
  assert.match(summary, /B\/s/)
})

test('a generation that never emitted reports TTFT as never', () => {
  const clock = fakeClock()
  const p = new InferenceProgress({ model: 'm', now: clock.now, log: () => {} })
  p.printed = 1
  clock.advance(253000)
  assert.match(p.done('failed'), /TTFT never/)
})

console.log('\ntimer')

test('stop() is idempotent and leaves no timer behind', () => {
  const p = new InferenceProgress({ model: 'm', everyMs: 10, log: () => {} })
  p.start()
  assert.ok(p.timer, 'start() has to arm the timer')
  p.stop()
  p.stop()
  assert.equal(p.timer, null)
})

test('start() twice does not arm two timers', () => {
  const p = new InferenceProgress({ model: 'm', everyMs: 10, log: () => {} })
  p.start()
  const first = p.timer
  p.start()
  assert.equal(p.timer, first)
  p.stop()
})

console.log(`\n${passed} ok, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
