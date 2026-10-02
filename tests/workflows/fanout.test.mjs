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

test('a worker whose agent() throws stays in the results as no-report, with the error, and is logged', async () => {
  const tasks = ['a', 'b', 'c'].map(id => task(id, [`/r/${id}.js`]))
  const { result, logs } = await F.run({ repo: '/r', tasks }, (p, o) => {
    if (o.label === 'exec:b') throw new Error('budget exhausted')
    return rep()
  })
  assert.deepEqual(result.results.map(x => [x.id, x.status]), [['a', 'ok'], ['b', 'no-report'], ['c', 'ok']])
  assert.match(result.results[1].error, /budget exhausted/)
  assert.equal(result.results[0].error, null)
  assert.deepEqual(result.summary, { ok: 2, 'no-report': 1 })
  assert.ok(logs.some(l => /exec:b/.test(l) && /budget exhausted/.test(l)), logs.join('\n'))
})

test('a worker that returns nothing is no-report with error null', async () => {
  const r = await fan([task('a', ['/r/a.js'])], { a: null })
  assert.deepEqual(r.results, [{ id: 'a', status: 'no-report', report: null, out_of_scope: [], error: null }])
})

test('task ids are unique, and 0 is a valid id', async () => {
  await assert.rejects(fan([task('a', ['/r/x.js']), task('a', ['/r/y.js'])], {}), /unique/)
  await assert.rejects(fan([task(1, ['/r/x.js']), task('1', ['/r/y.js'])], {}), /unique/)
  const r = await fan([task(0, ['/r/z.js'])], { 0: rep() })
  assert.deepEqual(r.results.map(x => [x.id, x.status]), [[0, 'ok']])
})

test('a path listed twice in one task counts once; directory entries are refused', async () => {
  const r = await fan([task('a', ['/r/x.js', '/r/./x.js'])], { a: rep({ files_touched: ['/r/x.js'] }) })
  assert.equal(r.results[0].status, 'ok')
  await assert.rejects(fan([task('a', ['/r/src/']), task('b', ['/r/src/a.js'])], {}), /directory/)
})

test('a report the contract check cannot read keeps its task, as no-report', async () => {
  const r = await fan([task('a', ['/r/a.js']), task('b', ['/r/b.js'])], { a: { done: 'd' }, b: rep() })
  assert.deepEqual(r.results.map(x => [x.id, x.status]), [['a', 'no-report'], ['b', 'ok']])
  assert.match(r.results[0].error, /contract check threw/)
  assert.deepEqual(r.summary, { 'no-report': 1, ok: 1 })
})

test('a path that contains another task\'s path is refused, however it is spelled', async () => {
  for (const dir of ['/r/src', '/r/src/.', '/r/src/sub/..']) {
    await assert.rejects(fan([task('a', [dir]), task('b', ['/r/src/a.js'])], {}), /contains/, dir)
    await assert.rejects(fan([task('b', ['/r/src/a.js']), task('a', [dir])], {}), /contains/, dir)
  }
  const r = await fan([task('a', ['/r/src.js']), task('b', ['/r/src/a.js'])], { a: rep(), b: rep() })
  assert.deepEqual(r.summary, { ok: 2 })
})

test('a task without an id is refused', async () => {
  for (const id of [undefined, null, '']) await assert.rejects(fan([task(id, ['/r/x.js'])], {}), /id, brief and a non-empty files\[\] are required/)
})
