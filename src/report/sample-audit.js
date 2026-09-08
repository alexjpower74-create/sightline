// Audits to build and test the report against, before the CLI exists to make one.
//
// It prefers the real thing. If `src/score/` is present it scores the committed Measurement
// fixtures for real, so the layout is always being exercised against whatever the scorer currently
// emits — including any finding vera adds tomorrow that I have never seen.
//
// `scored-fixtures.json` is the fallback, and it is not invented: it is the literal output of
// `score()` at rig/vera 40c0d72, captured by running that commit out-of-tree. It exists only
// because scoring has not reached `main` yet. `usedRealScorer()` says which path was taken, and a
// test asserts on it — so the day scoring lands, a stale snapshot cannot quietly keep passing.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '..', '..', 'fixtures')

export const SAMPLES = ['neglected', 'solid', 'unreachable']

/** Real businesses are the CLI's input, not the scorer's output, so they live here either way. */
const BUSINESSES = {
  neglected: { name: 'Example Construction', url: 'http://example-construction.ca', town: 'Grand Falls-Windsor', sector: 'construction', phone: '709-555-0142' },
  solid: { name: 'Example Tours', url: 'https://example-tours.ca', town: 'Twillingate', sector: 'tourism', phone: '709-555-0188' },
  unreachable: { name: 'Example Gone', url: 'https://example-gone.ca', town: 'Springdale', sector: 'retail' }
}

export function measurement (name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
}

let scorer = null
try {
  scorer = await import('../score/index.js')
} catch {
  scorer = null   // scoring has not been merged into this branch yet
}

export function usedRealScorer () {
  return scorer != null && typeof scorer.score === 'function'
}

const SNAPSHOT = JSON.parse(readFileSync(join(here, 'scored-fixtures.json'), 'utf8'))

/** @returns {import('../contract.js').Audit} */
export function sampleAudit (name, over = {}) {
  const m = measurement(name)
  const { score, findings } = usedRealScorer() ? scorer.score(m) : SNAPSHOT[name]
  return {
    business: BUSINESSES[name],
    measurement: m,
    score,
    findings,
    // Fixed, so two renders of the same fixture are byte-identical and a diff means something.
    generatedAt: '2026-09-08T14:00:00.000Z',
    ...over
  }
}
