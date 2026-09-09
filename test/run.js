#!/usr/bin/env node
// The test runner, because `node --test test/` was three bugs wearing one coat.
//
// 1. It named a directory. Node 26 stopped resolving that as a directory and tried to load `test`
//    as a module, so `npm test` failed with MODULE_NOT_FOUND — nothing to do with any test.
// 2. It named the WRONG directory. Eight of this repo's nine test files live beside the code they
//    cover, under src/. So even on a Node that ran it, `npm test` exercised one ninth of the suite
//    and reported green. A suite whose denominator quietly shrinks is worse than no suite: it is a
//    green light nobody has any reason to distrust.
// 3. It ran them in parallel. Several of these launch a real headless Chrome, and the PDF suite's
//    30-second navigation budget loses to five browsers competing for one machine. It then fails
//    with nothing wrong with it — starvation wearing the costume of a bug. Run alone it passes 7/7.
//
// So: find every test file, say how many, refuse to run if that number looks wrong, and run them
// one at a time.

import { globSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = [...globSync('src/**/*.test.js'), ...globSync('test/**/*.test.js')].sort()

// A glob that silently matches nothing is the same failure as (2), and it exits 0 by default.
// The count is the evidence, so the count has to be checked.
if (files.length === 0) {
  console.error('No test files matched. That is a broken runner, not a passing suite.')
  process.exit(1)
}

console.log(`${files.length} test file(s), one at a time:`)
for (const f of files) console.log(`  ${f}`)
console.log()

// --test-concurrency=1 is deliberate and costs real time. The alternative is raising the browser
// timeouts, which does not fix contention — it only makes it slower and quieter.
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
