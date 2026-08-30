// dependencyWaves(): level-based scheduling, isolated from any transport.
//
//   node test/split-waves-test.mjs

import assert from 'assert'
import { dependencyWaves } from '../orchestrator/split.mjs'

let ok = 0
let bad = 0
function check(name, fn) {
  try {
    fn()
    ok++
    console.log(`  ok  ${name}`)
  } catch (err) {
    bad++
    console.log(`  NO  ${name}\n      ${err.message}`)
  }
}

const t = (id, deps = []) => ({ id, deps, allowedFiles: [id + '.js'] })
const ids = (wave) => wave.map((x) => x.id).sort()

check('no dependencies at all: everything in one wave', () => {
  const waves = dependencyWaves([t('a'), t('b'), t('c')])
  assert.equal(waves.length, 1)
  assert.deepEqual(ids(waves[0]), ['a', 'b', 'c'])
})

check('a linear chain becomes one ticket per wave', () => {
  const waves = dependencyWaves([t('a'), t('b', ['a']), t('c', ['b'])])
  assert.equal(waves.length, 3)
  assert.deepEqual(ids(waves[0]), ['a'])
  assert.deepEqual(ids(waves[1]), ['b'])
  assert.deepEqual(ids(waves[2]), ['c'])
})

check('a diamond: two independent tickets share a wave, the join waits for both', () => {
  const waves = dependencyWaves([t('a'), t('b', ['a']), t('c', ['a']), t('d', ['b', 'c'])])
  assert.equal(waves.length, 3)
  assert.deepEqual(ids(waves[0]), ['a'])
  assert.deepEqual(ids(waves[1]), ['b', 'c'])
  assert.deepEqual(ids(waves[2]), ['d'])
})

check('a dependency already closed in an earlier run is not a typo — it is level -1', () => {
  // Only the PENDING ticket is passed in; 'a' already closed, per doneIds.
  const waves = dependencyWaves([t('b', ['a'])], { doneIds: new Set(['a']) })
  assert.equal(waves.length, 1)
  assert.deepEqual(ids(waves[0]), ['b'])
})

check('order within a wave does not matter for the shape of the schedule', () => {
  const waves = dependencyWaves([t('b', ['a']), t('a'), t('c', ['a'])])
  assert.equal(waves.length, 2)
  assert.deepEqual(ids(waves[0]), ['a'])
  assert.deepEqual(ids(waves[1]), ['b', 'c'])
})

check('a circular dependency throws instead of hanging', () => {
  assert.throws(() => dependencyWaves([t('a', ['b']), t('b', ['a'])]), /circular/)
})

check('an empty ticket list is zero waves, not one empty wave', () => {
  assert.deepEqual(dependencyWaves([]), [])
})

console.log(`\n${ok} ok, ${bad} failed`)
process.exitCode = bad === 0 ? 0 : 1
