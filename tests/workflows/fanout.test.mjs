// tests/workflows/fanout.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../helpers.mjs'

const F = load('fanout.js')
const task = (id, files) => ({ id, brief: 'do it', files })
const rep = o => ({ done: 'd', files_touched: [], verification: [], skipped_flagged: [], judgment_calls: [], ...o })
const fan = async (tasks, reports) =>
  (await F.run({ repo: '/r', tasks }, (p, o) => reports[o.label.slice('exec:'.length)])).result

test('status precedence: out-of-scope > needs-decision > verify-failed > incomplete > ok; null report is no-report', async () => {
  const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => task(id, [`/r/${id}.js`]))
  const r = await fan(tasks, {
    a: rep({ files_touched: ['/r/a.js'] }),
    b: rep({ files_touched: ['/r/x.js'], judgment_calls: [{ question: 'q' }] }),
    c: rep({ judgment_calls: [{ question: 'q' }], verification: [{ cmd: 't', result: 'fail' }] }),
    d: rep({ verification: [{ cmd: 't', result: 'fail' }], skipped_flagged: [{ item: 'i', reason: 'r' }] }),
    e: rep({ skipped_flagged: [{ item: 'i', reason: 'r' }] }),
    f: null,
    g: rep({ files_touched: ['g.js', './g.js'] }),
  })
  const status = Object.fromEntries(r.results.map(x => [x.id, x.status]))
  assert.deepEqual(status, { a: 'ok', b: 'out-of-scope', c: 'needs-decision', d: 'verify-failed', e: 'incomplete', f: 'no-report', g: 'ok' })
})

test('rejects overlapping, relative and escaping file sets', async () => {
  await assert.rejects(fan([task('a', ['/r/x.js']), task('b', ['/r/./x.js'])], {}), /disjoint/)
  await assert.rejects(fan([task('a', ['x.js'])], {}), /absolute/)
  await assert.rejects(fan([task('a', ['/r/../etc/passwd'])], {}), /outside the repo/)
})
