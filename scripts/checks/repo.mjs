// scripts/checks/repo.mjs
// Repository consistency: manifest versus skill directories, names across skills,
// agents and workflows, documented Workflow args, bench tables, version, links.
// docs/ is not scanned: design docs name components that do not exist yet.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { stringLiterals } from '../lib/js-scan.mjs'

export const frontmatter = md => {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  return Object.fromEntries(m[1].split('\n')
    .filter(l => /^\w[\w-]*:/.test(l))
    .map(l => [l.split(':')[0], l.slice(l.indexOf(':') + 1).trim()]))
}

// The plugin's docs, relative to root: every file the model or the user reads as prose.
export const docFiles = root => ['README.md', 'SKILL.md', 'templates/rules-tech-lead.md',
  ...['agents', 'references', 'skills'].flatMap(d =>
    fs.readdirSync(path.join(root, d), { recursive: true }).filter(f => f.endsWith('.md')).map(f => `${d}/${f}`))]

export async function checkRepo(ctx, r) {
  const { root, rd } = ctx
  const manifest = JSON.parse(rd('.claude-plugin/plugin.json'))
  const agentFiles = fs.readdirSync(path.join(root, 'agents')).filter(f => f.endsWith('.md'))
  const agentNames = agentFiles.map(f => frontmatter(rd(`agents/${f}`)).name)
  const skillNames = manifest.skills.filter(s => s !== './').map(s => path.basename(s))
  const wfNames = Object.values(ctx.wf).map(w => w.meta.name)
  const wfSourceByName = Object.fromEntries(Object.entries(ctx.wf).map(([f, w]) => [w.meta.name, rd(`workflows/${f}`)]))
  const mdFiles = docFiles(root)

  await r.check('manifest: every skills entry has a SKILL.md whose name matches', () => {
    for (const s of manifest.skills) {
      const f = frontmatter(rd(path.join(s, 'SKILL.md')))
      assert.equal(f.name, s === './' ? manifest.name : path.basename(s), s)
      assert.ok(f.description && f.description.length > 40, `${s}: description`)
    }
  })

  await r.check('manifest: every skills/*/SKILL.md is listed', () => {
    const dirs = fs.readdirSync(path.join(root, 'skills')).filter(d => fs.existsSync(path.join(root, 'skills', d, 'SKILL.md')))
    for (const d of dirs) assert.ok(manifest.skills.includes(`./skills/${d}`), `skills/${d} not in plugin.json`)
  })

  await r.check('names: agent frontmatter name matches its file name', () => {
    agentFiles.forEach((f, i) => assert.equal(agentNames[i], f.slice(0, -3), `agents/${f}`))
  })

  await r.check('names: workflow names do not shadow skill names', () => {
    assert.deepEqual(wfNames.filter(n => skillNames.includes(n)), [])
  })

  await r.check('names: every Workflow({name: "tech-lead:X"}) in docs is a registered workflow', () => {
    const bad = []
    for (const f of mdFiles) {
      for (const m of rd(f).matchAll(/Workflow\(\{\s*name:\s*(['"])tech-lead:([a-z-]+)\1/g)) {
        if (!wfNames.includes(m[2])) bad.push(`${f}: tech-lead:${m[2]}`)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('args: every documented Workflow args key is read by the script (A.<key>)', () => {
    const bad = []
    for (const f of mdFiles) {
      const text = rd(f)
      for (const m of text.matchAll(/Workflow\(\{\s*name:\s*(['"])tech-lead:([a-z-]+)\1,\s*args:\s*\{/g)) {
        const name = m[2], src = wfSourceByName[name]
        if (!src) continue
        // Keys of the args object at depth 1: an identifier before `:`, a shorthand name,
        // or a quoted key. Values, nested objects and "…" or <…> placeholders are skipped.
        let depth = 1, tok = '', expectKey = true, open = true
        const keys = []
        const flush = () => { if (tok && expectKey) keys.push(tok); tok = '' }
        for (let i = m.index + m[0].length; i < text.length && depth > 0; i++) {
          const ch = text[i]
          if (depth === 1 && (/[A-Za-z_]/.test(ch) || (tok && /\d/.test(ch)))) { tok += ch; continue }
          if (depth === 1) flush()
          if ('{['.includes(ch)) { depth++; continue }
          if ('}]'.includes(ch)) { depth--; continue }
          if (depth !== 1) continue
          if (ch === ':') expectKey = false
          else if (ch === ',') expectKey = true
          else if (ch === '"' || ch === '<') {
            const close = text.indexOf(ch === '"' ? '"' : '>', i + 1)
            if (close === -1) { open = false; break }
            if (ch === '"' && expectKey && /^\s*:/.test(text.slice(close + 1))) keys.push(text.slice(i + 1, close))
            i = close
          }
        }
        if (!open || depth > 0) { bad.push(`${f}: tech-lead:${name} args block is not terminated`); continue }
        for (const k of new Set(keys)) if (!new RegExp(`A\\.${k}\\b`).test(src)) bad.push(`${f}: tech-lead:${name} args.${k} is never read`)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('names: every agentType in workflows is a plugin agent or an external agent', () => {
    for (const f of Object.keys(ctx.wf)) {
      for (const m of rd(`workflows/${f}`).matchAll(/agentType:\s*(['"])([^'"]+)\1/g)) {
        const [ns, name] = m[2].split(':')
        if (ns === 'tech-lead') assert.ok(agentNames.includes(name), `${f}: ${m[2]}`)
      }
    }
  })

  await r.check('names: every tech-lead:X token in docs resolves to a skill, agent or workflow', () => {
    const known = new Set([...skillNames, ...agentNames, ...wfNames, 'tech-lead'])
    const bad = []
    for (const f of mdFiles) for (const m of rd(f).matchAll(/tech-lead:([a-z][a-z-]*)/g)) if (!known.has(m[1])) bad.push(`${f}: tech-lead:${m[1]}`)
    assert.deepEqual([...new Set(bad)], [])
  })

  await r.check('dup: agent model, effort and tools restated in README and SKILL.md bench tables', () => {
    const bad = []
    for (const f of agentFiles) {
      const a = frontmatter(rd(`agents/${f}`))
      const id = `\`tech-lead:${a.name}\``
      const readmeRow = rd('README.md').split('\n').find(l => l.startsWith(`| ${id}`)) || ''
      const skillRow = rd('SKILL.md').split('\n').find(l => l.startsWith(`| ${id}`)) || ''
      if (!readmeRow.includes(`\`${a.model}\``)) bad.push(`README bench row for ${a.name} lacks model ${a.model}`)
      if (a.effort && !readmeRow.includes(`\`${a.effort}\``)) bad.push(`README bench row for ${a.name} lacks effort ${a.effort}`)
      if (a.effort && !skillRow.includes(`effort: ${a.effort}`)) bad.push(`SKILL.md bench row for ${a.name} lacks effort ${a.effort}`)
      for (const t of JSON.parse(a.tools || '[]')) if (!readmeRow.includes(t)) bad.push(`README bench row for ${a.name} lacks tool ${t}`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('version: README "Version X" == plugin.json version', () => {
    const m = rd('README.md').match(/\*\*Version (\d+\.\d+\.\d+)\.\*\*/)
    assert.ok(m, 'README version line missing')
    assert.equal(m[1], manifest.version)
  })

  await r.check('links: relative .md and .js paths in backticks resolve', () => {
    const bad = []
    for (const f of mdFiles) {
      for (const m of rd(f).matchAll(/`((?:\.\.\/)+[\w./-]+\.(?:md|js)|references\/[\w./-]+\.md|workflows\/[\w-]+\.js)`/g)) {
        const p = m[1]
        const base = p.startsWith('..') ? path.dirname(f) : (f.startsWith('skills/') && p.startsWith('references/') ? path.dirname(f) : '.')
        if (!fs.existsSync(path.join(root, base, p))) bad.push(`${f}: ${p}`)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('models: no agent or workflow names fable or best', () => {
    // A string that is a Fable model name or id, or the `best` alias (same as `opus` since v2.1.321, Fable before),
    // anywhere in workflow code: a default, an allow-list, a registry entry, a model field.
    const fableName = s => /^(best|(claude-)?fable[-\w.]*)$/i.test(s.trim())
    const bad = []
    for (const f of agentFiles) {
      const model = (frontmatter(rd(`agents/${f}`)).model || '').replace(/^['"]|['"]$/g, '')
      if (fableName(model)) bad.push(`agents/${f}: model ${model}`)
    }
    for (const f of Object.keys(ctx.wf)) {
      for (const lit of stringLiterals(rd(`workflows/${f}`))) if (fableName(lit)) bad.push(`workflows/${f}: '${lit}'`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('bench: every agent pins a model and none can spawn agents', () => {
    // No model: the agent inherits the session model. The Agent tool: a delegate could start
    // its own delegates, and the counts the workflows fix in code would stop holding.
    const bad = []
    for (const f of agentFiles) {
      const a = frontmatter(rd(`agents/${f}`))
      if (!a.model) bad.push(`agents/${f}: no model`)
      for (const t of JSON.parse(a.tools || '[]')) if (/^(Agent|Task|Workflow)$/.test(t)) bad.push(`agents/${f}: tool ${t}`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('scripts: every scripts/*.mjs path the docs name exists', () => {
    // Paths the plugin owns: after `<T>/`, a backtick or a space. A companion path such as
    // `…/codex/*/scripts/codex-companion.mjs` belongs to another plugin and is skipped.
    const bad = []
    for (const f of mdFiles) {
      for (const m of rd(f).matchAll(/(?:<T>\/|[`\s])(scripts\/[\w-]+(?:\/[\w-]+)*\.mjs)\b/g)) {
        if (!fs.existsSync(path.join(root, m[1]))) bad.push(`${f}: ${m[1]}`)
      }
    }
    assert.deepEqual([...new Set(bad)], [])
  })

  await r.check('runners: no doc tells the model to pass CronCreate a durable flag', () => {
    // CronCreate jobs are session-only; `durable` has no effect (spec §7.6, audit cons01).
    assert.deepEqual(mdFiles.filter(f => /\bdurable\s*:\s*true\b/.test(rd(f))), [])
  })

  const installed = path.join(os.homedir(), '.claude/rules/tech-lead.md')
  if (fs.existsSync(installed) && fs.readFileSync(installed, 'utf8') !== rd('templates/rules-tech-lead.md')) {
    r.warn(`${installed} differs from templates/rules-tech-lead.md: re-copy it`)
  }
}
