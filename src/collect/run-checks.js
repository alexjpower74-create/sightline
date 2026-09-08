#!/usr/bin/env node
// Every check in this slice, in one command:
//
//   node src/collect/run-checks.js
//
// Each suite is a separate process because each drives its own Chrome on its own debugging port.
// Exit code is non-zero if anything failed OR if any check came back VOID — a check that passes
// against a page you broke on purpose is not evidence, and the run should say so.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = ['contrast.test.js', 'collect.test.js', 'resilience.test.js']

let bad = 0
for (const s of suites) {
  const code = await new Promise(res => spawn(process.execPath, [join(here, s)], { stdio: 'inherit' }).on('exit', res))
  if (code !== 0) bad++
}
console.log(bad ? `\n${bad} suite(s) did not come back clean.` : '\nAll suites clean: no failures, no void checks.')
process.exit(bad ? 1 : 0)
