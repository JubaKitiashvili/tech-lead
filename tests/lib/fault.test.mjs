// tests/lib/fault.test.mjs
// Fault points (stage 0c-2 brief section 10, ruling R8): fault(point) SIGKILLs its own
// process when TECH_LEAD_FAULT names that point, and is a no-op otherwise. Each case runs a
// real child node process.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { fault } from '../../scripts/lib/fault.mjs'

const MODULE = new URL(`file://${path.join(ROOT, 'scripts', 'lib', 'fault.mjs')}`).href
const T = { timeout: 90000 }

// A child that writes "before", passes the given points in order, then writes "after".
// Writes go straight to fd 1, so nothing waits in a buffer when the kill lands.
const run = (points, faultEnv) => {
  const script = `import fs from 'node:fs'
import { fault } from ${JSON.stringify(MODULE)}
for (const p of ${JSON.stringify(points)}) { fs.writeSync(1, 'at ' + p + '\\n'); fault(p) }
fs.writeSync(1, 'after\\n')`
  const env = { ...process.env }
  delete env.TECH_LEAD_FAULT
  if (faultEnv !== undefined) env.TECH_LEAD_FAULT = faultEnv
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 60000 })
}

test('fault kills its process with SIGKILL at the named point and nowhere else', T, () => {
  const r = run(['save:after-write', 'save:after-check', 'save:after-link'], 'save:after-check')
  assert.equal(r.signal, 'SIGKILL', r.stderr)
  assert.equal(r.status, null)
  assert.equal(r.stdout, 'at save:after-write\nat save:after-check\n', 'a step after the fault point ran')
  // No exit handler or cleanup runs: an exit hook would have written.
  const hooked = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'
import { fault } from ${JSON.stringify(MODULE)}
process.on('exit', () => fs.writeSync(1, 'exit hook\\n'))
fault('prepare:after-temps')`], { encoding: 'utf8', env: { ...process.env, TECH_LEAD_FAULT: 'prepare:after-temps' }, timeout: 60000 })
  assert.equal(hooked.signal, 'SIGKILL')
  assert.equal(hooked.stdout, '')
})

test('fault is a no-op when TECH_LEAD_FAULT is unset, empty, or names another point', T, () => {
  const points = ['reset:after-unlink-one', 'commit:after-intent']
  for (const value of [undefined, '', 'reset:after-unlink', 'commit:after-intent ', 'COMMIT:AFTER-INTENT', 'reset:after-unlink-one,commit:after-intent', '*']) {
    const r = run(points, value)
    assert.equal(r.status, 0, `${JSON.stringify(value)}: ${r.stderr}`)
    assert.equal(r.stdout, 'at reset:after-unlink-one\nat commit:after-intent\nafter\n', JSON.stringify(value))
  }
})

test('fault refuses a point name that is not <helper>:<step>, whatever TECH_LEAD_FAULT holds', () => {
  for (const bad of ['', 'save', 'save:', ':after', 'Save:after', 'save:after write', 'a:b:c', 7, undefined]) {
    assert.throws(() => fault(bad), /^TypeError: fault: bad point/, String(bad))
  }
  // In this process TECH_LEAD_FAULT is unset or names nothing here, so a good name returns.
  assert.equal(fault('test:never-set-here'), undefined)
})
