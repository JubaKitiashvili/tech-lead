// scripts/lib/workflow-probes.mjs
// Runs the current workflows on fixed inputs to capture the schemas they pass to
// agent(), the models they dispatch, the enum values they return, and the keys of
// what they return. Probes only; behaviour is tested in tests/workflows.

export const emptyProbeResult = () => ({
  schemas: {},
  observed: { fanoutStatus: new Set(), panelAgreement: new Set(), triageAgreement: new Set() },
  models: new Set(),
  returned: {},
})

const recordModels = (got, calls) => { for (const c of calls) if (c.opts.model) got.models.add(c.opts.model) }

// One probe per workflow file. Each records into `got` and may throw; the caller
// runs each one as its own check.
export const PROBES = {
  async 'triage.js'(T, got) {
    const sig = o => ({ public_api: false, data_model_or_migration: false, security_or_auth: false, major_dependency: false, unresolved_design_choice: false, spec_complete: true, ...o })
    for (const [orch, verdict] of [
      ['mechanical', { class: 'mechanical', signals: sig(), reason: 'r' }],
      ['mechanical', { class: 'mechanical', signals: sig({ public_api: true }), reason: 'r' }],
      ['high-stakes', { class: 'hard', signals: sig(), reason: 'r' }],
      ['hard', null],
    ]) {
      const { result, calls } = await T.run({ item: { title: 't', notes: 'n' }, orchestratorClass: orch }, (p, o) => { got.schemas.triage = o.schema; return verdict })
      got.observed.triageAgreement.add(result.agreement)
      recordModels(got, calls)
    }
  },

  async 'fanout.js'(F, got) {
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
    const { result, calls } = await F.run({ repo: '/r', tasks }, (p, o) => { got.schemas.execution = o.schema; return reports[o.label.slice('exec:'.length)] })
    for (const t of result.results) got.observed.fanoutStatus.add(t.status)
    recordModels(got, calls)
  },

  async 'panel.js'(P, got) {
    const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const V = rec => ({ recommendation: rec, confidence: 'high', reasons: [], rejected: [], load_bearing_assumptions: [], risks: [] })
    for (const [a, b, n] of [
      [V('a'), 'analysis', { empty: false, verdict: V('a') }],
      [V('a'), 'analysis', { empty: false, verdict: V('b') }],
      [V('a'), 'SEAT-EMPTY: none', null],
      [null, 'job 1 queued', { empty: true, empty_reason: 'job id' }],
    ]) {
      const { result, calls } = await P.run({ briefPath: '/tmp/b.md', options }, (p, o) => {
        if (o.agentType === 'tech-lead:deep-reasoner') { if (o.schema) got.schemas.panel = o.schema; return a }
        if (o.agentType === 'codex:codex-rescue') return b
        return n
      })
      got.observed.panelAgreement.add(result.agreement)
      recordModels(got, calls)
    }
  },

  async 'research.js'(R, got) {
    const report = { summary: 's', facts: [], open_questions: [] }
    const verdict = { confirmed_facts: [], verified_ideas: [], verified_risks: [], refuted: [], unverifiable: [], corrected_summary: 'c' }
    const { result, calls } = await R.run({ question: 'q', scratch: '/tmp/s' }, (p, o) => (o.label.startsWith('research:') ? report : verdict))
    got.returned.research = new Set([...Object.keys(result), ...Object.keys((result.lanes || [])[0] || {})])
    recordModels(got, calls)
  },
}
