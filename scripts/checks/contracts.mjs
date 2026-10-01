// scripts/checks/contracts.mjs
// "Keep the two in sync" pairs: JSON contracts in references/decision-contracts.md
// versus the schemas in the workflows, enum lists the docs restate, and what the
// probes saw the workflows dispatch and return. Every check is keyed on the workflow
// file being present, never on what a probe happened to capture, so a workflow that
// stops passing a schema fails instead of dropping its check.
import assert from 'node:assert/strict'
import { PROBES, emptyProbeResult } from '../lib/workflow-probes.mjs'

// Shape of a documented JSON example versus a JSON schema: the same keys at every
// level, and the same enum values where the doc writes `a|b|c`.
export function shapeDiff(doc, schema, at = '$') {
  const out = []
  if (schema.type === 'object') {
    const dk = Object.keys(doc || {}).sort(), sk = Object.keys(schema.properties || {}).sort()
    for (const k of sk) if (!dk.includes(k)) out.push(`${at}.${k}: in schema, missing from doc`)
    for (const k of dk) if (!sk.includes(k)) out.push(`${at}.${k}: in doc, missing from schema`)
    for (const k of sk) if (dk.includes(k)) out.push(...shapeDiff(doc[k], schema.properties[k], `${at}.${k}`))
  } else if (schema.type === 'array' && Array.isArray(doc) && doc.length && schema.items) {
    out.push(...shapeDiff(doc[0], schema.items, `${at}[]`))
  } else if (schema.enum && typeof doc === 'string' && doc.includes('|') && !doc.includes('<')) {
    const d = doc.split('|').map(s => s.trim()).sort(), s = [...schema.enum].sort()
    if (JSON.stringify(d) !== JSON.stringify(s)) out.push(`${at}: doc enum ${d.join('|')} != schema enum ${s.join('|')}`)
  }
  return out
}

const jsonAfter = (md, heading) => {
  const i = md.indexOf(heading)
  if (i < 0) throw new Error(`heading not found: ${heading}`)
  const m = md.slice(i).match(/`{3}json\n([\s\S]*?)`{3}/)
  if (!m) throw new Error(`no json block after: ${heading}`)
  return JSON.parse(m[1])
}
const ticks = s => [...s.matchAll(/`([a-z-]+)`/g)].map(m => m[1])
const tableTicks = (md, header) => {
  const i = md.indexOf(header)
  if (i < 0) throw new Error(`table header not found: ${header}`)
  const out = []
  for (const row of md.slice(i).split('\n').slice(2)) {
    if (!row.startsWith('|')) break
    const cells = row.split('|')
    out.push(...ticks(cells[1]), ...ticks(cells[2] || ''))
  }
  return out
}
const pipeEnum = (text, re) => {
  const m = text.match(re)
  if (!m) throw new Error(`pattern not found: ${re}`)
  return m[1].split('|').map(s => s.replace(/[`<>\s]/g, '')).filter(Boolean)
}

export async function checkContracts(ctx, r) {
  const got = emptyProbeResult()
  for (const [file, probe] of Object.entries(PROBES)) {
    if (ctx.wf[file]) await r.check(`probe workflows/${file}`, () => probe(ctx.wf[file], got))
  }
  const { schemas, observed } = got
  const contracts = ctx.rd('references/decision-contracts.md')
  const templates = ctx.rd('skills/loop/references/loop-templates.md')
  const same = (name, found, want) => r.check(name, () => assert.deepEqual([...new Set(found)].sort(), [...want].sort()))
  const schema = (key, what) => {
    assert.ok(schemas[key], what)
    return schemas[key]
  }

  if (ctx.wf['panel.js']) {
    await r.check('contract: Panel verdict == panel.js VERDICT', () =>
      assert.deepEqual(shapeDiff(jsonAfter(contracts, '### Panel verdict'), schema('panel', 'panel.js passed no schema to seat A')), []))
    await same('enum: panel agreement, decision-contracts.md', pipeEnum(contracts, /`agreement` ∈ ([^,\n]+),/), observed.panelAgreement)
    await same('enum: panel agreement, loop-templates.md Needs-decision entry', pipeEnum(templates, /\*\*Agreement:\*\* <([^>]+)>/), observed.panelAgreement)
    await same('enum: panel agreement, loop-templates.md ledger', pipeEnum(templates, /"panel": \{[^}]*"agreement": "<([^>]+)>"/), observed.panelAgreement)
    await same('enum: panel agreement, skills/panel/SKILL.md present shape', pipeEnum(ctx.rd('skills/panel/SKILL.md'), /\*\*Agreement:\*\* <([^>]+)>/), observed.panelAgreement)
  }
  if (ctx.wf['fanout.js']) {
    await r.check('contract: Execution report == fanout.js REPORT', () =>
      assert.deepEqual(shapeDiff(jsonAfter(contracts, '### Execution report'), schema('execution', 'fanout.js passed no schema to its workers')), []))
    await same('enum: fanout statuses in decision-contracts table',
      tableTicks(contracts, '| Condition | `status` |').filter(x => observed.fanoutStatus.has(x) || /^[a-z]+(-[a-z]+)+$|^ok$/.test(x)),
      observed.fanoutStatus)
    await same('enum: fanout statuses in SKILL.md "Handling fanout.js results"',
      tableTicks(ctx.rd('SKILL.md'), '| `status` | What you do |'), observed.fanoutStatus)
  }
  if (ctx.wf['triage.js']) {
    await r.check('contract: Triage verdict == triage.js TRIAGE', () =>
      assert.deepEqual(shapeDiff(jsonAfter(contracts, '### Triage verdict'), schema('triage', 'triage.js passed no schema to the triage agent')), []))
    await r.check('contract: agents/triage.md fallback JSON == triage.js TRIAGE', () => {
      const line = ctx.rd('agents/triage.md').trim().split('\n').pop()
      assert.deepEqual(shapeDiff(JSON.parse(line), schema('triage', 'triage.js passed no schema to the triage agent')), [])
    })
    await same('enum: triage agreement, loop-templates.md ledger', pipeEnum(templates, /"agreement": "<(agree\|escalated[^>]+)>"/), observed.triageAgreement)
  }
  if (ctx.wf['research.js']) {
    await r.check('fields: research SKILL.md §3 names only fields research.js returns', () => {
      const returned = got.returned.research || new Set()
      const section = ctx.rd('skills/research/SKILL.md').match(/## 3 · Synthesize([\s\S]*?)## 4/)[1]
      assert.deepEqual([...section.matchAll(/`([a-z_]+)`/g)].map(x => x[1]).filter(k => !returned.has(k)), [])
    })
  }
  await r.check('models: no probed agent() call dispatches fable or best', () => {
    assert.deepEqual([...got.models].filter(m => /fable|^best$/i.test(m)), [])
  })
  const budget = s => s.match(/whose\s+outcome is ([^.]+)\./)[1].replace(/\n/g, ' ')
  await r.check('dup: daily-budget outcomes, loop SKILL.md §2 == loop-templates.md', () => {
    assert.deepEqual(ticks(budget(ctx.rd('skills/loop/SKILL.md'))).sort(), ticks(budget(templates)).sort())
  })
  await r.check('dup: bootstrap .gitignore lines == loop-templates.md block', () => {
    const tpl = templates.match(/## Project \.gitignore addition[\s\S]*?`{3}\n([\s\S]*?)`{3}/)[1].trim().split('\n')
    const section = ctx.rd('skills/loop/references/bootstrap.md').match(/\*\*Update `\.gitignore`\.\*\*([\s\S]*?)6\./)[1]
    const bootPaths = [...section.matchAll(/`(\.tech-lead\/[^`]+)`/g)].map(m => m[1])
    assert.deepEqual(bootPaths.sort(), tpl.sort())
  })
  await r.check('dup: README LOOP.md defaults == loop-templates.md LOOP.md template', () => {
    const yaml = (md, heading) => {
      const i = md.indexOf(heading)
      if (i < 0) throw new Error(`heading not found: ${heading}`)
      const m = md.slice(i).match(/`{3}yaml\n([\s\S]*?)`{3}/)
      if (!m) throw new Error(`no yaml block after: ${heading}`)
      return m[1]
    }
    assert.equal(yaml(ctx.rd('README.md'), 'The `LOOP.md` defaults:'), yaml(templates, '## LOOP.md template'))
  })
}
