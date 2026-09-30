// scripts/lib/workflow-probes.mjs
// Runs the current workflows on fixed inputs to capture the schemas they pass to
// agent() and the enum values they return. Probes only; behaviour is tested in tests/workflows.
export async function probeWorkflows(wf) {
  const schemas = {}
  const observed = { fanoutStatus: new Set(), panelAgreement: new Set(), triageAgreement: new Set() }

  const T = wf['triage.js']
  if (T) {
    const sig = o => ({ public_api: false, data_model_or_migration: false, security_or_auth: false, major_dependency: false, unresolved_design_choice: false, spec_complete: true, ...o })
    for (const [orch, verdict] of [
      ['mechanical', { class: 'mechanical', signals: sig(), reason: 'r' }],
      ['mechanical', { class: 'mechanical', signals: sig({ public_api: true }), reason: 'r' }],
      ['high-stakes', { class: 'hard', signals: sig(), reason: 'r' }],
      ['hard', null],
    ]) {
      const { result } = await T.run({ item: { title: 't', notes: 'n' }, orchestratorClass: orch }, (p, o) => { schemas.triage = o.schema; return verdict })
      observed.triageAgreement.add(result.agreement)
    }
  }

  const F = wf['fanout.js']
  if (F) {
    const rep = o => ({ done: 'd', files_touched: [], verification: [], skipped_flagged: [], judgment_calls: [], ...o })
    const reports = {
      a: rep(),
      b: rep({ files_touched: ['/r/x.js'] }),
      c: rep({ judgment_calls: [{ question: 'q' }] }),
      d: rep({ verification: [{ cmd: 't', result: 'fail' }] }),
      e: rep({ skipped_flagged: [{ item: 'i', reason: 'r' }] }),
      f: null,
    }
    const tasks = Object.keys(reports).map(id => ({ id, brief: 'do it', files: [`/r/${id}.js`] }))
    const { result } = await F.run({ repo: '/r', tasks }, (p, o) => { schemas.execution = o.schema; return reports[o.label.slice('exec:'.length)] })
    for (const t of result.results) observed.fanoutStatus.add(t.status)
  }

  const P = wf['panel.js']
  if (P) {
    const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const V = rec => ({ recommendation: rec, confidence: 'high', reasons: [], rejected: [], load_bearing_assumptions: [], risks: [] })
    for (const [a, b, n] of [
      [V('a'), 'analysis', { empty: false, verdict: V('a') }],
      [V('a'), 'analysis', { empty: false, verdict: V('b') }],
      [V('a'), 'SEAT-EMPTY: none', null],
      [null, 'job 1 queued', { empty: true, empty_reason: 'job id' }],
    ]) {
      const { result } = await P.run({ briefPath: '/tmp/b.md', options }, (p, o) => {
        if (o.agentType === 'tech-lead:deep-reasoner') { schemas.panel = o.schema; return a }
        if (o.agentType === 'codex:codex-rescue') return b
        return n
      })
      observed.panelAgreement.add(result.agreement)
    }
  }

  return { schemas, observed }
}
