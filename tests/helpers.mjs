// tests/helpers.mjs
// ROOT (the plugin checkout), load(name) (a workflows/ script in the stub runtime), and
// GIT_ROUTING / scrubGitRouting(env): the inherited variables that send a plain `git -C <dir>`
// to another repository, index, object store or configuration, and their removal from env.
// Importing this module scrubs them from process.env, so every test file that imports it,
// directly or through a fixture, runs git only where it says.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflow } from '../scripts/lib/workflow-loader.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const load = name => loadWorkflow(path.join(ROOT, 'workflows', name))

// `git -C` does not override any of these (git environment(7)): a suite run with, say,
// GIT_INDEX_FILE set would have a test's `git add -A` write that index. They are scrubbed from
// process.env when this module loads (below); a test that wants one hostile override sets it
// explicitly afterwards, in the env it passes.
export const GIT_ROUTING = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
])
const ROUTING_PREFIX = /^GIT_CONFIG_(?:KEY|VALUE)_/

// Deletes GIT_ROUTING and every GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> from env, in place;
// returns env.
export function scrubGitRouting(env) {
  for (const k of Object.keys(env)) if (GIT_ROUTING.includes(k) || ROUTING_PREFIX.test(k)) delete env[k]
  return env
}
scrubGitRouting(process.env)
