// tests/loop/readme-symlink-remedy.test.mjs
// README's remedy for a folder of the work area that became a symbolic link (the "clone invalid"
// row; Codex f2 #4, Claude gap-verify P3): the shell command the row gives is run exactly as
// written, with <path> the folder the detail names, on a work area whose patches/, run/ or
// out/<prefix> is a link to a folder holding the loop's own files. Every file behind the link
// is kept in a real folder (anchored recovery bundles, rules sidecars, run records and
// run/refs.json, delivery bundles and their sidecars), so the next firing's recovery planner and
// prepare go on with nothing reported missing. The row's detail texts are the helpers' own.
// Real repositories and processes, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { D2, PREFIX, T, appendLedger, attempt, check, cli, closeCli, firing, prepare, project, write } from './loop-clone-fixture.mjs'

const REFLEX = path.join(ROOT, 'scripts', 'reflex-bundle.mjs')
const RECOVER = path.join(ROOT, 'scripts', 'loop-recover.mjs')
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

// The README Troubleshooting row whose symptom starts with `symptom`, as [symptom, cause, fix].
function row(symptom) {
  const line = README.split('\n').find(l => l.startsWith(`| ${symptom}`))
  assert.ok(line, `README has no row "${symptom}"`)
  return line.slice(2, -2).split(' | ')
}
// The first code span of the "clone invalid" row's fix that is a command naming <path> (not
// the bare placeholder): the remedy.
const remedy = () => {
  const spans = [...row('The loop paused with "clone invalid"')[2].matchAll(/`([^`]+)`/g)].map(m => m[1])
  const cmd = spans.find(s => s.includes('<path>') && s !== '<path>')
  assert.ok(cmd, `the "clone invalid" row gives no command for <path>: ${JSON.stringify(spans)}`)
  return cmd
}
const q = s => `'${s.replace(/'/g, `'\\''`)}'`
// Runs the README command for the linked folder dir, with <stamp> filled in.
function followReadme(dir) {
  const cmd = remedy().replaceAll('<path>', q(dir)).replaceAll('<stamp>', '20261003')
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })
  assert.equal(r.status, 0, `${cmd}: ${r.stderr}`)
}

// Every entry below dir, recursively, with its bytes (files) or 'link -> target'.
function tree(dir, rel = '') {
  const out = []
  for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
    const r = path.join(rel, n)
    const st = fs.lstatSync(path.join(dir, r))
    if (st.isDirectory()) out.push([r, 'dir'], ...tree(dir, r))
    else if (st.isSymbolicLink()) out.push([r, `link -> ${fs.readlinkSync(path.join(dir, r))}`])
    else out.push([r, fs.readFileSync(path.join(dir, r)).toString('base64')])
  }
  return out
}
// Moves <V>/<rel> out of the work area and leaves a symlink to it in its place.
function linkAway(fx, rel) {
  const p = path.join(fx.V, rel)
  const target = path.join(fx.root, `elsewhere-${rel.replaceAll('/', '-')}`)
  fs.renameSync(p, target)
  fs.symlinkSync(target, p)
  return target
}
const node = (fx, script, args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: fx.env })
  let out = null
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* null */ }
  return { status: r.status, out, stderr: r.stderr }
}
const planner = fx => node(fx, RECOVER, [fx.P, '--generation', String(fx.N)])
const prepareRaw = (fx, date) => cli(fx.env, 'prepare', fx.P, '--generation', String(fx.N), '--prefix', PREFIX, '--base', 'main', '--date', date)

test('a patches/ link behind which a run record anchors a bundle: the README command keeps the bundle; the planner and prepare go on', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'b.txt', 'saved\n')
  const s = node(fx, REFLEX, ['save', fx.P, '--generation', String(fx.N), '--why', 'pause'])
  assert.equal(s.out?.state, 'saved', JSON.stringify(s))
  const target = linkAway(fx, 'patches')
  const kept = tree(target)
  assert.ok(kept.some(([n]) => n === `${s.out.sha}.patch`), JSON.stringify(kept))
  const reset = node(fx, REFLEX, ['reset', fx.P, '--generation', String(fx.N), '--sha', s.out.sha])
  assert.equal(reset.out?.state, 'clone-invalid', JSON.stringify(reset))
  const linked = path.join(fx.V, 'patches')
  assert.equal(reset.out.detail, `clone-invalid: ${linked} is a symlink, not a directory in ${fx.V}`)
  closeCli(fx)
  await firing(fx)
  // The planner reaches the bundle first: the "recovery planner" row's tampered detail.
  const halted = planner(fx)
  assert.equal(halted.status, 2, JSON.stringify(halted))
  assert.equal(halted.out.detail, `tampered: ${linked}/${s.out.sha}.patch (${linked} is a symlink, not a directory)`)
  followReadme(linked)
  assert.ok(fs.existsSync(linked), 'the README command leaves no patches/ folder: the anchored bundle is gone from its place')
  assert.ok(fs.lstatSync(linked).isDirectory(), 'patches/ is a real folder again')
  assert.deepEqual(tree(linked), kept, 'every file behind the link is kept')
  assert.deepEqual(tree(target), kept, 'what the link pointed to is left as it was')
  const plan = planner(fx)
  assert.equal(plan.status, 0, JSON.stringify(plan))
  const p = prepareRaw(fx, '2026-10-03')
  assert.equal(p.status, 0, p.stdout)
  assert.equal(p.out.state, 'ready', p.stdout)
  assert.equal(fs.readFileSync(path.join(fx.W, 'b.txt'), 'utf8'), 'b\n', 'the clone was reset from the saved work')
})

// Firing 1 commits and is ledgered, so its close writes run/refs.json and deletes 1.json;
// firing 2 prepares and checks (2.json, prepared). Firing 3 holds the lock.
async function twoFirings(fx) {
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  closeCli(fx)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  await firing(fx)
}

test('a run/ link holding the run records and run/refs.json: the README command keeps every one; prepare goes on', T, async t => {
  const fx = project(t)
  await twoFirings(fx)
  const target = linkAway(fx, 'run')
  const kept = tree(target)
  for (const name of ['2.json', 'refs.json']) assert.ok(kept.some(([n]) => n === name), JSON.stringify(kept.map(([n]) => n)))
  const linked = path.join(fx.V, 'run')
  const refused = prepareRaw(fx, D2)
  assert.equal(refused.out?.state, 'clone-invalid', refused.stdout)
  assert.equal(refused.out.detail, `clone-invalid: ${linked} is a symlink, not a directory in ${fx.V}`)
  followReadme(linked)
  assert.ok(fs.existsSync(linked), 'the README command leaves no run/ folder: the run records and refs.json are gone from their place')
  assert.ok(fs.lstatSync(linked).isDirectory())
  assert.deepEqual(tree(linked), kept, 'every run record and refs.json is kept')
  assert.equal(planner(fx).status, 0)
  const p = prepareRaw(fx, D2)
  assert.equal(p.out?.state, 'ready', p.stdout)
})

test('an out/<prefix> link holding a delivery bundle and its sidecar: the README command keeps both; bundle goes on', T, async t => {
  const fx = project(t)
  await twoFirings(fx)
  prepare(fx)
  const target = linkAway(fx, path.join('out', PREFIX))
  const kept = tree(target)
  assert.ok(kept.some(([n]) => n.endsWith('.bundle')) && kept.some(([n]) => n.endsWith('.json')), JSON.stringify(kept.map(([n]) => n)))
  const linked = path.join(fx.V, 'out', PREFIX)
  // A commit behind the link stands, its bundle not written (bundleError); bundle refuses.
  const a = attempt(fx, W => write(W, 'two.txt', '2\n'))
  assert.match(a.commit.bundleError ?? '', /is a symlink, not a directory in/, JSON.stringify(a.commit))
  const branch = a.commit.branch
  const refused = cli(fx.env, 'bundle', fx.P, '--generation', String(fx.N), '--branch', branch)
  assert.equal(refused.out?.state, 'clone-invalid', refused.stdout)
  assert.equal(refused.out.detail, `clone-invalid: ${linked} is a symlink, not a directory in ${fx.V}`)
  followReadme(linked)
  assert.ok(fs.existsSync(linked), 'the README command leaves no out/<prefix> folder: the delivery bundle and sidecar are gone from their place')
  assert.ok(fs.lstatSync(linked).isDirectory())
  assert.deepEqual(tree(linked), kept, 'the bundle and its sidecar are kept')
  assert.deepEqual(tree(target), kept, 'what the link pointed to is left as it was')
  const b = cli(fx.env, 'bundle', fx.P, '--generation', String(fx.N), '--branch', branch)
  assert.equal(b.out?.state, 'bundled', b.stdout)
})

test('the row names the detail texts the helpers print for a linked folder and a linked clone, and the tampered row sends a linked patches/ to it', T, async t => {
  const [, cause] = row('The loop paused with "clone invalid"')
  for (const text of ['clone-invalid: <path> is a symlink, not a directory in <work area>', 'the clone root is not a real directory (a symlink)',
    'clone-invalid: <work area>/clone is not a directory (a symlink)']) assert.ok(cause.includes(`\`${text}\``), `the cause never names \`${text}\``)
  const [, , fix] = row('The loop paused with "recovery planner"')
  assert.ok(fix.includes('`(<work area>/patches is a symlink, not a directory)`') && fix.includes('"clone invalid" row'), fix)
  // The texts as the helpers print them, for a linked clone root.
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  fs.renameSync(fx.W, path.join(fx.V, 'clone-aside'))
  fs.symlinkSync(path.join(fx.V, 'clone-aside'), fx.W)
  const c = cli(fx.env, 'check', fx.P, '--generation', String(fx.N), '--after', 'dispatch')
  assert.equal(c.out?.detail, 'the clone root is not a real directory (a symlink)', c.stdout)
  const sv = node(fx, REFLEX, ['save', fx.P, '--generation', String(fx.N), '--why', 'pause'])
  assert.equal(sv.out?.detail, 'the clone root is not a real directory (a symlink)', JSON.stringify(sv))
  const d = cli(fx.env, 'deps', fx.P, '--generation', String(fx.N))
  assert.equal(d.out?.detail, `clone-invalid: ${fx.W} is a symlink, not a directory in ${fx.V}`, d.stdout)
  closeCli(fx, { status: undefined })
  await firing(fx)
  const pl = planner(fx)
  assert.equal(pl.out?.detail, `clone-invalid: ${fx.W} is not a directory (a symlink)`, JSON.stringify(pl))
})
