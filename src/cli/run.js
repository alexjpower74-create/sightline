// The pipeline, wired end to end.
//
// collect/ and report/ are owned by other slices and land on their own schedule, so they are
// imported lazily and their absence is reported as a plain sentence rather than a stack trace.
// A tool that explodes because half of it is not merged yet is not usable during a build.

import { score, rank, explain } from '../score/index.js'
import { assertAudit } from '../contract.js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

async function need (spec, what) {
  try { return await import(spec) } catch (e) {
    throw new Error(`The ${what} is not available yet (${spec}).\n  This slice is still being built. You can still run \`sightline score\` and \`sightline explain\` against a saved measurement.`)
  }
}

/** One business, all the way through. */
export async function auditOne (business, opts = {}) {
  const { collect } = await need('../collect/index.js', 'collector')
  const outDir = opts.outDir || 'out'
  mkdirSync(outDir, { recursive: true })

  const measurement = await collect(business.url, { outDir, timeoutMs: opts.timeoutMs ?? 45_000 })
  const { score: s, findings } = score(measurement)
  return assertAudit({ business, measurement, score: s, findings, generatedAt: new Date().toISOString() })
}

/** A list of businesses, ranked so a shop knows who to phone first. */
export async function auditMany (businesses, opts = {}) {
  const audits = []
  for (const [i, b] of businesses.entries()) {
    process.stderr.write(`  [${i + 1}/${businesses.length}] ${b.name} … `)
    try {
      const a = await auditOne(b, opts)
      audits.push(a)
      process.stderr.write(a.score.overall === null ? 'unreachable\n' : `${a.score.overall}/100\n`)
    } catch (e) {
      process.stderr.write(`failed: ${e.message.split('\n')[0]}\n`)
    }
  }
  return rank(audits)
}

export async function writeReports (audits, outDir) {
  const { renderHtml, renderPdf } = await need('../report/index.js', 'report renderer')
  mkdirSync(outDir, { recursive: true })
  const written = []
  for (const a of audits) {
    const slug = a.business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const html = join(outDir, `${slug}.html`)
    writeFileSync(html, renderHtml(a))
    written.push(html)
    try { written.push(await renderPdf(a, join(outDir, `${slug}.pdf`))) } catch (e) {
      process.stderr.write(`  (pdf failed for ${a.business.name}: ${e.message})\n`)
    }
  }
  return written
}

/** The call list. This is the artefact a two-person shop actually acts on. */
export function callList (audits) {
  const rows = audits.map(a => ({
    name: a.business.name,
    town: a.business.town || '',
    score: a.score.overall === null ? 'down' : String(a.score.overall),
    criticals: a.findings.filter(f => f.severity === 'critical').length,
    quickWins: a.findings.filter(f => f.effort === 'quick' && f.severity !== 'good').length,
    hook: a.score.hook
  }))
  const w = (k, min) => Math.max(min, ...rows.map(r => String(r[k]).length))
  const nw = w('name', 8), tw = w('town', 4)
  const lines = [
    `${'BUSINESS'.padEnd(nw)}  ${'TOWN'.padEnd(tw)}  SCORE  CRIT  QUICK  LEAD WITH`,
    `${'-'.repeat(nw)}  ${'-'.repeat(tw)}  -----  ----  -----  ${'-'.repeat(40)}`
  ]
  for (const r of rows) {
    lines.push(`${r.name.padEnd(nw)}  ${r.town.padEnd(tw)}  ${r.score.padStart(5)}  ${String(r.criticals).padStart(4)}  ${String(r.quickWins).padStart(5)}  ${truncate(r.hook, 60)}`)
  }
  return lines.join('\n')
}

const truncate = (s, n) => s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'

export { score, rank, explain }
export const loadJson = p => JSON.parse(readFileSync(p, 'utf8'))
