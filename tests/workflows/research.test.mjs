// tests/workflows/research.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../helpers.mjs'

const R = load('research.js')
const REPORT = { summary: 's', facts: [], open_questions: ['q'] }
const VERDICT = { confirmed_facts: [], verified_ideas: [], verified_risks: [], refuted: [], unverifiable: [], corrected_summary: 'c' }

test('a lane without a report or a verdict is listed as unverified', async () => {
  const { result } = await R.run({ question: 'q', scratch: '/tmp/s' }, (p, o) =>
    o.label === 'research:ecosystem' ? null
      : o.label === 'verify:fit' ? null
        : o.label.startsWith('research:') ? REPORT : VERDICT)
  assert.deepEqual([...result.unverified_lanes].sort(), ['ecosystem', 'fit'])
  assert.equal(result.lanes.find(l => l.lane === 'primary').corrected_summary, 'c')
})

test('rejects a relative scratch directory', async () => {
  await assert.rejects(R.run({ question: 'q', scratch: 'rel' }))
})

test('rejects a model outside opus, sonnet and haiku, such as fable', async () => {
  await assert.rejects(R.run({ question: 'q', scratch: '/tmp/s', model: 'fable' }), /args\.model must be opus, sonnet or haiku/)
})
