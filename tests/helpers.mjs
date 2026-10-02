// tests/helpers.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflow } from '../scripts/lib/workflow-loader.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const load = name => loadWorkflow(path.join(ROOT, 'workflows', name))
