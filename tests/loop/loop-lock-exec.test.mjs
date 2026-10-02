// tests/loop/loop-lock-exec.test.mjs
// `loop-lock.mjs exec` (brief 5): a verify run or dependency install as a registered child
// of the holder's generation, in a process group of its own. Real processes and real
// temporary git repositories; holders are sleepers named through TECH_LEAD_HOLDER_PID.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { acquire, release, verifyCommands } from '../../scripts/loop-lock.mjs'
import { groupAlive, isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-lock.mjs')
const HOOK = path.join(ROOT, 'tests', 'fixtures', 'spawn-hook.cjs')
// A regression fails the test instead of hanging the suite.
const T = { timeout: 60000 }
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (t, prefix = 'tl-exec-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms
  let v = fn()
  while (!v && Date.now() < deadline) { await sleep(50); v = fn() }
  return v
}
// A real process standing in for a holder. It is started through a shell that exits at
// once, so the test runner is not its parent and a killed one never lingers as a zombie.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  return pid
}
const gone = pid => startToken(pid).state === 'gone'
const kill = async pid => {
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitFor(() => gone(pid)), `pid ${pid} never read as gone`)
}

const LOOP_MD = `---
level: 1
verify:   # the commands, in order
  - echo zero > v0.txt   # a comment, not part of the command
  # - echo commented-out > never.txt
  - "printf '%s' \\"one two\\" > v1.txt"
  - 'echo "it''s" && echo two > v2.txt'
  - echo a#b > v3.txt
scope:
  - src
---
`
// A repository with one commit and a spine, a cache root for <V>, and a work directory.
const project = t => {
  const P = tmp(t, 'tl-exec-p-')
  git(P, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'LOOP.md'), LOOP_MD)
  return { P, S, cache: tmp(t, 'tl-exec-c-'), W: fs.realpathSync(tmp(t, 'tl-exec-w-')) }
}
const env = (p, pid, extra = {}) => ({ ...process.env, TECH_LEAD_CACHE: p.cache, TECH_LEAD_HOLDER_PID: String(pid), ...extra })
// A project whose generation 1 is held by a live sleeper.
const held = async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const r = await acquire(p.P, { env: e })
  assert.equal(r.generation, 1)
  return { p, a, e, lockDir: r.lockDir, V: r.V }
}
const STATUS = /^loop-lock exec: (\{.*\})$/
const statusOf = stderr => {
  const lines = stderr.trimEnd().split('\n')
  const m = STATUS.exec(lines[lines.length - 1])
  assert.ok(m, `last stderr line is not the status line: ${JSON.stringify(stderr)}`)
  return JSON.parse(m[1])
}
const exec = (e, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, 'exec', ...args], { encoding: 'utf8', env: e, timeout: 60000 })
  assert.equal(r.error, undefined, `exec ${args.join(' ')}: ${r.error}`)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, st: statusOf(r.stderr) }
}
// An exec started without waiting; `done` resolves with its status and output.
const execAsync = (t, e, ...args) => {
  const c = spawn(process.execPath, [SCRIPT, 'exec', ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  c.stdout.on('data', d => { stdout += d })
  c.stderr.on('data', d => { stderr += d })
  const done = new Promise(resolve => c.on('close', status => resolve({ status, stdout, stderr })))
  // A process left in the command's group must not hold the pipes open past the test.
  t.after(() => {
    try { c.kill('SIGKILL') } catch { /* gone */ }
    c.stdout.destroy()
    c.stderr.destroy()
  })
  return { pid: c.pid, done }
}
// Kills a process group (-pgid) or a process when the test ends, whatever its outcome; a
// process only while its start token still matches, so a reused pid is left alone.
const reap = (t, id) => {
  const start = id > 0 ? startToken(id).token : null
  t.after(() => {
    if (id > 0 ? isAlive({ pid: id, start }) !== true : groupAlive(-id) !== true) return
    try { process.kill(id, 'SIGKILL') } catch { /* gone */ }
  })
}
const children = lockDir => {
  try { return fs.readdirSync(path.join(lockDir, 'children')).sort() } catch { return [] }
}
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'))
// The proc record once its process group is known, or null.
const runningRecord = lockDir => {
  for (const n of children(lockDir).filter(x => x.includes('-proc-'))) {
    try {
      const rec = readJSON(path.join(lockDir, 'children', n))
      if (rec.pgid && rec.start) return { name: n, rec }
    } catch { /* replaced or removed meanwhile */ }
  }
  return null
}
const pidFile = async (t, f) => {
  assert.ok(await waitFor(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim()), `${f} never written`)
  const pid = Number(fs.readFileSync(f, 'utf8').trim())
  reap(t, pid)
  return pid
}
const snapshot = (...dirs) => {
  const out = {}
  for (const d of dirs) {
    if (!fs.existsSync(d)) { out[d] = null; continue }
    for (const rel of fs.readdirSync(d, { recursive: true }).sort()) {
      const f = path.join(d, rel)
      out[f] = fs.lstatSync(f).isDirectory() ? 'dir' : fs.readFileSync(f, 'utf8')
    }
  }
  return out
}
// A grandchild that outlives the command unless its group is killed; its pid lands in gc.pid.
const GRANDCHILD = 'sleep 300 >/dev/null 2>&1 & echo $! > gc.pid'

test('exec passes output and the exit code through, runs argv unquoted in <cwd> with TECH_LEAD_FIRING, and removes its record', T, async t => {
  const { p, e, lockDir } = await held(t)
  const g = ['--generation', '1', '--label', 'probe', '--cwd', p.W]
  const r = exec(e, p.P, ...g, '--', '/bin/sh', '-c', 'echo "out $TECH_LEAD_FIRING $(pwd -P)"; echo err >&2; exit 7')
  assert.equal(r.status, 7)
  assert.equal(r.stdout, `out 1 ${p.W}\n`)
  assert.ok(r.stderr.startsWith('err\n'), r.stderr)
  assert.deepEqual(r.st, { state: 'exited', exit: 7, generation: 1, label: 'probe' })
  assert.deepEqual(children(lockDir), [])
  const argv = exec(e, p.P, ...g, '--', '/usr/bin/printf', '%s|', 'a b', '$HOME', '--generation')
  assert.deepEqual([argv.status, argv.stdout], [0, 'a b|$HOME|--generation|'])
  assert.deepEqual(argv.st, { state: 'exited', exit: 0, generation: 1, label: 'probe' })
  const sig = exec(e, p.P, ...g, '--', '/bin/sh', '-c', 'kill -TERM $$')
  assert.equal(sig.status, 143)
  assert.deepEqual(sig.st, { state: 'signalled', exit: 143, generation: 1, label: 'probe', signal: 'SIGTERM' })
  assert.deepEqual(children(lockDir), [])
})

test('the proc record exists while the command runs and names the wrapper', T, async t => {
  const { p, e, lockDir } = await held(t)
  const dir = path.join(lockDir, 'children')
  const r = exec(e, p.P, '--generation', '1', '--label', 'deps', '--cwd', p.W, '--', '/bin/sh', '-c', 'cat "$1"/*.json', 'sh', dir)
  assert.equal(r.status, 0, r.stderr)
  const rec = JSON.parse(r.stdout)
  assert.deepEqual([rec.v, rec.kind, rec.generation, rec.label, rec.cwd], [1, 'proc', 1, 'deps', p.W])
  assert.deepEqual(rec.command, ['/bin/sh', '-c', 'cat "$1"/*.json', 'sh', dir])
  assert.ok(Number.isInteger(rec.wrapper.pid) && typeof rec.wrapper.start === 'string', JSON.stringify(rec.wrapper))
  assert.deepEqual(children(lockDir), [])
})

test('the proc record is on disk before the command\'s process is spawned', T, async t => {
  const { p, e, lockDir } = await held(t)
  const out = path.join(tmp(t), 'seen.jsonl')
  const r = spawnSync(process.execPath, ['--require', HOOK, SCRIPT, 'exec', p.P, '--generation', '1', '--label', 'verify', '--cwd', p.W, '--', '/bin/sh', '-c', 'exit 0'], {
    encoding: 'utf8', env: { ...e, SPAWN_HOOK_OUT: out, SPAWN_HOOK_DIR: path.join(lockDir, 'children') }, timeout: 60000,
  })
  assert.equal(r.status, 0, r.stderr)
  const seen = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(seen.length, 1, JSON.stringify(seen))
  assert.equal(seen[0].length, 1, `on record at spawn: ${JSON.stringify(seen[0])}`)
  assert.match(seen[0][0], /^1-proc-[0-9a-f]{16}\.json$/)
  assert.deepEqual(children(lockDir), [])
})

test('a wrapper killed at the spawn boundary never runs its command, and the next acquire takes its record over', T, async t => {
  for (const when of ['before', 'after']) {
    const { p, a, e, lockDir } = await held(t)
    const r = spawnSync(process.execPath, ['--require', HOOK, SCRIPT, 'exec', p.P, '--generation', '1', '--label', 'verify', '--cwd', p.W, '--', '/bin/sh', '-c', 'echo ran > ran.txt'], {
      encoding: 'utf8', env: { ...e, SPAWN_HOOK_KILL: when }, timeout: 60000,
    })
    assert.equal(r.signal, 'SIGKILL', `${when}: ${r.stderr}`)
    const left = children(lockDir)
    assert.equal(left.length, 1, when)
    const rec = readJSON(path.join(lockDir, 'children', left[0]))
    assert.deepEqual([rec.pid, rec.pgid, rec.gated], [null, null, true], when)
    await sleep(500)
    assert.ok(!fs.existsSync(path.join(p.W, 'ran.txt')), `${when}: the command ran without its group on record`)
    await kill(a)
    const next = await acquire(p.P, { env: env(p, sleeper(t)) })
    assert.equal(next.state, 'acquired', `${when}: ${JSON.stringify(next)}`)
    assert.equal(next.generation, 2, when)
    assert.deepEqual(next.reclaimed.stopped.map(c => c.file), left, when)
    assert.deepEqual(children(lockDir), [], when)
    assert.ok(!fs.existsSync(path.join(p.W, 'ran.txt')), `${when}: the command ran later`)
  }
})

test('verifyCommands reads the verify: block list as YAML does, comments and quotes included', T, () => {
  assert.deepEqual(verifyCommands(LOOP_MD), [
    'echo zero > v0.txt', 'printf \'%s\' "one two" > v1.txt', 'echo "it\'s" && echo two > v2.txt', 'echo a#b > v3.txt',
  ])
  assert.deepEqual(verifyCommands('---\nverify:\n- npm test\n- make lint\nscope:\n- src\n---\n'), ['npm test', 'make lint'])
  assert.deepEqual(verifyCommands('---\nverify:\n---\n'), [])
  const refused = {
    'no front matter': 'verify:\n  - npm test\n',
    'unterminated front matter': '---\nverify:\n  - npm test\n',
    'no verify key': '---\nlevel: 1\n---\n',
    'flow sequence': '---\nverify: [npm test, make lint]\n---\n',
    'scalar value': '---\nverify: npm test\n---\n',
    'continuation line': '---\nverify:\n  - npm\n    test\n---\n',
    'mapping item': '---\nverify:\n  - run: npm test\n---\n',
    'block scalar': '---\nverify:\n  - |\n    npm test\n---\n',
    'unterminated quote': '---\nverify:\n  - "npm test\n---\n',
    'text after a quote': '---\nverify:\n  - "npm" test\n---\n',
    'yaml-only escape': '---\nverify:\n  - "npm \\x41"\n---\n',
    'empty item': '---\nverify:\n  -\n---\n',
    'nested list': '---\nverify:\n  - - npm test\n---\n',
  }
  for (const [why, text] of Object.entries(refused)) {
    assert.throws(() => verifyCommands(text), /^Error: (bad-loop-md|no-verify|bad-verify): /, why)
  }
})

test('--verify K runs the K-th verify: item through /bin/sh -c; a missing item or LOOP.md is an error and writes nothing', T, async t => {
  const { p, e, V } = await held(t)
  const g = ['--generation', '1', '--label', 'verify', '--cwd', p.W]
  for (const k of [0, 1, 2, 3]) {
    const r = exec(e, p.P, ...g, '--verify', String(k))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.st, { state: 'exited', exit: 0, generation: 1, label: 'verify' })
    if (k === 2) assert.equal(r.stdout, 'it\'s\n')
  }
  const read = f => fs.readFileSync(path.join(p.W, f), 'utf8')
  assert.deepEqual([read('v0.txt'), read('v1.txt'), read('v2.txt'), read('v3.txt')], ['zero\n', 'one two', 'two\n', 'a#b\n'])
  assert.ok(!fs.existsSync(path.join(p.W, 'never.txt')))
  const before = snapshot(V, p.S, p.W)
  const missing = exec(e, p.P, ...g, '--verify', '4')
  assert.equal(missing.status, 2)
  assert.equal(missing.st.state, 'error')
  assert.match(missing.st.detail, /verify/)
  assert.equal(missing.stdout, '')
  fs.renameSync(path.join(p.S, 'LOOP.md'), path.join(p.S, 'LOOP.md.bak'))
  const noFile = exec(e, p.P, ...g, '--verify', '0')
  assert.deepEqual([noFile.status, noFile.st.state], [2, 'error'])
  fs.renameSync(path.join(p.S, 'LOOP.md.bak'), path.join(p.S, 'LOOP.md'))
  assert.deepEqual(snapshot(V, p.S, p.W), before)
})

test('a grandchild still running when the command exits is killed with its group', T, async t => {
  const { p, e, lockDir } = await held(t)
  const r = exec(e, p.P, '--generation', '1', '--label', 'verify', '--cwd', p.W, '--', '/bin/sh', '-c', `${GRANDCHILD}; exit 3`)
  assert.equal(r.status, 3)
  assert.deepEqual(r.st, { state: 'exited', exit: 3, generation: 1, label: 'verify', lingering: true })
  const gc = await pidFile(t, path.join(p.W, 'gc.pid'))
  assert.ok(await waitFor(() => gone(gc)), `grandchild ${gc} survived`)
  assert.deepEqual(children(lockDir), [])
})

test('--timeout-ms kills the group and exits 124', T, async t => {
  const { p, e, lockDir } = await held(t)
  const t0 = Date.now()
  const r = exec(e, p.P, '--generation', '1', '--label', 'verify', '--cwd', p.W, '--timeout-ms', '300', '--', '/bin/sh', '-c', `${GRANDCHILD}; sleep 300`)
  assert.equal(r.status, 124)
  assert.equal(r.st.state, 'timeout')
  assert.equal(r.st.exit, 124)
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`)
  const gc = await pidFile(t, path.join(p.W, 'gc.pid'))
  assert.ok(await waitFor(() => gone(gc)), `grandchild ${gc} survived`)
  assert.deepEqual(children(lockDir), [])
})

test('exec by a process that does not hold the generation exits 125, runs nothing and writes nothing', T, async t => {
  const { p, e, V } = await held(t)
  const b = sleeper(t)
  const cmd = ['--label', 'verify', '--cwd', p.W, '--', '/bin/sh', '-c', 'echo ran > ran.txt']
  const before = snapshot(V, p.S, p.W)
  const noHolder = { ...e }
  delete noHolder.TECH_LEAD_HOLDER_PID
  delete noHolder.CLAUDE_PID
  for (const [who, en, g] of [['another holder', env(p, b), '1'], ['a later generation', e, '2'], ['no holder at all', noHolder, '1']]) {
    const r = exec(en, p.P, '--generation', g, ...cmd)
    assert.equal(r.status, 125, who)
    assert.equal(r.st.state, 'not-holder', who)
    assert.equal(r.stdout, '', who)
  }
  assert.deepEqual(snapshot(V, p.S, p.W), before)
  await release(p.P, 1, { env: e })
  const after = exec(e, p.P, '--generation', '1', ...cmd)
  assert.deepEqual([after.status, after.st.state], [125, 'not-holder'])
  assert.ok(!fs.existsSync(path.join(p.W, 'ran.txt')))
})

test('the holder dying mid-run gets the group killed and exit 125 holder-gone', T, async t => {
  const { p, a, e, lockDir } = await held(t)
  const cmd = `${GRANDCHILD}; sleep 300`
  const run = execAsync(t, e, p.P, '--generation', '1', '--label', 'verify', '--cwd', p.W, '--', '/bin/sh', '-c', cmd)
  const found = await waitFor(runningRecord.bind(null, lockDir))
  assert.ok(found, 'the proc record never learned its group')
  const { rec } = found
  reap(t, -rec.pgid)
  assert.deepEqual(rec, {
    v: 1, kind: 'proc', generation: 1, label: 'verify', cwd: p.W, command: ['/bin/sh', '-c', cmd],
    wrapper: { pid: run.pid, start: startToken(run.pid).token }, pid: rec.pgid, pgid: rec.pgid, start: startToken(rec.pgid).token, gated: true,
  })
  assert.equal(groupAlive(rec.pgid), true)
  const gc = await pidFile(t, path.join(p.W, 'gc.pid'))
  await kill(a)
  const t0 = Date.now()
  const r = await run.done
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`)
  assert.equal(r.status, 125)
  const st = statusOf(r.stderr)
  assert.deepEqual([st.state, st.exit, st.generation], ['holder-gone', 125, 1])
  assert.equal(groupAlive(rec.pgid), false)
  assert.ok(await waitFor(() => gone(gc)), `grandchild ${gc} survived`)
  assert.deepEqual(children(lockDir), [])
})

test('a release while exec runs stops the group and the wrapper', T, async t => {
  const { p, e, lockDir } = await held(t)
  const run = execAsync(t, e, p.P, '--generation', '1', '--label', 'deps', '--cwd', p.W, '--', '/bin/sh', '-c', `${GRANDCHILD}; sleep 300`)
  const found = await waitFor(runningRecord.bind(null, lockDir))
  assert.ok(found, 'the proc record never learned its group')
  reap(t, -found.rec.pgid)
  const gc = await pidFile(t, path.join(p.W, 'gc.pid'))
  const rel = await release(p.P, 1, { env: e })
  assert.deepEqual(rel.lingering, [])
  assert.deepEqual(rel.stopped.map(s => [s.kind, s.pgid]), [['proc', found.rec.pgid]])
  assert.equal(groupAlive(found.rec.pgid), false)
  assert.ok(await waitFor(() => gone(gc)), `grandchild ${gc} survived`)
  const r = await run.done
  assert.notEqual(r.status, 0)
  assert.ok(['interrupted', 'not-holder', 'signalled'].includes(statusOf(r.stderr).state), r.stderr)
  assert.deepEqual(children(lockDir), [])
})

test('usage errors exit 2, a command that cannot start exits 127; neither leaves a record', T, async t => {
  const { p, e, lockDir } = await held(t)
  const g = ['--generation', '1']
  const bad = [
    [], [p.P], [p.P, ...g, '--label', 'x', '--', 'true'], [p.P, ...g, '--cwd', p.W, '--', 'true'],
    [p.P, ...g, '--label', 'x', '--cwd', p.W], [p.P, ...g, '--label', 'x', '--cwd', p.W, '--'],
    [p.P, ...g, '--label', 'x', '--cwd', p.W, '--verify', '0', '--', 'true'], [p.P, ...g, '--label', 'x', '--cwd', p.W, '--verify', 'x'],
    [p.P, ...g, '--label', 'x', '--cwd', p.W, '--verify', '-1'], [p.P, ...g, '--label', 'x', '--cwd', p.W, '--timeout-ms', '0', '--', 'true'],
    [p.P, '--generation', '0', '--label', 'x', '--cwd', p.W, '--', 'true'], [p.P, ...g, '--label', ' ', '--cwd', p.W, '--', 'true'],
    [p.P, ...g, '--label', 'x', '--cwd', p.W, '--bogus', '1', '--', 'true'], [p.P, ...g, '--label', 'x', '--cwd', path.join(p.W, 'missing'), '--', 'true'],
  ]
  for (const args of bad) {
    const r = exec(e, ...args)
    assert.deepEqual([r.status, r.st.state, r.stdout], [2, 'error', ''], args.join(' '))
  }
  const nf = exec(e, p.P, ...g, '--label', 'x', '--cwd', p.W, '--', path.join(p.W, 'no-such-command'))
  assert.deepEqual([nf.status, nf.st.state], [127, 'error'])
  assert.deepEqual(children(lockDir), [])
})

test('exec stops its own group once its generation is released by the owner or taken over, while the holder lives', T, async t => {
  for (const how of ['owner release', 'a later generation']) {
    const { p, e, lockDir } = await held(t)
    const run = execAsync(t, e, p.P, '--generation', '1', '--label', 'verify', '--cwd', p.W, '--', '/bin/sh', '-c', `${GRANDCHILD}; sleep 300`)
    const found = await waitFor(runningRecord.bind(null, lockDir))
    assert.ok(found, `${how}: the proc record never learned its group`)
    reap(t, -found.rec.pgid)
    const gc = await pidFile(t, path.join(p.W, 'gc.pid'))
    if (how === 'owner release') {
      // The owner release kills nothing itself: only the wrapper's poll can stop the group.
      await release(p.P, 1, { env: e, owner: true, io: { isTTY: true, print: () => {}, ask: async () => '1' } })
    } else {
      fs.writeFileSync(path.join(lockDir, 'slots', '2.json'), fs.readFileSync(path.join(lockDir, 'slots', '1.json')))
    }
    const r = await Promise.race([run.done, sleep(10000).then(() => null)])
    assert.ok(r, `${how}: exec kept running after its generation was ${how === 'owner release' ? 'released' : 'replaced'}`)
    assert.equal(r.status, 125, how)
    assert.equal(statusOf(r.stderr).state, 'not-holder', how)
    assert.equal(groupAlive(found.rec.pgid), false, how)
    assert.ok(await waitFor(() => gone(gc)), `${how}: grandchild ${gc} survived`)
    assert.deepEqual(children(lockDir), [], how)
  }
})

test('a signal to the wrapper (SIGTERM, SIGINT, SIGHUP) kills its group and reports interrupted with 128 + n', T, async t => {
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const { p, e, lockDir } = await held(t)
    const run = execAsync(t, e, p.P, '--generation', '1', '--label', 'verify', '--cwd', p.W, '--', '/bin/sh', '-c', `${GRANDCHILD}; sleep 300`)
    const found = await waitFor(runningRecord.bind(null, lockDir))
    assert.ok(found, `${sig}: the proc record never learned its group`)
    reap(t, -found.rec.pgid)
    const gc = await pidFile(t, path.join(p.W, 'gc.pid'))
    process.kill(run.pid, sig)
    const r = await Promise.race([run.done, sleep(10000).then(() => null)])
    assert.ok(r, `${sig}: the wrapper never ended`)
    assert.equal(r.status, code, sig)
    const st = statusOf(r.stderr)
    assert.deepEqual([st.state, st.exit, st.signal], ['interrupted', code, sig])
    assert.equal(groupAlive(found.rec.pgid), false, `${sig}: the group outlived the wrapper`)
    assert.ok(await waitFor(() => gone(gc)), `${sig}: grandchild ${gc} survived`)
    assert.deepEqual(children(lockDir), [], sig)
  }
})
