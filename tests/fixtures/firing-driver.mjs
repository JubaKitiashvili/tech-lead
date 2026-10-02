#!/usr/bin/env node
// tests/fixtures/firing-driver.mjs
// A stand-in for one loop firing, for tests/loop/loop-interrupt.test.mjs. It is its own
// holder (TECH_LEAD_HOLDER_PID is its pid), drives the lock through the CLI as the loop's
// prose does, prints one JSON event line per step, and stops at a boundary:
//   node firing-driver.mjs <P> <W> <stop>
//     acquired  after acquire                        {"event":"acquired",...acquire output}
//     stray     after acquire, with a process left running in <W> that no record names
//               (as a delegate's command would be), in a session of its own
//                                                    {"event":"stray","pid":<pid>}
//     exec      while exec runs LOOP.md verify[0]    {"event":"exec","wrapper":<pid>,"pgid":<pgid>}
//     ledger    after exec --verify 1 and the ledger append, before release
//                                                    {"event":"ledger","generation":N}
//     none      runs to its release and exits 0      {"event":"released","generation":N}
// At every boundary but none it then waits to be killed. The exec wrapper is started in the
// driver's own process group, so killing that group kills the firing and the wrapper but
// not the exec child, which leads a group of its own.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LOCK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'loop-lock.mjs')
const [P, W, stop] = process.argv.slice(2)
if (!P || !W || !['acquired', 'stray', 'exec', 'ledger', 'none'].includes(stop)) {
  process.stderr.write('usage: firing-driver.mjs <P> <W> acquired|stray|exec|ledger|none\n')
  process.exit(2)
}
const env = { ...process.env, TECH_LEAD_HOLDER_PID: String(process.pid) }
const emit = o => fs.writeSync(1, `${JSON.stringify(o)}\n`)
const fail = (what, detail) => {
  emit({ event: 'error', what, detail })
  process.exit(1)
}
const hang = () => setInterval(() => {}, 2 ** 30)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lock = (...args) => {
  const r = spawnSync(process.execPath, [LOCK, ...args], { encoding: 'utf8', env })
  let out = null
  try {
    out = JSON.parse(r.stdout)
  } catch { /* reported below */ }
  return { status: r.status, out, stderr: r.stderr }
}

const acq = lock('acquire', P)
if (acq.status !== 0) fail('acquire', acq.out || acq.stderr)
const N = acq.out.generation
emit({ event: 'acquired', ...acq.out })
const exec = ['exec', P, '--generation', String(N), '--label', 'verify', '--cwd', W]

if (stop === 'acquired') {
  hang()
} else if (stop === 'stray') {
  const stray = spawn('/bin/sleep', ['120'], { cwd: W, detached: true, stdio: 'ignore' })
  stray.unref()
  emit({ event: 'stray', pid: stray.pid })
  hang()
} else if (stop === 'exec') {
  const wrapper = spawn(process.execPath, [LOCK, ...exec, '--verify', '0'], { env, stdio: 'ignore' })
  const dir = path.join(acq.out.lockDir, 'children')
  let rec = null
  for (let i = 0; i < 200 && !rec; i++) {
    await sleep(50)
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        if (r.kind === 'proc' && r.pgid && r.start) rec = r
      } catch { /* replaced meanwhile */ }
    }
  }
  if (!rec) fail('exec', 'the exec record never learned its process group')
  emit({ event: 'exec', wrapper: wrapper.pid, pgid: rec.pgid })
  hang()
} else {
  const v = spawnSync(process.execPath, [LOCK, ...exec, '--verify', '1'], { encoding: 'utf8', env })
  if (v.status !== 0) fail('verify', v.stderr)
  fs.appendFileSync(path.join(P, '.tech-lead', 'LEDGER.jsonl'), `${JSON.stringify({ iteration: N, outcome: 'done', verify: 'pass' })}\n`)
  emit({ event: 'ledger', generation: N })
  if (stop === 'ledger') {
    hang()
  } else {
    const rel = lock('release', P, '--generation', String(N))
    if (rel.status !== 0) fail('release', rel.out || rel.stderr)
    emit({ event: 'released', generation: N })
  }
}
