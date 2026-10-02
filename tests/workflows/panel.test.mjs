// tests/workflows/panel.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../helpers.mjs'

const P = load('panel.js')
const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]
const V = rec => ({ recommendation: rec, confidence: 'high', reasons: [], rejected: [], load_bearing_assumptions: [], risks: [] })
const panel = (seatA, seatBRaw, normalized, extra = {}) =>
  P.run({ briefPath: '/tmp/b.md', options, ...extra }, (p, o) => {
    if (o.agentType === 'tech-lead:deep-reasoner') return typeof seatA === 'function' ? seatA(o) : seatA
    if (o.agentType === 'codex:codex-rescue') return seatBRaw
    return normalized
  })

for (const [a, b, n, want] of [
  [V('a'), 'long analysis', { empty: false, verdict: V('a') }, 'agree'],
  [V('a'), 'long analysis', { empty: false, verdict: V('b') }, 'disagree'],
  [V('other'), 'long analysis', { empty: false, verdict: V('other') }, 'disagree'],
  [V('a'), 'SEAT-EMPTY: codex not installed', null, 'single-seat'],
  [null, 'job 123 queued in background', { empty: true, empty_reason: 'job id' }, 'no-seats'],
]) {
  test(`agreement ${want}`, async () => {
    assert.equal((await panel(a, b, n)).result.agreement, want)
  })
}

test('seat A falls back from opus to sonnet at high and reports it', async () => {
  const { result, calls } = await panel(o => (o.model === 'opus' ? null : V('a')), '', null)
  assert.equal(result.seatA.fallback, true); assert.equal(result.seatA.model, 'sonnet'); assert.equal(result.seatA.effort, 'high')
  assert.equal(calls.filter(c => c.opts.agentType === 'tech-lead:deep-reasoner').length, 2)
})

test('no fallback off opus; a low seat effort carries to the fallback', async () => {
  assert.equal((await panel(null, '', null, { seatModel: 'sonnet' })).result.seatA.fallback, false)
  assert.equal((await panel(o => (o.model === 'opus' ? null : V('a')), '', null, { seatEffort: 'medium' })).result.seatA.effort, 'medium')
})

test('seat B prompt is --wait and read-only with reversed options; SEAT-EMPTY skips the normalizer', async () => {
  const { result, calls } = await panel(V('a'), 'SEAT-EMPTY: nope', null)
  const b = calls.find(c => c.opts.agentType === 'codex:codex-rescue').prompt
  assert.ok(b.startsWith('--wait')); assert.match(b, /Read-only/)
  assert.deepEqual(result.seatB.option_order, ['c', 'b', 'a'])
  assert.equal(calls.length, 2)
})

test('rejects bad args', async () => {
  await assert.rejects(P.run({ briefPath: 'rel.md', options }))
  await assert.rejects(P.run({ briefPath: '/b.md', options: [options[0]] }))
  await assert.rejects(P.run({ briefPath: '/b.md', options: [options[0], options[0]] }))
  await assert.rejects(P.run({ briefPath: '/b.md', options, seatEffort: 'ultra' }))
})

test('panel rejects a non-alias seat model such as fable', async () => {
  await assert.rejects(P.run({ briefPath: '/b.md', options, seatModel: 'fable' }), /seatModel must be opus or sonnet/)
})
