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

const ok = (p, o) => (o.label.startsWith('research:') ? REPORT : VERDICT)

test('a lane whose agent or fact-checker throws stays listed as unverified; a failed fact-check keeps its open questions', async () => {
  const { result, logs } = await R.run({ question: 'q', scratch: '/tmp/s' }, (p, o) => {
    if (o.label === 'research:ecosystem' || o.label === 'verify:fit') throw new Error('budget exhausted')
    return ok(p, o)
  })
  assert.deepEqual(result.lanes.map(l => [l.lane, l.verified]), [['primary', true], ['ecosystem', false], ['alternatives', true], ['fit', false]])
  assert.deepEqual([...result.unverified_lanes].sort(), ['ecosystem', 'fit'])
  assert.deepEqual(result.lanes.find(l => l.lane === 'fit').open_questions, ['q'])
  assert.ok(logs.some(l => /research:ecosystem/.test(l) && /budget exhausted/.test(l)), logs.join('\n'))
  assert.ok(logs.some(l => /verify:fit/.test(l) && /budget exhausted/.test(l)), logs.join('\n'))
})

test('lanes run on sonnet at high and fact-checkers on opus at high; model and effort apply to lanes only', async () => {
  const opts = calls => calls.map(c => [c.opts.label.split(':')[0], c.opts.model, c.opts.effort])
  const uniq = xs => [...new Set(xs.map(x => JSON.stringify(x)))].map(x => JSON.parse(x))
  const d = await R.run({ question: 'q', scratch: '/tmp/s' }, ok)
  assert.deepEqual(uniq(opts(d.calls)).map(x => x.map(v => v ?? null)), [['research', 'sonnet', 'high'], ['verify', 'opus', 'high']])
  const o = await R.run({ question: 'q', scratch: '/tmp/s', model: 'opus', effort: 'medium' }, ok)
  assert.deepEqual(uniq(opts(o.calls)).map(x => x.map(v => v ?? null)), [['research', 'opus', 'medium'], ['verify', 'opus', 'high']])
})

test('rejects an effort outside low, medium, high, xhigh and max', async () => {
  await assert.rejects(R.run({ question: 'q', scratch: '/tmp/s', effort: 'ultra' }), /args\.effort must be one of low, medium, high, xhigh, max/)
})

test('lanes mix default keys and custom {key, prompt} lanes, and replace the default set', async () => {
  const { calls, result } = await R.run({ question: 'q', scratch: '/tmp/s', lanes: ['ecosystem', { key: 'primary-a', prompt: 'read A' }, { key: 'primary-b', prompt: 'read B' }] }, ok)
  const research = calls.filter(c => c.opts.label.startsWith('research:'))
  assert.deepEqual(research.map(c => c.opts.label), ['research:ecosystem', 'research:primary-a', 'research:primary-b'])
  assert.match(research[0].prompt, /Research real-world usage/)
  assert.match(research[1].prompt, /LANE "primary-a": read A/)
  assert.deepEqual(result.lanes.map(l => l.lane), ['ecosystem', 'primary-a', 'primary-b'])
})

test('refuses duplicate lane keys, unknown default keys and malformed lanes', async () => {
  const run = lanes => R.run({ question: 'q', scratch: '/tmp/s', lanes }, ok)
  await assert.rejects(run([{ key: 'primary', prompt: 'a' }, { key: 'primary', prompt: 'b' }]), /duplicate lane key "primary"/)
  await assert.rejects(run(['fit', { key: 'fit', prompt: 'x' }]), /duplicate lane key "fit"/)
  await assert.rejects(run(['nope']), /unknown default lane "nope"/)
  await assert.rejects(run([{ key: 'x' }]), /a default lane key or \{key, prompt\}/)
})

test('refuses an args.lanes that is not a non-empty array', async () => {
  for (const lanes of ['fit', { key: 'x', prompt: 'p' }, 42, []]) {
    await assert.rejects(R.run({ question: 'q', scratch: '/tmp/s', lanes }, ok), /args\.lanes must be a non-empty array/, JSON.stringify(lanes))
  }
})
