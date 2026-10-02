#!/usr/bin/env node
// tests/fixtures/codex/app-server-broker.mjs
// Test double for the Codex broker process: `serve --endpoint <E> [--exit-after-ms <n>]`.
// It serves nothing; it carries the command line the real broker has (the companion starts
// `node app-server-broker.mjs serve --endpoint <E> --cwd <W> --pid-file <f>`), waits to be
// killed, or exits by itself after --exit-after-ms (a broker slow to shut down).
const argv = process.argv.slice(2)
const i = argv.indexOf('--exit-after-ms')
const ms = i >= 0 ? Number(argv[i + 1]) : 0
setInterval(() => {}, 2 ** 30)
if (ms > 0) setTimeout(() => process.exit(0), ms)
