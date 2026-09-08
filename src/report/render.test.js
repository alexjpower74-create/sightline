// Checks on the rendered document.
//
//   node src/report/render.test.js
//
// Every check below has a negative control, and the controls are the point. The classic void
// assertion for this slice is `html.includes('score')`, which keeps passing after you delete the
// entire score block because the word survives in a class name. So nothing here greps for a word
// that could plausibly appear somewhere else: the assertions quote text that came out of the audit
// object, and the controls change that object and expect the assertion to notice.
//
// Where a control is weaker than I would like, it says so above the check rather than in a comment
// nobody reads at the bottom.

import { suite } from '@alexpower/rig/harness/check.js'
import { renderHtml, view, esc } from './html.js'
import { sampleAudit, usedRealScorer } from './sample-audit.js'
import { STRONG_HEADLINE } from './copy.js'

/** The document is three <article class="sheet"> elements; page-1 claims must be checked on page 1. */
function sheet (html, id) {
  const start = html.indexOf(`<article class="sheet" id="sheet-${id}">`)
  if (start < 0) throw new Error(`no sheet "${id}" in the document`)
  const end = html.indexOf('<article class="sheet"', start + 1)
  return html.slice(start, end < 0 ? html.length : end)
}

/** A deep-enough clone that a control can mutate one and leave the other alone. */
const clone = a => JSON.parse(JSON.stringify(a))

// Findings say things like: Browsers mark the site "Not secure". Those quotes are &quot; by the
// time they reach the document, so an assertion that greps for the raw string can never match —
// and never matching is exactly how `every(f => !p1.includes(f.title))` passes forever. Two checks
// here were VOID on the first run for precisely that reason. Compare escaped to escaped.
const inDoc = t => esc(t)

/** Matches the score numeral as it is actually printed, not the word "score". */
const SCORE_NUMERAL = /<div class="score-number">\s*(\d+)/

await suite('report / render', async s => {
  /* ── the dead site ──────────────────────────────────────────────────────────────────────── */

  // Red if: any digit-slash-100 numeral reaches the document for a site that never answered.
  // Control: make the same site reachable and scored, at which point the numeral must appear —
  // proving the assertion can see a score when there is one to see.
  const dead = sampleAudit('unreachable')
  await s.check('a site that did not answer gets no score numeral', {
    assert: () => {
      const html = renderHtml(dead)
      return !SCORE_NUMERAL.test(html) && !html.includes('/100')
    },
    breaks: () => {
      const before = { ok: dead.measurement.ok, score: dead.score }
      dead.measurement.ok = true
      dead.score = { overall: 55, areas: { performance: 55, mobile: 55, accessibility: 55, seo: 55, trust: 55 }, band: 'weak', line: 'costing you enquiries', hook: 'x' }
      return () => { dead.measurement.ok = before.ok; dead.score = before.score }
    }
  })

  // The guard that matters is not "the fixture has no score" — it is that `measurement.ok` alone
  // suppresses the number even when a scorer hands one over. Asserted on view(), because a
  // rendered-HTML assertion cannot tell "no score was offered" from "a score was offered and
  // refused". Red if: ok:false ever produces hasScore:true. Control: flip ok to true.
  const deadButScored = sampleAudit('unreachable')
  deadButScored.score = { overall: 71, areas: { performance: 71, mobile: 71, accessibility: 71, seo: 71, trust: 71 }, band: 'fair', line: 'workable', hook: 'x' }
  await s.check('a score handed in for an unreachable site is refused, not printed', {
    assert: () => {
      const v = view(deadButScored)
      const html = renderHtml(deadButScored)
      // Not `html.includes('71')`: half a megabyte of inlined base64 font data contains every
      // two-digit string there is, so that assertion goes red on a perfectly correct document.
      return v.hasScore === false && !SCORE_NUMERAL.test(html) && !html.includes('/100')
    },
    breaks: () => {
      deadButScored.measurement.ok = true
      return () => { deadButScored.measurement.ok = false }
    }
  })

  // Red if: the appendix prints the contract's blank-Measurement zeros as though they were
  // readings. Control: mark the site reachable, at which point the real table appears.
  await s.check('the appendix says "not measured" rather than printing zeros as readings', {
    assert: () => {
      const html = renderHtml(dead)
      const p3 = sheet(html, 'appendix')
      return p3.includes('the site did not respond') && !p3.includes('Time to first byte')
    },
    breaks: () => {
      dead.measurement.ok = true
      return () => { dead.measurement.ok = false }
    }
  })

  /* ── the two voices ─────────────────────────────────────────────────────────────────────── */

  const neglected = sampleAudit('neglected')

  // Expectations are snapshotted from a pristine copy before any control runs.
  //
  // This is the second way a check here went VOID, and it is subtler than the escaping one. An
  // assertion written as `findings.every(f => html.includes(f.evidence))` re-reads the array the
  // control just mutated, so it compares the broken document against the broken data and agrees
  // with itself. Three checks passed against a deliberately reversed and rewritten audit that way.
  // Holding the expected strings still is what makes the control able to move anything.
  const PRISTINE = clone(neglected)
  const EXPECT = {
    costs: view(PRISTINE).costs.map(f => f.plainEnglish),
    findings: PRISTINE.findings.map(f => ({ title: f.title, evidence: f.evidence })),
    problemTitles: PRISTINE.findings.filter(f => f.severity !== 'good').map(f => f.title)
  }

  // Red if: a sentence the scorer wrote for the owner stops reaching page 1 verbatim.
  // Control: rewrite that sentence in the audit; the old text must vanish from the sheet.
  await s.check('page 1 quotes the owner sentences verbatim', {
    assert: () => {
      const p1 = sheet(renderHtml(neglected), 'owner')
      return EXPECT.costs.length === 3 && EXPECT.costs.every(t => p1.includes(inDoc(t)))
    },
    breaks: () => {
      const f = view(neglected).costs[1]
      const target = neglected.findings.find(x => x.id === f.id)
      const before = target.plainEnglish
      target.plainEnglish = 'REWRITTEN BY THE NEGATIVE CONTROL'
      return () => { target.plainEnglish = before }
    }
  })

  // Red if: a short developer-facing title leaks onto the owner's page. That is the single edit
  // that collapses this back into a Lighthouse dump.
  // Control is weaker than the others and I want to be straight about it: there is no way to make
  // the renderer emit titles on page 1 from outside the module, so the control instead moves a
  // title's text onto page 1 legitimately (by making it the finding's plainEnglish). That proves
  // the assertion really scans page 1 for those strings; it does not prove the renderer would be
  // caught if someone added a <h3>${f.title}</h3> tomorrow. The check below on the tag markup
  // covers that side.
  await s.check('page 1 shows no finding titles', {
    assert: () => {
      const p1 = sheet(renderHtml(neglected), 'owner')
      return neglected.findings.every(f => !p1.includes(inDoc(f.title)))
    },
    breaks: () => {
      // findings[1] is the first entry that reaches the owner's list — findings[0] became the
      // headline and was deduped out of it.
      const target = neglected.findings[1]
      const before = target.plainEnglish
      target.plainEnglish = target.title
      return () => { target.plainEnglish = before }
    }
  })

  // Red if: page 1 starts carrying the developer furniture — severity tags, effort estimates, or
  // the measured numbers. Control: none needed for the markup's absence; this one asserts on
  // strings the renderer itself emits, so it is checked against page 2, where they must all appear.
  await s.check('severity, effort and evidence appear on page 2 and not on page 1', {
    assert: () => {
      const html = renderHtml(neglected)
      const p1 = sheet(html, 'owner')
      const p2 = sheet(html, 'findings')
      const absentFromOwner = !p1.includes('class="tag sev-') && !p1.includes('>Effort<') && !p1.includes('>Measured<')
      const presentForDev = p2.includes('class="tag sev-') && p2.includes('>Effort<') && p2.includes('>Measured<')
      return absentFromOwner && presentForDev
    },
    breaks: () => {
      // Remove every finding: page 2 loses the tags it is asserted to have.
      const before = neglected.findings
      neglected.findings = []
      return () => { neglected.findings = before }
    }
  })

  // Red if: page 2 stops pairing the title with the number that triggered it.
  // Control: rewrite one finding's evidence string.
  await s.check('page 2 pairs every title with its evidence', {
    assert: () => {
      const p2 = sheet(renderHtml(neglected), 'findings')
      return EXPECT.findings.every(f => p2.includes(inDoc(f.title)) && p2.includes(inDoc(f.evidence)))
    },
    breaks: () => {
      const target = neglected.findings[3]
      const before = target.evidence
      target.evidence = 'REWRITTEN BY THE NEGATIVE CONTROL'
      return () => { target.evidence = before }
    }
  })

  /* ── order ──────────────────────────────────────────────────────────────────────────────── */

  // The scorer sorts worst, then heaviest, then quickest to fix, and that order is a product
  // decision. Red if: the renderer re-ranks it. Control: reverse the input; the positions in the
  // document must follow, which proves the assertion is reading document order and not just
  // checking that everything is present somewhere.
  await s.check('findings keep the order the scorer gave them', {
    assert: () => {
      const p2 = sheet(renderHtml(neglected), 'findings')
      const at = EXPECT.problemTitles.map(t => p2.indexOf(inDoc(t)))
      return at.every(i => i >= 0) && at.every((n, i) => i === 0 || n > at[i - 1])
    },
    breaks: () => {
      const before = neglected.findings
      neglected.findings = [...before].reverse()
      return () => { neglected.findings = before }
    }
  })

  /* ── the good site ──────────────────────────────────────────────────────────────────────── */

  const solid = sampleAudit('solid')

  // A document that can only ever say things are terrible is not believed on the sites that are.
  // Red if: a strong band stops saying so, or starts telling a 97/100 it is losing money.
  // Control: drop the band to urgent; the headline becomes the hook and the costing-you heading
  // returns.
  await s.check('a good site is told it is a good site', {
    assert: () => {
      const p1 = sheet(renderHtml(solid), 'owner')
      return p1.includes(STRONG_HEADLINE) && !p1.includes('What this is costing you')
    },
    breaks: () => {
      const before = solid.score.band
      solid.score.band = 'urgent'
      return () => { solid.score.band = before }
    }
  })

  // Red if: severity:'good' findings get filtered out of the document. They are what makes the
  // bad news credible. Control: remove them from the audit.
  await s.check('good findings are given a place, not dropped', {
    assert: () => {
      const html = renderHtml(solid)
      const good = solid.findings.filter(f => f.severity === 'good')
      if (!good.length) return false
      const p1 = sheet(html, 'owner')
      const p2 = sheet(html, 'findings')
      return p1.includes('Already working') && good.every(f => p1.includes(inDoc(f.title)) && p2.includes(inDoc(f.title)))
    },
    breaks: () => {
      const before = solid.findings
      solid.findings = before.filter(f => f.severity !== 'good')
      return () => { solid.findings = before }
    }
  })

  // Red if: the "N more overleaf" count stops adding up. The headline is itself one of the
  // findings, so the naive count is out by one and reads wrong to anyone who turns the page.
  //
  // The numbers are pinned rather than recomputed. Recomputing them the way the renderer does made
  // this check VOID on the first run: adding a finding moved both sides of the comparison together
  // and the assertion never noticed. Nineteen problems, headline plus three shown, fifteen left. If
  // vera's rules change the fixture's finding count this goes red, which is the right outcome —
  // page 1 needs looking at again when that happens.
  await s.check('the overleaf count accounts for the headline', {
    assert: () => {
      const v = view(neglected)
      const p1 = sheet(renderHtml(neglected), 'owner')
      return v.headlineIsFirstFinding === true &&
             v.problems.length === 19 && v.costs.length === 3 && v.moreOverleaf === 15 &&
             p1.includes('19 in total — 15 more overleaf')
    },
    breaks: () => {
      const before = neglected.findings
      neglected.findings = [...before, { ...before[1], id: 'control-extra', title: 'Control extra' }]
      return () => { neglected.findings = before }
    }
  })

  /* ── hostile text ───────────────────────────────────────────────────────────────────────── */

  // Every string in an Audit was read off somebody else's website. Red if: any of it reaches the
  // document unescaped. Control: change the payload; the escaped form the assertion looks for must
  // disappear, which proves the assertion is reading these fields and not passing on a technicality.
  const nasty = clone(sampleAudit('neglected'))
  const PAYLOAD = '<script>alert("pwned")</script>'
  nasty.business.name = `Acme ${PAYLOAD}`
  nasty.findings[0].title = `Title ${PAYLOAD}`
  nasty.findings[0].plainEnglish = `Owner ${PAYLOAD}`
  nasty.findings[0].evidence = `Evidence ${PAYLOAD}`
  nasty.measurement.finalUrl = `http://x.test/${PAYLOAD}`
  await s.check('text read off the audited site cannot inject markup', {
    assert: () => {
      const html = renderHtml(nasty)
      const body = html.slice(html.indexOf('<body>'))
      return !body.includes(PAYLOAD) &&
             body.includes('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;')
    },
    breaks: () => {
      const before = nasty.business.name
      nasty.business.name = 'Harmless Ltd'
      nasty.findings[0].title = 'Harmless'
      nasty.findings[0].plainEnglish = 'Harmless'
      nasty.findings[0].evidence = 'Harmless'
      nasty.measurement.finalUrl = 'http://x.test/'
      return () => {
        nasty.business.name = before
        nasty.findings[0].title = `Title ${PAYLOAD}`
        nasty.findings[0].plainEnglish = `Owner ${PAYLOAD}`
        nasty.findings[0].evidence = `Evidence ${PAYLOAD}`
        nasty.measurement.finalUrl = `http://x.test/${PAYLOAD}`
      }
    }
  })

  /* ── survival ───────────────────────────────────────────────────────────────────────────── */

  // Red if: a thin or malformed Audit takes the renderer down mid-batch. A CLI run over a hundred
  // NL businesses will meet all of these. Control: remove `findings` entirely, which the contract's
  // own assertAudit must reject — proving the assertion distinguishes "survived" from "threw".
  const thin = {
    business: { name: 'Nothing Ltd', url: 'http://nothing.test' },
    measurement: { url: 'http://nothing.test', ok: true, fetchedAt: '2026-09-08T00:00:00Z' },
    score: { overall: 0, areas: {}, band: 'urgent', hook: '' },
    findings: []
  }
  await s.check('a thin audit renders instead of throwing', {
    assert: () => {
      const html = renderHtml(thin)
      return html.startsWith('<!doctype html>') && html.includes('No findings were produced')
    },
    breaks: () => {
      const before = thin.findings
      delete thin.findings
      return () => { thin.findings = before }
    }
  })

  // Red if: the day scoring lands on main, these checks keep passing against a stale snapshot of
  // vera's output instead of the real thing. There is no control for this one — it is a statement
  // about which code path ran, and it cannot be made to fail without deleting src/score/. Reported
  // UNPROVEN on purpose.
  await s.check(`scoring source is ${usedRealScorer() ? 'src/score/ (real)' : 'scored-fixtures.json (SNAPSHOT — scoring is not on this branch yet)'}`, {
    assert: () => true
  })
})
