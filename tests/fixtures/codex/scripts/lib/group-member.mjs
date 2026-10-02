// tests/fixtures/codex/scripts/lib/group-member.mjs
// Test helper for the fake broker and the fake worker: a process that shares its parent's
// process group, standing in for what the real ones start in theirs (the app-server and its
// turns). startMembers(argv) handles `--member <file>` (a member that SIGTERM ends) and
// `--stubborn-member <file>` (one that ignores SIGTERM): it starts the member and writes
// its pid to file. Run as a script, this file is the member: it waits to be killed.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)

export function startMembers(argv) {
  for (const [flag, stubborn] of [['--member', false], ['--stubborn-member', true]]) {
    const i = argv.indexOf(flag)
    if (i < 0) continue
    // Not detached: the member stays in this process's group.
    const c = spawn(process.execPath, [SELF, ...(stubborn ? ['--ignore-term'] : [])], { stdio: 'ignore' })
    c.unref()
    fs.writeFileSync(argv[i + 1], String(c.pid))
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) {
  if (process.argv.includes('--ignore-term')) process.on('SIGTERM', () => {})
  setInterval(() => {}, 2 ** 30)
}
