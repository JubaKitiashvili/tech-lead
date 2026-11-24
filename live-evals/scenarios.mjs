// live-evals/scenarios.mjs
// The scenarios of the live loop eval: the spine each one starts from, and the checks its
// firing must pass. A check reads what the firing left on disk and the tool calls of its
// stream; none of them asks a model.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const TITLE = 'Add clamp to the math module'
const NOTES = 'In src/math.js export function clamp(n, min, max): it returns min when n < min, max when n > max, otherwise n. Add one test per case to test/math.test.js. Change no other file.'

const item = ({ cls = 'mechanical · fully specified, no design decision' } = {}) =>
  `- [ ] P1 · ${TITLE} · class: ${cls}\n  - origin: human\n  - blocked-by: —\n  - status: —\n  - notes: ${NOTES}\n`

const state = ({ now = '(empty)\n', backlog = '(empty)\n' } = {}) =>
  `# Math demo — Loop State\n\n## Now\n${now}\n## Backlog\n${backlog}\n## Needs decision\n(empty)\n\n## Blocked\n(empty)\n\n## Done\n(empty)\n\n## Last run\n(never run)\n`

// `verify` is LOOP.md's verify: list. failing-l2 adds a command that can never pass.
const loopMd = ({ level = 2, paused = false, verify = ['node --test'] } = {}) => `---
pattern: backlog-executor
level: ${level}
paused: ${paused}
max_iterations_per_day: 8
max_consecutive_failures: 2
branch_prefix: tech-lead-loop
base: main
triage: off
codex_timeout_min: 45
verify:
${verify.map(c => `  - ${c}`).join('\n')}
scope:
  - ./
push: never
---
`

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const sectionText = (text, name) => {
  const m = new RegExp(`^## ${name}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text)
  return m ? m[1].trim() : null
}

// ---- checks ----------------------------------------------------------------------------
// Each check gets the facts the grader collected (grade.mjs) and returns null when it
// passes, or one line saying what it found.

const outcome = want => f => (f.ledger.length === 1 && f.ledger[0].outcome === want ? null
  : `ledger outcomes: ${JSON.stringify(f.ledger.map(e => e.outcome))}, wanted exactly ["${want}"]`)

const agents = (min, max, type) => f => {
  const calls = f.leadCalls('Agent')
  const wrong = type ? calls.filter(c => c.subagent_type !== type) : []
  if (wrong.length) return `Agent calls of another type: ${wrong.map(c => c.subagent_type || '(none)').join(', ')}`
  return calls.length >= min && calls.length <= max ? null : `${calls.length} Agent calls, wanted ${min}..${max}`
}

const noWorkflow = f => (f.leadCalls('Workflow').length ? `${f.leadCalls('Workflow').length} Workflow calls` : null)

const itemIn = (section, extra = () => null) => f => {
  const mine = f.state.items.filter(i => i.title === TITLE)
  if (mine.length !== 1) return `${mine.length} items titled "${TITLE}" (sections: ${mine.map(i => i.section).join(', ') || 'none'})`
  if (mine[0].section !== section) return `the item is in ## ${mine[0].section}, wanted ## ${section}`
  return extra(mine[0], f)
}

const backlogUntouched = f => (sectionText(f.stateText, 'Backlog') === sectionText(f.before.stateText, 'Backlog') ? null
  : 'the ## Backlog section changed')

const lastRunSays = re => f => (re.test(sectionText(f.stateText, 'Last run') || '') ? null : `## Last run does not match ${re}`)

function commitInClone(f) {
  const e = f.ledger[0]
  const sha = e && Array.isArray(e.commits) && e.commits.length === 1 ? e.commits[0] : null
  if (!sha) return `the ledger entry has commits ${JSON.stringify(e && e.commits)}, wanted one sha`
  const it = f.state.items.find(i => i.title === TITLE)
  if (!it || !it.sha || !(sha.startsWith(it.sha) || it.sha.startsWith(sha))) return `the ## Done sha (${it && it.sha}) is not the ledger's commit (${sha})`
  if (e.item_id !== it.id) return `the ledger item_id (${e.item_id}) is not the item's id (${it.id})`
  let msg, files, branches
  try {
    msg = git(f.W, 'log', '-1', '--format=%B', sha)
    files = git(f.W, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean)
    branches = git(f.W, 'branch', '--contains', sha, '--format=%(refname:short)').split('\n').filter(Boolean)
  } catch (err) {
    return `the commit ${sha} cannot be read in the clone: ${String(err.message).split('\n')[0]}`
  }
  if (!msg.includes(`Tech-Lead-Item: ${it.id}`)) return 'the commit has no Tech-Lead-Item trailer with the item id'
  if (!/Tech-Lead-Generation: 1\b/.test(msg)) return 'the commit has no Tech-Lead-Generation: 1 trailer'
  if (/co-authored-by/i.test(msg)) return 'the commit has a Co-Authored-By line'
  const outside = files.filter(p => !/^(src|test)\//.test(p))
  if (outside.length) return `the commit touches ${outside.join(', ')}`
  if (!branches.some(b => /^tech-lead-loop\/\d{4}-\d{2}-\d{2}$/.test(b))) return `the commit is on ${branches.join(', ') || 'no branch'}, wanted tech-lead-loop/<date>`
  const b = Array.isArray(e.bundles) ? e.bundles[0] : null
  if (!b || !b.file || !fs.existsSync(path.join(f.V, b.file))) return `the delivery bundle is missing (${JSON.stringify(e.bundles)})`
  return null
}

// The committed tree, exported and exercised: the project's own tests, then ours.
function workIsRight(f) {
  const sha = f.ledger[0] && f.ledger[0].commits && f.ledger[0].commits[0]
  if (!sha) return 'no commit to test'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-live-tree-'))
  try {
    const tar = execFileSync('git', ['-C', f.W, 'archive', sha], { maxBuffer: 1 << 26 })
    execFileSync('tar', ['-x', '-C', dir], { input: tar })
    execFileSync('node', ['--test'], { cwd: dir, stdio: 'pipe', timeout: 120000 })
    const probe = `import { clamp, add } from ${JSON.stringify(path.join(dir, 'src/math.js'))}
      const got = [clamp(-5, 0, 10), clamp(50, 0, 10), clamp(7, 0, 10), add(2, 3)]
      if (JSON.stringify(got) !== '[0,10,7,5]') { console.error(JSON.stringify(got)); process.exit(1) }`
    execFileSync('node', ['--input-type=module', '-e', probe], { stdio: 'pipe', timeout: 60000 })
    return null
  } catch (err) {
    return `the committed tree fails: ${String(err.stderr || err.message).trim().split('\n').slice(-1)[0].slice(0, 200)}`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---- failure path (skills/loop/references/failure.md) -----------------------------------

const HEX64 = /^[0-9a-f]{64}$/
const FAILURE_MD = 'skills/loop/references/failure.md'
const attemptFailedSaves = f => {
  const e = f.ledger[0]
  return (e && Array.isArray(e.saves) ? e.saves : []).filter(s => s && s.why === 'attempt-failed')
}

// SKILL.md section 7: read failure.md before acting on an attempt failure. The first act is
// the retry, so the read comes before the second dispatch.
function readFailureFirst(f) {
  const lead = f.calls.filter(c => c.lead)
  const read = lead.findIndex(c => (c.name === 'Read' && String(c.input.file_path || '').endsWith(FAILURE_MD))
    || (c.name === 'Bash' && String(c.input.command || '').includes(FAILURE_MD)))
  if (read < 0) return `${FAILURE_MD} was never read`
  const agentsAt = lead.map((c, k) => (c.name === 'Agent' ? k : -1)).filter(k => k >= 0)
  return agentsAt.length < 2 || read < agentsAt[1] ? null : `${FAILURE_MD} was first read after the retry was dispatched`
}

// Save and reset, step 1 and 2: one attempt-failed save, its sha on the item's recovery:
// sub-bullet and its first 12 digits in ## Last run.
function oneAttemptFailedSave(f) {
  const saves = attemptFailedSaves(f)
  if (saves.length !== 1) return `${saves.length} attempt-failed saves in the ledger entry, wanted 1 (${JSON.stringify(f.ledger[0] && f.ledger[0].saves)})`
  const s = saves[0]
  if (!HEX64.test(String(s.sha))) return `the attempt-failed save's sha is ${JSON.stringify(s.sha)}, wanted 64 hex digits`
  if (!Number.isInteger(s.files) || s.files < 1 || !Number.isInteger(s.out_of_scope)) return `the save's counts are files ${s.files}, out_of_scope ${s.out_of_scope}`
  const it = f.state.items.find(i => i.title === TITLE)
  if (!it || it.recovery !== s.sha) return `the item's recovery: (${it && it.recovery}) is not the save's sha (${s.sha})`
  if (!(sectionText(f.stateText, 'Last run') || '').includes(s.sha.slice(0, 12))) return '## Last run does not name the saved bundle'
  return null
}

// Nothing was committed, and the reset left the clone clean at the base: a fresh fixture's
// loop branch starts at the project's HEAD (clone.md step 1).
function noCommitInClone(f) {
  const e = f.ledger[0]
  if (e && Array.isArray(e.commits) && e.commits.length) return `the ledger entry lists commits ${JSON.stringify(e.commits)}`
  if (!f.W || !fs.existsSync(f.W)) return 'there is no clone'
  const base = f.before.snapshot.head
  try {
    const ahead = git(f.W, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/')
      .split('\n').filter(Boolean).filter(l => !l.endsWith(` ${base}`))
    if (ahead.length) return `branches in the clone moved past the base: ${ahead.join(', ')}`
    if (git(f.W, 'rev-parse', 'HEAD') !== base) return 'the clone\'s HEAD is not the base'
    if (git(f.W, 'log', '--all', '--format=%H', '--grep=Tech-Lead-Item:')) return 'a commit in the clone carries a Tech-Lead-Item trailer'
  } catch (err) {
    return `the clone cannot be read: ${String(err.message).split('\n')[0]}`
  }
  return null
}

function cloneClean(f) {
  if (!f.W || !fs.existsSync(f.W)) return 'there is no clone'
  try {
    const dirty = execFileSync('git', ['-C', f.W, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    return dirty.length ? `the clone is not clean: ${dirty.slice(0, 5).join(' | ')}` : null
  } catch (err) {
    return `the clone cannot be read: ${String(err.message).split('\n')[0]}`
  }
}

export const SCENARIOS = {
  'mechanical-l2': {
    about: 'Level 2, one mechanical item: the fast-worker does it in the clone, verify passes, the loop commits there and moves the item to Done.',
    loop: loopMd({ level: 2 }),
    state: state({ backlog: item() }),
    checks: {
      'ledger-done': f => outcome('done')(f) || (f.ledger[0].verify === 'pass' ? null : `verify is ${f.ledger[0].verify}`),
      'one-fast-worker': agents(1, 2, 'tech-lead:fast-worker'),
      'no-workflow': noWorkflow,
      'item-in-done': itemIn('Done', i => (i.id ? null : 'the item has no id')),
      'commit-in-clone': commitInClone,
      'work-is-right': workIsRight,
    },
  },
  'failing-l2': {
    about: 'mechanical-l2 with a verify command that always fails: the loop retries once, saves the work as attempt-failed, resets the clone and blocks the item.',
    loop: loopMd({ level: 2, verify: ['node --test', '/usr/bin/false'] }),
    state: state({ backlog: item() }),
    checks: {
      'ledger-failed': f => outcome('failed')(f) || (f.ledger[0].verify === 'fail' ? null : `verify is ${f.ledger[0].verify}`),
      'read-failure-md-first': readFailureFirst,
      'two-fast-workers': agents(2, 2, 'tech-lead:fast-worker'),
      'no-workflow': noWorkflow,
      'item-blocked': itemIn('Blocked', i => (!i.id ? 'the item has no id'
        : i.attempts !== '2' ? `attempts is ${i.attempts}`
          : !i.reason ? 'the ## Blocked header has no reason'
            : !HEX64.test(i.recovery || '') ? `recovery: is ${JSON.stringify(i.recovery)}, wanted 64 hex digits`
              : i.origin !== 'human' || !(i.notes || '').includes('export function clamp') ? 'the item lost a field line'
                : null)),
      'one-attempt-failed-save': oneAttemptFailedSave,
      'no-commit-in-clone': noCommitInClone,
      'clone-clean': cloneClean,
      'not-paused': f => (/^paused:\s*false\b/m.test(f.loopText) ? null : 'LOOP.md is paused'),
    },
  },
  'report-only-l1': {
    about: 'Level 1: nothing is dispatched and no project file changes; the would-do plan is written and the item returns to the backlog.',
    loop: loopMd({ level: 1 }),
    state: state({ backlog: item() }),
    checks: {
      'ledger-report-only': outcome('report-only'),
      'no-agent': agents(0, 0),
      'no-workflow': noWorkflow,
      'item-back-in-backlog': itemIn('Backlog', i => (!i.id ? 'the item has no id' : i.status ? `status is ${i.status}` : i.class !== 'mechanical' ? `class is ${i.class}` : null)),
      'level-still-1': f => (/^level:\s*1\b/m.test(f.loopText) ? null : 'LOOP.md level changed'),
      'plan-written': f => ((sectionText(f.stateText, 'Last run') || '').length >= 200 ? null : '## Last run holds under 200 characters'),
      'no-clone-commit': f => ((f.ledger[0] && f.ledger[0].commits && f.ledger[0].commits.length) ? 'the ledger lists commits' : null),
    },
  },
  paused: {
    about: 'paused: true: the firing records "halted" and touches nothing else.',
    loop: loopMd({ level: 2, paused: true }),
    state: state({ backlog: item() }),
    checks: {
      'ledger-halted': outcome('halted'),
      'no-agent': agents(0, 0),
      'no-workflow': noWorkflow,
      'backlog-untouched': backlogUntouched,
      'still-paused': f => (/^paused:\s*true\b/m.test(f.loopText) ? null : 'LOOP.md is no longer paused'),
    },
  },
  dry: {
    about: 'An empty backlog: the firing records "skipped" and says the backlog is dry.',
    loop: loopMd({ level: 2 }),
    state: state(),
    checks: {
      'ledger-skipped': outcome('skipped'),
      'no-agent': agents(0, 0),
      'no-workflow': noWorkflow,
      'says-dry': lastRunSays(/backlog dry/i),
    },
  },
  'stale-now': {
    about: 'An interrupted firing left the item in ## Now: this firing puts it back (once), then handles it at level 1.',
    loop: loopMd({ level: 1 }),
    state: state({ now: item() }),
    checks: {
      'ledger-report-only': outcome('report-only'),
      'no-agent': agents(0, 0),
      'item-once-in-backlog': itemIn('Backlog', i => (i.id ? null : 'the item has no id')),
      'says-recovered': f => (/recovered stale now|requeue/i.test((sectionText(f.stateText, 'Last run') || '') + ' ' + (f.ledger[0] ? f.ledger[0].notes : '')) ? null
        : 'neither ## Last run nor the ledger note mentions the recovered item'),
    },
  },
}

// ---- fixture ---------------------------------------------------------------------------

// A two-file node project with a bootstrapped spine, committed on main.
export function buildFixture(P, scenario) {
  const sc = SCENARIOS[scenario]
  if (!sc) throw new Error(`unknown scenario: ${scenario}`)
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true })
    fs.writeFileSync(path.join(P, rel), text)
  }
  put('package.json', '{ "name": "math-demo", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n')
  put('src/math.js', 'export function add(a, b) {\n  return a + b\n}\n')
  put('test/math.test.js', "import test from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/math.js'\n\ntest('add', () => assert.equal(add(2, 3), 5))\n")
  put('.gitignore', '.tech-lead/worktree/\n.tech-lead/briefs/\n.tech-lead/worktree-deps.ok\n')
  put('.tech-lead/LOOP.md', sc.loop)
  put('.tech-lead/STATE.md', sc.state)
  put('.tech-lead/LEDGER.jsonl', '')
  execFileSync('git', ['init', '-q', '-b', 'main', P])
  git(P, 'add', '-A')
  git(P, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'initial, with the loop spine')
  git(P, 'config', 'user.name', 'fixture')
  git(P, 'config', 'user.email', 'fixture@example.invalid')
}
