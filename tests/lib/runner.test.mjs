// tests/lib/runner.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunner } from '../../scripts/lib/runner.mjs'

test('counts passes, fails and warnings and prints failures', async () => {
  const lines = []
  const r = createRunner(l => lines.push(l))
  await r.check('good', () => {})
  await r.check('bad', () => { throw new Error('line one\nline two') })
  await r.check('bad async', async () => { throw new Error('later') })
  r.warn('careful')
  assert.deepEqual(r.summary(), { passes: 1, fails: 2, warns: 1 })
  assert.equal(lines[0], 'FAIL bad\n     line one\n     line two')
  assert.equal(lines[2], 'WARN careful')
})
