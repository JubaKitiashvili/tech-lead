#!/usr/bin/env node
// Repository checks for the tech-lead plugin. Zero dependencies.
// Usage: node scripts/check.mjs [pluginRoot]   (default: this script's plugin)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRunner } from './lib/runner.mjs'
import { checkWorkflows } from './checks/workflows.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(process.argv[2] || path.join(here, '..'))
const ctx = { root, rd: p => fs.readFileSync(path.join(root, p), 'utf8'), wf: {} }
const r = createRunner()

await checkWorkflows(ctx, r)

const s = r.summary()
console.log(`\n${s.passes} passed, ${s.fails} failed, ${s.warns} warnings`)
process.exit(s.fails ? 1 : 0)
