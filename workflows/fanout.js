export const meta = {
  name: 'fanout',
  description: 'Parallel mechanical execution: one tech-lead:fast-worker per task, typed execution reports, contract checks in code',
  whenToUse: 'Three or more independent, fully specified mechanical tasks with disjoint file sets. args: {repo, tasks:[{id, brief, files:[abs paths]}]}',
  phases: [
    { title: 'Execute', detail: 'one fast-worker per task, JSON-schema execution report' },
    { title: 'Check', detail: 'code-only contract check: scope, judgment calls, verification' },
  ],
}

// Contract: references/decision-contracts.md ("Execution report"). Keep the two in sync.
// Git (branch/commit/push), the final verify run, and the ground-truth diff stay in the main session.
const A = args || {}
if (typeof A.repo !== 'string' || !A.repo.startsWith('/')) throw new Error('args.repo must be the absolute repo path')
if (!Array.isArray(A.tasks) || A.tasks.length === 0) throw new Error('args.tasks must be a non-empty array')

// Lexical normalization only (scripts have no filesystem): collapse //, ./ and ../ segments.
// Symlinks and case aliases must be resolved by the main session before dispatch.
const norm = p => {
  const out = []
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop(); else out.push(seg)
  }
  return '/' + out.join('/')
}
const repo = norm(A.repo)
const owner = new Map()
for (const t of A.tasks) {
  if (!t.id || !t.brief || !Array.isArray(t.files) || t.files.length === 0) throw new Error(`task ${t.id || '?'}: id, brief and a non-empty files[] are required`)
  if (!t.files.every(f => String(f).startsWith('/'))) throw new Error(`task ${t.id}: file paths must be absolute`)
  t.files = t.files.map(norm)
  for (const f of t.files) {
    if (!f.startsWith(repo + '/')) throw new Error(`task ${t.id}: ${f} is outside the repo ${repo}`)
    if (owner.has(f)) throw new Error(`tasks ${owner.get(f)} and ${t.id} both touch ${f}: file sets must be disjoint — merge or sequence them`)
    owner.set(f, t.id)
  }
}

const REPORT = {
  type: 'object',
  properties: {
    done: { type: 'string' },
    files_touched: { type: 'array', items: { type: 'string' }, description: 'absolute paths of every file you created, edited, or deleted' },
    verification: { type: 'array', items: { type: 'object', properties: {
      cmd: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, excerpt: { type: 'string' },
    }, required: ['cmd', 'result'] } },
    skipped_flagged: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, reason: { type: 'string' } }, required: ['item', 'reason'] } },
    judgment_calls: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, suggested_default: { type: 'string' } }, required: ['question'] } },
  },
  required: ['done', 'files_touched', 'verification', 'skipped_flagged', 'judgment_calls'],
}

const brief = t => `${t.brief}

EXECUTION CONTRACT
- Repo: ${repo}. Your shell cwd resets between Bash calls: run every command as \`cd ${repo} && …\` and use absolute paths for every Read/Edit/Write.
- Allowed files (touch nothing else, create nothing else):
${t.files.map(f => `  - ${f}`).join('\n')}
- Do not run git commands that change state (no commit, branch, checkout, stash, reset, push).
- Run the narrowest verification that exists for these files and report it. Other workers are editing other files in the same tree at the same time: do not run write-mode formatters or \`--fix\` linters, and do not fix failures in files outside your allowed list — report them instead. The orchestrator runs the project-wide verify afterwards.
- Any judgment call (two reasonable readings, a design choice): do not guess — leave that part undone and list it under judgment_calls with your suggested default.`

const results = await pipeline(
  A.tasks,
  t => agent(brief(t), { agentType: 'tech-lead:fast-worker', schema: REPORT, label: `exec:${t.id}`, phase: 'Execute' }),
  (r, t) => {
    if (!r) return { id: t.id, status: 'no-report', report: null, out_of_scope: [] }
    const allowed = new Set(t.files)
    const abs = f => norm(String(f).startsWith('/') ? String(f) : `${repo}/${f}`)
    const outOfScope = r.files_touched.map(abs).filter(f => !allowed.has(f))
    const status = outOfScope.length ? 'out-of-scope'
      : r.judgment_calls.length ? 'needs-decision'
      : r.verification.some(v => v.result === 'fail') ? 'verify-failed'
      : r.skipped_flagged.length ? 'incomplete'
      : 'ok'
    return { id: t.id, status, report: r, out_of_scope: outOfScope }
  },
)

const byStatus = {}
for (const r of results.filter(Boolean)) byStatus[r.status] = (byStatus[r.status] || 0) + 1
log(`fan-out: ${JSON.stringify(byStatus)}`)
return { summary: byStatus, results: results.filter(Boolean) }
