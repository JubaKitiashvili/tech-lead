#!/usr/bin/env node
// live-evals/run.mjs
// One live firing of /tech-lead:loop in a scratch git repository, graded from what it left
// on disk. Every run is a real, paid model session. See live-evals/README.md.
//
//   node live-evals/run.mjs <scenario> [--model opus] [--budget 4] [--out <dir>]
//   node live-evals/run.mjs --grade <run dir> <scenario>     grade an earlier run again
//   node live-evals/run.mjs --list

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { SCENARIOS, buildFixture } from './scenarios.mjs'
import { ROOT, grade, projectSnapshot } from './grade.mjs'

const TIMEOUT_MS = 30 * 60 * 1000

function parseArgs(argv) {
  const o = { model: 'opus', budget: '4', out: null, grade: null, list: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') o.list = true
    else if (a === '--model' || a === '--budget' || a === '--out' || a === '--grade') o[a.slice(2)] = argv[++i]
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`)
    else o.rest.push(a)
  }
  return o
}

function report(res, run) {
  for (const c of res.checks) console.log(`${c.pass ? '  ok  ' : '  FAIL'} ${c.name}${c.pass ? '' : `: ${c.detail}`}`)
  const cost = res.cost_usd === null ? 'cost unknown' : `$${res.cost_usd.toFixed(2)}`
  console.log(`${res.scenario}: ${res.passed}/${res.total} checks, ${cost}, ${res.turns ?? '?'} turns, ${res.seconds ?? '?'} s`)
  console.log(`run directory: ${run}`)
}

function runClaude(P, run, { model, budget }) {
  return new Promise(resolve => {
    const out = fs.openSync(path.join(run, 'stream.jsonl'), 'w')
    const err = fs.openSync(path.join(run, 'stderr.log'), 'w')
    const child = spawn('claude', [
      '-p', `Run /tech-lead:loop ${P}`,
      '--plugin-dir', ROOT, '--model', model, '--effort', 'high',
      '--output-format', 'stream-json', '--verbose', '--max-budget-usd', String(budget),
      '--permission-mode', 'bypassPermissions', '--no-session-persistence',
    ], {
      cwd: P,
      stdio: ['ignore', out, err],
      env: { ...process.env, TECH_LEAD_CACHE: path.join(run, 'cache'), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '3600000' },
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS)
    child.on('close', code => { clearTimeout(timer); fs.closeSync(out); fs.closeSync(err); resolve(code) })
    child.on('error', e => { clearTimeout(timer); resolve(`spawn failed: ${e.message}`) })
  })
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.list) {
    for (const [name, sc] of Object.entries(SCENARIOS)) console.log(`${name}\n  ${sc.about}`)
    return 0
  }
  const scenario = o.rest[0]
  if (!SCENARIOS[scenario]) {
    console.error(`usage: run.mjs <${Object.keys(SCENARIOS).join('|')}> [--model opus] [--budget 4] [--out <dir>] | --grade <run dir> <scenario> | --list`)
    return 2
  }
  let run = o.grade ? path.resolve(o.grade) : null
  if (!run) {
    const base = fs.realpathSync(o.out ? (fs.mkdirSync(o.out, { recursive: true }), o.out) : os.tmpdir())
    run = fs.mkdtempSync(path.join(base, `tl-live-${scenario}-`))
    if (run.startsWith(ROOT + path.sep)) throw new Error('the run directory must be outside the plugin')
    const P = path.join(run, 'repo')
    fs.mkdirSync(P)
    buildFixture(P, scenario)
    fs.mkdirSync(path.join(run, 'cache'))
    fs.writeFileSync(path.join(run, 'before.json'), JSON.stringify({
      scenario, model: o.model, snapshot: projectSnapshot(P),
      stateText: fs.readFileSync(path.join(P, '.tech-lead/STATE.md'), 'utf8'),
    }, null, 2))
    console.log(`${scenario} on ${o.model}, budget $${o.budget}: ${run}`)
    const code = await runClaude(P, run, o)
    fs.writeFileSync(path.join(run, 'exit'), `${code}\n`)
  }
  const res = grade(run, scenario)
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(res, null, 2))
  report(res, run)
  return res.pass ? 0 : 1
}

main().then(code => process.exit(code), err => { console.error(err.message); process.exit(2) })
