// scripts/checks/workflows.mjs
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { loadWorkflow } from '../lib/workflow-loader.mjs'
import { extractBlock } from '../lib/registry-loader.mjs'

export async function checkWorkflows(ctx, r) {
  const dir = path.join(ctx.root, 'workflows')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
  for (const f of files) {
    await r.check(`compile workflows/${f}`, () => { ctx.wf[f] = loadWorkflow(path.join(dir, f)) })
  }
  await r.check('names: workflow meta names are unique', () => {
    const names = Object.values(ctx.wf).map(w => w.meta.name)
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [])
  })
  const decide = path.join(dir, 'decide.js')
  if (fs.existsSync(decide)) {
    await r.check('registry: workflows/decide.js has exactly one REGISTRY block', () => {
      extractBlock(fs.readFileSync(decide, 'utf8'), 'REGISTRY', { required: true })
    })
  } else {
    r.info('registry: workflows/decide.js does not exist yet (stage 1 adds it)')
  }
}
