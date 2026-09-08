// Turns a Measurement into a Score plus the findings that produced it.
//
// The scoring is a weighted heuristic and the report must never imply otherwise. What makes it
// defensible is that every point deducted is traceable to a named rule and a measured number:
// `explain()` prints the arithmetic, so when a client argues with a 41 you can show your work.

import { AREAS, SEVERITY, assertMeasurement } from '../contract.js'
import { RULES } from './rules.js'

const BANDS = [
  { at: 80, band: 'strong', line: 'in good shape' },
  { at: 60, band: 'fair',   line: 'workable, with real gaps' },
  { at: 40, band: 'weak',   line: 'costing you enquiries' },
  { at: 0,  band: 'urgent', line: 'losing you business today' }
]

const clamp = n => Math.max(0, Math.min(100, Math.round(n)))

/**
 * Penalties within an area stack with diminishing returns.
 *
 * Summing them flat drives any genuinely bad site to single digits, and a 4/100 reads as a scare
 * tactic rather than an assessment — the first person to check our arithmetic stops trusting the
 * whole report. The worst problem in an area should dominate; the ones behind it add real weight
 * without compounding into nonsense.
 */
/** Tunable, and exported so a test can set it to 1 and prove the decay is what keeps a score off the floor. */
export const SCORING = { decay: 0.65 }
export function stack (penalties) {
  return [...penalties].sort((a, b) => b - a).reduce((sum, p, i) => sum + p * Math.pow(SCORING.decay, i), 0)
}

/** Rank findings the way a person would read them: worst and most fixable first. */
const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, good: 3 }
const EFFORT_ORDER = { quick: 0, moderate: 1, rebuild: 2 }

/**
 * @param {import('../contract.js').Measurement} m
 * @returns {{ score: import('../contract.js').Score, findings: import('../contract.js').Finding[] }}
 */
export function score (m) {
  assertMeasurement(m)

  // A site we could not reach gets no score at all. Inventing one would be the single fastest way
  // to lose the room: the owner knows their site is down, and a number would say we never looked.
  if (!m.ok) {
    return {
      score: { overall: null, areas: {}, band: 'unreachable',
        hook: 'We could not reach your website at all when we checked.' },
      findings: [{
        id: 'unreachable', area: 'trust', severity: SEVERITY.CRITICAL,
        title: 'Site could not be reached',
        plainEnglish: 'Your website did not respond when we tried to visit it. Anyone who looks you up right now sees an error page instead of your business.',
        evidence: m.error || 'no response',
        effort: 'moderate'
      }]
    }
  }

  const findings = []
  for (const rule of RULES) {
    let hit
    try { hit = rule.when(m) } catch (e) { hit = false } // a rule that throws must not take the run down
    if (!hit) continue
    findings.push({
      id: rule.id, area: rule.area, severity: rule.severity, title: rule.title,
      plainEnglish: call(rule.plainEnglish, m), evidence: call(rule.evidence, m),
      effort: rule.effort, penalty: rule.penalty
    })
  }

  const areas = {}
  for (const key of Object.keys(AREAS)) {
    areas[key] = clamp(100 - stack(findings.filter(f => f.area === key).map(f => f.penalty || 0)))
  }

  const overall = clamp(Object.entries(AREAS).reduce((s, [k, a]) => s + areas[k] * a.weight, 0))
  const { band, line } = BANDS.find(b => overall >= b.at)

  findings.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (b.penalty || 0) - (a.penalty || 0) ||
    EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort])

  const worst = findings.find(f => f.severity !== SEVERITY.GOOD)
  return {
    score: { overall, areas, band, line, hook: worst ? worst.plainEnglish : 'Your site is in good order — there is nothing here that needs fixing today.' },
    findings
  }
}

/** Rank a list of audited businesses so a shop knows who to phone first. */
export function rank (audits) {
  // Worst site first, but a site that is merely small should not outrank one that is broken:
  // critical findings break the tie before the raw number does.
  return [...audits].sort((a, b) => {
    const critA = a.findings.filter(f => f.severity === SEVERITY.CRITICAL).length
    const critB = b.findings.filter(f => f.severity === SEVERITY.CRITICAL).length
    const scoreA = a.score.overall ?? -1
    const scoreB = b.score.overall ?? -1
    return critB - critA || scoreA - scoreB
  })
}

/** Show the arithmetic. Used by `sightline explain` and when a client argues with a number. */
export function explain (m) {
  const { score: s, findings } = score(m)
  if (s.overall === null) return `${m.url}\n  unreachable — no score issued (${m.error || 'no response'})`
  const lines = [`${m.url}  ->  ${s.overall}/100 (${s.band})`]
  for (const [key, area] of Object.entries(AREAS)) {
    const hits = findings.filter(f => f.area === key && f.penalty > 0)
    lines.push(`  ${area.label.padEnd(14)} ${String(s.areas[key]).padStart(3)}/100  x${area.weight}  = ${(s.areas[key] * area.weight).toFixed(1)}`)
    for (const h of hits) lines.push(`      -${String(h.penalty).padStart(2)}  ${h.id}  (${h.evidence})`)
  }
  lines.push(`  ${'overall'.padEnd(14)} ${String(s.overall).padStart(3)}/100`)
  return lines.join('\n')
}

const call = (v, m) => typeof v === 'function' ? v(m) : v
