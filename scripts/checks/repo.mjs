// scripts/checks/repo.mjs
// Repository consistency: manifest versus skill directories, names across skills,
// agents and workflows, documented Workflow args, bench tables, version, links.
// docs/ is not scanned: design docs name components that do not exist yet.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

export const frontmatter = md => {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  return Object.fromEntries(m[1].split('\n')
    .filter(l => /^\w[\w-]*:/.test(l))
    .map(l => [l.split(':')[0], l.slice(l.indexOf(':') + 1).trim()]))
}

export async function checkRepo(ctx, r) {
  const { root, rd } = ctx
  const manifest = JSON.parse(rd('.claude-plugin/plugin.json'))
  const agentFiles = fs.readdirSync(path.join(root, 'agents')).filter(f => f.endsWith('.md'))
  const agentNames = agentFiles.map(f => frontmatter(rd(`agents/${f}`)).name)
  const skillNames = manifest.skills.filter(s => s !== './').map(s => path.basename(s))
  const wfNames = Object.values(ctx.wf).map(w => w.meta.name)
  const wfSourceByName = Object.fromEntries(Object.entries(ctx.wf).map(([f, w]) => [w.meta.name, rd(`workflows/${f}`)]))
  const mdFiles = ['README.md', 'SKILL.md', 'templates/rules-tech-lead.md',
    ...['agents', 'references', 'skills'].flatMap(d =>
      fs.readdirSync(path.join(root, d), { recursive: true }).filter(f => f.endsWith('.md')).map(f => `${d}/${f}`))]

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
      for (const m of rd(f).matchAll(/Workflow\(\{\s*name:\s*"tech-lead:([a-z-]+)"/g)) {
        if (!wfNames.includes(m[1])) bad.push(`${f}: tech-lead:${m[1]}`)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('args: every documented Workflow args key is read by the script (A.<key>)', () => {
    const bad = []
    for (const f of mdFiles) {
      const text = rd(f)
      for (const m of text.matchAll(/Workflow\(\{\s*name:\s*"tech-lead:([a-z-]+)",\s*args:\s*\{/g)) {
        const src = wfSourceByName[m[1]]
        if (!src) continue
        let depth = 1, tok = ''
        const keys = []
        for (let i = m.index + m[0].length; i < text.length && depth > 0; i++) {
          const ch = text[i]
          if ('{['.includes(ch)) { depth++; continue }
          if ('}]'.includes(ch)) { depth--; continue }
          if (depth !== 1) continue
          if (/[A-Za-z_]/.test(ch)) tok += ch
          else { if (tok && /[:,}\s]/.test(ch)) keys.push(tok); tok = '' }
          if (ch === '"' || ch === '<') i = text.indexOf(ch === '"' ? '"' : '>', i + 1)
        }
        for (const k of new Set(keys)) if (!new RegExp(`A\\.${k}\\b`).test(src)) bad.push(`${f}: tech-lead:${m[1]} args.${k} is never read`)
      }
    }
    assert.deepEqual(bad, [])
  })

  if (ctx.wf['research.js']) {
    await r.check('fields: research SKILL.md §3 names only fields research.js returns', () => {
      const section = rd('skills/research/SKILL.md').match(/## 3 · Synthesize([\s\S]*?)## 4/)[1]
      const src = rd('workflows/research.js')
      const returned = src.slice(src.indexOf('return {'))
      const bad = [...section.matchAll(/`([a-z_]+)`/g)].map(x => x[1]).filter(k => !new RegExp(`\\b${k}\\b`).test(returned))
      assert.deepEqual(bad, [])
    })
  }

  await r.check('names: every agentType in workflows is a plugin agent or an external agent', () => {
    for (const f of Object.keys(ctx.wf)) {
      for (const m of rd(`workflows/${f}`).matchAll(/agentType: '([^']+)'/g)) {
        const [ns, name] = m[1].split(':')
        if (ns === 'tech-lead') assert.ok(agentNames.includes(name), `${f}: ${m[1]}`)
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

  const installed = path.join(os.homedir(), '.claude/rules/tech-lead.md')
  if (fs.existsSync(installed) && fs.readFileSync(installed, 'utf8') !== rd('templates/rules-tech-lead.md')) {
    r.warn(`${installed} differs from templates/rules-tech-lead.md: re-copy it`)
  }
}
