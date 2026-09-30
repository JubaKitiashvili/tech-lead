// scripts/lib/runner.mjs
export function createRunner(out = console.log) {
  let passes = 0, fails = 0, warns = 0
  return {
    async check(name, fn) {
      try {
        await fn()
        passes++
      } catch (e) {
        fails++
        const msg = String(e && e.message ? e.message : e)
        out(`FAIL ${name}\n     ${msg.split('\n').join('\n     ')}`)
      }
    },
    warn(msg) { warns++; out(`WARN ${msg}`) },
    info(msg) { out(`INFO ${msg}`) },
    summary() { return { passes, fails, warns } },
  }
}
