// Audits to build and test the report against.
//
// It scores the committed Measurement fixtures with the real scorer, so the layout is always being
// exercised against whatever `src/score/` currently emits — including any finding vera adds
// tomorrow that I have never seen. There is no hand-written finding data here and there should
// never be any again: a document that only ever renders findings its own author wrote has not been
// proven against the ones it will actually be given.
//
// (It briefly carried a snapshot of vera's output, captured out-of-tree while scoring was still on
// her branch. That is deleted now that scoring is on main, along with the check that existed to
// stop the snapshot quietly keeping the suite green.)

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { score } from '../score/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '..', '..', 'fixtures')

export const SAMPLES = ['neglected', 'solid', 'unreachable']

/** The businesses are the CLI's input, not the scorer's output, so they live here. */
const BUSINESSES = {
  neglected: { name: 'Example Construction', url: 'http://example-construction.ca', town: 'Grand Falls-Windsor', sector: 'construction', phone: '709-555-0142' },
  solid: { name: 'Example Tours', url: 'https://example-tours.ca', town: 'Twillingate', sector: 'tourism', phone: '709-555-0188' },
  unreachable: { name: 'Example Gone', url: 'https://example-gone.ca', town: 'Springdale', sector: 'retail' }
}

export function measurement (name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
}

/** @returns {import('../contract.js').Audit} */
export function sampleAudit (name, over = {}) {
  const m = measurement(name)
  const { score: s, findings } = score(m)
  return {
    business: BUSINESSES[name],
    measurement: m,
    score: s,
    findings,
    // Fixed, so two renders of the same fixture are byte-identical and a diff means something.
    generatedAt: '2026-09-08T14:00:00.000Z',
    ...over
  }
}
