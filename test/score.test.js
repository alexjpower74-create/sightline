// Every check here runs twice: once against a measurement that should trigger it, and once against
// the same measurement with the underlying condition repaired. If the assertion survives the
// repair, it was never watching the thing it claimed to watch, and the run fails.

import { suite } from '@alexpower/rig/harness/check.js'
import { score, rank, stack, SCORING } from '../src/score/index.js'
import { readFileSync } from 'node:fs'
import { RULES } from '../src/score/rules.js'
import { writeFileSync, readFileSync as rf } from 'node:fs'

// Several controls repair the fixture on disk, because `load()` reads from disk — that is the
// honest way to break the input these functions actually consume. Originals are restored after.
const fx = n => new URL(`../fixtures/${n}.json`, import.meta.url)
const NEGLECTED = fx('neglected'), SOLID = fx('solid'), UNREACHABLE = fx('unreachable')
const ORIGINAL_NEGLECTED = rf(NEGLECTED, 'utf8')
const ORIGINAL_SOLID = rf(SOLID, 'utf8')
const ORIGINAL_UNREACHABLE = rf(UNREACHABLE, 'utf8')

const load = n => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'))
const has = (m, id) => score(m).findings.some(f => f.id === id)

/** Mutate a fixture, run the assertion against it, then put it back. */
function repair (name, fix) {
  const m = load(name)
  return { m, apply: () => { const before = structuredClone(m); fix(m); return () => Object.assign(m, before) } }
}

await suite('scoring', async t => {

  // --- individual rules, each proved against a repaired input ---------------------------------

  for (const [ruleId, fixture, fix] of [
    ['no-https',            'neglected', m => { m.https.enabled = true }],
    ['no-viewport-meta',    'neglected', m => { m.mobile.hasViewportMeta = true }],
    ['horizontal-overflow', 'neglected', m => { m.mobile.horizontalOverflowPx = 0 }],
    ['weak-title',          'neglected', m => { m.seo.title = 'Roofing and Siding in Grand Falls-Windsor'; m.seo.titleLength = 42 }],
    ['inputs-missing-label','neglected', m => { m.a11y.inputsMissingLabel = 0 }],
    ['stale-copyright',     'neglected', m => { m.freshness.copyrightYear = new Date().getFullYear() }],
    ['broken-links',        'neglected', m => { m.freshness.brokenLinks = [] }],
    ['images-missing-alt',  'neglected', m => { m.a11y.imagesMissingAlt = 0 }]
  ]) {
    const r = repair(fixture, fix)
    await t.check(`${ruleId} fires, and stops firing once the cause is fixed`, {
      assert: () => has(r.m, ruleId),
      breaks: () => r.apply()
    })
  }

  // --- the properties that keep the number credible -------------------------------------------

  await t.check('a neglected site scores in the urgent band', {
    assert: () => { const s = score(load('neglected')).score; return s.overall < 40 && s.band === 'urgent' },
    // Repair the site itself. If the score still says "urgent" for a site with none of these
    // problems, the band is not tracking the measurement.
    breaks: () => {
      const r = repair('neglected', m => {
        m.https.enabled = true; m.mobile.hasViewportMeta = true; m.mobile.horizontalOverflowPx = 0
        m.mobile.tapTargetsUnder44 = 0; m.timing.loadMs = 900; m.timing.ttfbMs = 150
        m.weight.totalBytes = 900_000; m.a11y.imagesMissingAlt = 0; m.a11y.inputsMissingLabel = 0
        m.a11y.lowContrastNodes = 0; m.a11y.htmlLangSet = true; m.a11y.hasMainLandmark = true
        m.seo.title = 'Roofing and Siding in Grand Falls-Windsor'; m.seo.titleLength = 42
        m.seo.metaDescription = 'Roofing, siding and renovations across central Newfoundland.'
        m.seo.h1Count = 1; m.seo.hasSitemap = true; m.seo.structuredDataTypes = ['LocalBusiness']
        m.freshness.copyrightYear = new Date().getFullYear(); m.freshness.brokenLinks = []
      })
      const restore = r.apply()
      writeFileSync(NEGLECTED, JSON.stringify(r.m, null, 2))
      return () => { restore(); writeFileSync(NEGLECTED, ORIGINAL_NEGLECTED) }
    }
  })

  await t.check('a good site cannot score a perfect 100', {
    // A tool that hands out 100/100 is not believed when it hands out 27. The minor rules are what
    // stop that happening, so removing them must break this check.
    assert: () => { const o = score(load('solid')).score.overall; return o >= 85 && o < 100 },
    breaks: () => {
      const removed = RULES.filter(r => r.severity === 'minor')
      for (const r of removed) RULES.splice(RULES.indexOf(r), 1)
      return () => RULES.push(...removed)
    }
  })

  await t.check('an unreachable site is given no score at all', {
    assert: () => score(load('unreachable')).score.overall === null,
    breaks: () => {
      const m = load('unreachable'); m.ok = true
      writeFileSync(UNREACHABLE, JSON.stringify(m, null, 2))
      return () => writeFileSync(UNREACHABLE, ORIGINAL_UNREACHABLE)
    }
  })

  await t.check('decay is what keeps a bad area off the floor, not clamping', {
    // Phones takes 55 + 40 + 18 on the neglected fixture. Summed flat that is 113 and the area
    // pins at 0; with decay it lands in the teens. Set decay to 1 and this must fail.
    assert: () => score(load('neglected')).score.areas.mobile > 0,
    breaks: () => { const was = SCORING.decay; SCORING.decay = 1; return () => { SCORING.decay = was } }
  })

  await t.check('the hook is the worst finding, in the owner\'s language', {
    assert: () => {
      const { score: s, findings } = score(load('neglected'))
      // The heaviest critical wins, which here is the site never having been built for phones.
      return s.hook === findings[0].plainEnglish && s.hook.startsWith('Your site was built before phones mattered')
    },
    // Make the site responsive and the hook must move to a different finding entirely.
    breaks: () => {
      const m = load('neglected'); m.mobile.hasViewportMeta = true; m.mobile.viewportContent = 'width=device-width, initial-scale=1'
      writeFileSync(NEGLECTED, JSON.stringify(m, null, 2))
      return () => writeFileSync(NEGLECTED, ORIGINAL_NEGLECTED)
    }
  })

  await t.check('ranking puts the most broken site first', {
    assert: () => {
      const audits = ['solid', 'neglected'].map(n => ({ ...score(load(n)), business: { name: n } }))
      return rank(audits)[0].business.name === 'neglected'
    },
    // Repair the neglected site outright. With nothing wrong with it, it must fall behind the
    // other one — breaking only the good site is not enough, because ranking weighs critical
    // findings first and the neglected fixture would still have more of them.
    breaks: () => {
      const m = load('neglected')
      m.https.enabled = true; m.mobile.hasViewportMeta = true; m.mobile.horizontalOverflowPx = 0
      m.mobile.tapTargetsUnder44 = 0; m.timing.loadMs = 900; m.timing.ttfbMs = 150
      m.weight.totalBytes = 900_000; m.a11y.imagesMissingAlt = 0; m.a11y.imagesTotal = 31
      m.a11y.inputsMissingLabel = 0; m.a11y.lowContrastNodes = 0; m.a11y.htmlLangSet = true
      m.a11y.hasMainLandmark = true
      m.seo.title = 'Roofing and Siding in Grand Falls-Windsor'; m.seo.titleLength = 42
      m.seo.metaDescription = 'Roofing, siding and renovations across central Newfoundland.'
      m.seo.metaDescriptionLength = 60; m.seo.h1Count = 1; m.seo.hasSitemap = true
      m.seo.structuredDataTypes = ['LocalBusiness']
      m.freshness.copyrightYear = new Date().getFullYear(); m.freshness.brokenLinks = []
      writeFileSync(NEGLECTED, JSON.stringify(m, null, 2))
      return () => writeFileSync(NEGLECTED, ORIGINAL_NEGLECTED)
    }
  })
})

// ------------------------------------------------------------------------------------------------
// Regressions found by the collector slice, not by this one. Each of these was a real wrong answer.
// ------------------------------------------------------------------------------------------------

const BLOCKED = fx('blocked')
const ORIGINAL_BLOCKED = rf(BLOCKED, 'utf8')

await suite('not lying to the owner', async t => {

  // Setup, not assertion: put a site whose load event never fired on disk, and leave it there for
  // the duration of the check. The assert must READ that state, never impose it — an assert that
  // rewrites the fixture wipes out the negative control and marks itself void.
  {
    const stalled = load('solid'); stalled.timing.loadMs = 0
    writeFileSync(SOLID, JSON.stringify(stalled, null, 2))
  }

  await t.check('a page whose load event never fired is NOT congratulated on its speed', {
    // This shipped. loadMs of 0 means the event never fired, and the rule read it as instant:
    // 97/100 and "Your site loads quickly" for a page that never stops spinning.
    assert: () => !score(load('solid')).findings.some(f => f.id === 'good-speed'),
    // Give the same fixture a real load time and the compliment must come back — otherwise this
    // check would pass simply because the rule never fires at all.
    breaks: () => {
      const m = load('solid'); m.timing.loadMs = 1200
      writeFileSync(SOLID, JSON.stringify(m, null, 2))
      return () => { const s = load('solid'); s.timing.loadMs = 0; writeFileSync(SOLID, JSON.stringify(s, null, 2)) }
    }
  })

  await t.check('a page that never finishes loading is told so', {
    assert: () => score(load('solid')).findings.some(f => f.id === 'load-never-finishes'),
    breaks: () => {
      const removed = RULES.filter(r => r.id === 'load-never-finishes')
      for (const r of removed) RULES.splice(RULES.indexOf(r), 1)
      return () => RULES.push(...removed)
    }
  })

  writeFileSync(SOLID, ORIGINAL_SOLID)   // end of the stalled-load setup

  await t.check('a site that BLOCKED the checker is not reported as down', {
    // Bot protection turning away an automated visitor says nothing about whether customers can
    // reach the site. Telling an owner their working site is down is the worst thing we could do.
    assert: () => {
      const s = score(load('blocked')).score
      const f = score(load('blocked')).findings[0]
      return s.band === 'blocked' && s.overall === null &&
             f.severity !== 'critical' && !/did not respond|error page/i.test(f.plainEnglish)
    },
    breaks: () => {
      const m = load('blocked'); m.unreachableReason = 'dns'
      writeFileSync(BLOCKED, JSON.stringify(m, null, 2))
      return () => writeFileSync(BLOCKED, ORIGINAL_BLOCKED)
    }
  })

  await t.check('the overflow finding names what to fix, not just how bad it is', {
    assert: () => {
      const f = score(load('neglected')).findings.find(x => x.id === 'horizontal-overflow')
      return /a table/.test(f.plainEnglish) && /900 pixels/.test(f.plainEnglish)
    },
    breaks: () => {
      const m = load('neglected'); m.mobile.overflowCulprit = null
      writeFileSync(NEGLECTED, JSON.stringify(m, null, 2))
      return () => writeFileSync(NEGLECTED, ORIGINAL_NEGLECTED)
    }
  })

  await t.check('contrast wording never claims to be a complete list', {
    // The collector drops nodes it cannot resolve, so the count is a floor. Saying "12 pieces of
    // text" when the real number could be forty is a claim we cannot support in front of a client.
    assert: () => {
      const f = score(load('neglected')).findings.find(x => x.id === 'low-contrast')
      return /at least/i.test(f.plainEnglish) && /could not measure/i.test(f.plainEnglish)
    },
    breaks: () => {
      const m = load('neglected'); m.a11y.lowContrastNodes = 0
      writeFileSync(NEGLECTED, JSON.stringify(m, null, 2))
      return () => writeFileSync(NEGLECTED, ORIGINAL_NEGLECTED)
    }
  })

  await t.check('an untrusted certificate is its own finding, not a substring of an error', {
    assert: () => {
      const m = load('solid'); m.https.certificateProblem = 'net::ERR_CERT_DATE_INVALID (expired 2024-11-02)'
      writeFileSync(SOLID, JSON.stringify(m, null, 2))
      try { return score(load('solid')).findings.some(f => f.id === 'certificate-problem') }
      finally { writeFileSync(SOLID, ORIGINAL_SOLID) }
    },
    breaks: () => {
      const removed = RULES.filter(r => r.id === 'certificate-problem')
      for (const r of removed) RULES.splice(RULES.indexOf(r), 1)
      return () => RULES.push(...removed)
    }
  })
})
