// One Audit in, one self-contained HTML document out.
//
// The document has two readers and it does not pretend otherwise. Sheet 1 belongs to the business
// owner: the score, one sentence, the things that are costing them money in plain English, and a
// photograph of their own site on a phone. Sheet 2 onward belongs to whoever will do the work:
// every finding paired with the number that triggered it and an effort estimate, then the raw
// measurement to argue with.
//
// The split is commercial, not aesthetic. A Lighthouse dump is unreadable by the person holding
// the chequebook, which is why nobody has ever sold work with one.
//
// The two voices come from the scorer and must not be crossed. `plainEnglish` is a full sentence
// written for the owner; `title` is a short developer-facing label. Page 1 uses plainEnglish and
// never title. Page 2 pairs title with evidence. Mixing them is the one edit that breaks the idea.

import { AREAS, SEVERITY, assertAudit } from '../contract.js'
import { fontCss, stylesheet, image } from './assets.js'
import {
  STRONG_HEADLINE, BAND_FOLLOWUP, BAND_LINE, SEVERITY_LABEL, EFFORT_LABEL,
  AREA_MEANING, areaLabel, areaWeightPct, noScoreCopy, bytes, ms, count, yesNo, shortDate
} from './copy.js'

/* ── escaping ─────────────────────────────────────────────────────────────────────────────── */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Everything measured off a live site is attacker-controlled text. Page titles especially. */
export function esc (v) {
  if (v == null) return ''
  return String(v).replace(/[&<>"']/g, c => ESC[c])
}

const yes = (cond, html) => (cond ? html : '')

/* ── shaping the audit ────────────────────────────────────────────────────────────────────── */

/**
 * Everything the templates need, resolved once, with every "what if this is missing" question
 * answered here rather than sprinkled through the markup.
 *
 * Exported because the tests assert against it: checking that a dead site produces `hasScore:false`
 * is a sharper check than grepping the HTML for the absence of a number.
 */
export function view (audit, opts = {}) {
  const m = audit.measurement || {}
  const s = audit.score || null
  // The scorer hands findings back pre-sorted — severity, then penalty weight, then how quick the
  // fix is. That order is a product decision, so it is preserved everywhere below rather than
  // re-derived. The only re-ordering that happens is splitting the good news out of the stream.
  const findings = Array.isArray(audit.findings) ? audit.findings : []

  const reachable = m.ok === true
  // A number is shown only when there was something to measure. Two independent conditions have to
  // agree — the site answered, and the scorer issued an overall — because either one alone has a
  // failure mode that ends with an invented score on a dead site.
  const hasScore = reachable && s != null && typeof s.overall === 'number' && isFinite(s.overall)

  const problems = findings.filter(f => f.severity !== SEVERITY.GOOD)
  const working = findings.filter(f => f.severity === SEVERITY.GOOD)

  const areaKeys = Object.keys(AREAS)
  const scored = hasScore && s.areas && typeof s.areas === 'object'
  // Worst area first. With no scores, the contract's own order — an arbitrary but stable one beats
  // one that reshuffles between two runs of the same CLI.
  const areasRanked = areaKeys
    .map(k => ({ key: k, label: areaLabel(k), weight: areaWeightPct(k), value: scored && typeof s.areas[k] === 'number' ? s.areas[k] : null }))
    .sort((a, b) => (a.value ?? 999) - (b.value ?? 999) || areaKeys.indexOf(a.key) - areaKeys.indexOf(b.key))

  const band = hasScore ? s.band : (s?.band ?? null)
  const strong = band === 'strong'

  // The scorer builds `hook` out of the worst finding's plainEnglish, so on most sites the headline
  // and the first item in the list are the same sentence twice. Whichever one we print second gets
  // dropped. A strong site keeps its hook in the list, because its headline is a different sentence.
  const headline = strong ? STRONG_HEADLINE : (s?.hook || null)
  const headlineIsFirstFinding = Boolean(headline) && problems[0]?.plainEnglish === headline
  const costs = (headlineIsFirstFinding ? problems.slice(1) : problems).slice(0, 3)
  // The headline counts as one of the things the owner has been shown, so the "and N more overleaf"
  // number has to include it or the arithmetic on the page does not add up.
  const shownOnPageOne = costs.length + (headlineIsFirstFinding ? 1 : 0)

  return {
    business: audit.business || {},
    measurement: m,
    score: s,
    reachable,
    hasScore,
    band,
    strong,
    headline,
    line: s?.line || BAND_LINE[band] || null,
    findings,
    problems,
    working,
    costs,
    headlineIsFirstFinding,
    moreOverleaf: Math.max(0, problems.length - shownOnPageOne),
    areasRanked,
    generatedAt: audit.generatedAt || m.fetchedAt || null,
    // The audit carries who did the work; the option is an override for a one-off re-render.
    // Reading only the option was a real hole: `renderHtml(audit)` is the documented signature and
    // the one the tests and preview use, and it dropped the signature even when the audit had it.
    // It happened to work end to end only because the CLI passes the same value both ways.
    preparedBy: opts.preparedBy || audit.preparedBy || null,
    // Different budgets, because the two shots are printed at very different sizes. The phone
    // capture appears at 54mm in the rail and 48mm on page 3 — about 640px at 300dpi — while the
    // desktop shot gets the full 120mm column. Embedding a 2880px-wide capture for either is
    // paying for pixels the page cannot print.
    shots: {
      mobile: image(m.screenshots?.mobile, { maxWidth: 760, quality: opts.imageQuality ?? 78, compress: opts.compressImages !== false }),
      desktop: image(m.screenshots?.desktop, { maxWidth: 1400, quality: opts.imageQuality ?? 78, compress: opts.compressImages !== false })
    }
  }
}

/* ── shared furniture ─────────────────────────────────────────────────────────────────────── */

function masthead (v, { kicker, page }) {
  const b = v.business
  const bits = [b.town, b.sector].filter(Boolean).map(esc)
  const host = esc(v.measurement.finalUrl || v.measurement.url || '')
  return `
  <header class="masthead">
    <div>
      <p class="eyebrow">${esc(kicker)}</p>
      <h1>${esc(b.name || 'Untitled business')}</h1>
      <div class="who">${host}${yes(bits.length, `<span class="sep">/</span>${bits.join('<span class="sep">·</span>')}`)}</div>
    </div>
    <div class="issued">
      <strong>${esc(shortDate(v.generatedAt))}</strong>
      ${v.preparedBy ? `Prepared by ${esc(v.preparedBy)}<br>` : ''}
      Page ${esc(page)}
    </div>
  </header>
  <hr class="rule-heavy">`
}

function colophon (v, note) {
  return `
  <footer class="colophon">
    <span>${esc(v.business.name || '')}${v.business.phone ? ' · ' + esc(v.business.phone) : ''}</span>
    <span>${esc(note)}</span>
  </footer>`
}

/* ── page 1: the owner ────────────────────────────────────────────────────────────────────── */

function verdictBlock (v) {
  const overall = Math.round(v.score.overall)
  return `
  <section class="verdict">
    <div class="score-block">
      <div class="score-number">${overall}<span class="of">/100</span></div>
      ${yes(v.line, `<div class="score-band">${esc(v.line)}</div>`)}
      <p class="score-caveat">A weighted average of the five areas below. It is a rule of thumb for
      ranking sites against each other, not a measurement of anything on its own — two sites a point
      apart are not different.</p>
    </div>
    <div class="verdict-text">
      ${yes(v.headline, `<p class="say">${esc(v.headline)}</p>`)}
      ${yes(BAND_FOLLOWUP[v.band], `<p class="follow">${esc(BAND_FOLLOWUP[v.band])}</p>`)}
    </div>
  </section>`
}

/** A bar, not a dial. It shows rank and rough distance, which is all a weighted heuristic knows. */
function areaBars (v) {
  const rows = v.areasRanked.map(a => {
    const known = typeof a.value === 'number' && isFinite(a.value)
    const pct = known ? Math.max(0, Math.min(100, a.value)) : 0
    return `
      <div class="area-row">
        <div class="area-name">${esc(a.label)}</div>
        <div class="area-track"><div class="area-fill" style="width:${pct}%"></div></div>
        <div class="area-value">${known ? Math.round(a.value) : '—'}</div>
        <div class="area-weight">${a.weight}% of score</div>
      </div>`
  }).join('')

  const worst = v.areasRanked[0]
  return `
  <section class="areas">
    <div class="section-head"><h2>The five areas, worst first</h2><span class="aside">Each out of 100</span></div>
    ${rows}
    ${yes(worst && typeof worst.value === 'number' && AREA_MEANING[worst.key],
      `<p class="area-legend"><strong>${esc(worst?.label)}</strong> — ${esc(AREA_MEANING[worst?.key])}</p>`)}
  </section>`
}

/**
 * The owner's list. `plainEnglish` and nothing else: no titles, no severities, no effort codes, no
 * measured numbers. Everything a person would have to look up lives on page 2.
 */
function ownerFindings (v) {
  const items = v.costs.map((f, i) => `
      <div class="cost${f.severity === SEVERITY.CRITICAL ? ' is-critical' : ''}">
        <div class="cost-n">${String(i + 1).padStart(2, '0')}</div>
        <div class="cost-body"><p>${esc(f.plainEnglish)}</p></div>
      </div>`).join('')

  // A 97/100 site does not get told two minor nits are "costing you". Over-claiming on the good
  // sites is exactly what stops anyone believing the number on the bad ones.
  const heading = v.problems.length === 0 ? 'What we found'
    : v.strong ? 'What we would tidy up'
    : 'What this is costing you'

  const aside = v.problems.length === 0 ? 'Nothing that needs work today'
    : v.moreOverleaf > 0 ? `${v.problems.length} in total — ${v.moreOverleaf} more overleaf`
    : `${v.problems.length} in total`

  const empty = v.costs.length === 0
    ? `<p class="empty-note">${v.problems.length === 0
        ? 'We could not find anything on this site that is costing the business work.'
        : 'No findings were produced for this site.'}</p>`
    : ''

  // The good news is quieter, not absent. An audit that can only ever say things are broken is not
  // believed when it says something is broken.
  const alsoWorking = v.working.length
    ? `<div class="working-note"><span class="working-label">Already working</span>${v.working.map(f => esc(f.title)).join(' · ')}</div>`
    : ''

  return `
  <section class="costs-section">
    <div class="section-head"><h2>${esc(heading)}</h2><span class="aside">${esc(aside)}</span></div>
    <div class="costs">
      <div class="costs-list">${items}${empty}${alsoWorking}</div>
      ${phoneRail(v)}
    </div>
  </section>`
}

/**
 * The owner's own site on a phone. This persuades harder than any number on the page, which is
 * exactly why it is not allowed to arrive four centimetres wide.
 *
 * The layout follows the image, not the other way round. A tall capture goes in the rail beside the
 * list; a wide one — which is what a site with no viewport meta produces, because Chrome lays it
 * out at the page's own width — goes full width underneath, where it is legible. Choosing by
 * filename or by "it came from the mobile pass" gets this wrong for precisely the sites that need
 * the evidence most.
 */
function evidenceCaption (v, isPhone) {
  const overflow = v.measurement.mobile?.horizontalOverflowPx
  if (!isPhone) return '<strong>Your site, as captured.</strong> No phone screenshot was taken on this run.'
  if (overflow > 0) return `<strong>Your site on a phone.</strong> It runs ${count(overflow)} px off the side of the screen, so a visitor has to drag sideways to read it.`
  if (v.measurement.mobile?.hasViewportMeta === false) return '<strong>Your site on a phone.</strong> With no mobile setup, the whole page gets squeezed to this — a visitor has to pinch in to read anything.'
  return '<strong>Your site on a phone.</strong> This is how most people will see it.'
}

function phoneRail (v) {
  const shot = v.shots.mobile || v.shots.desktop
  if (!shot) return ''
  // Portrait fills the rail and gets cropped at the fold; a wide capture is shown whole at rail
  // width, which is small. Both alternatives were worse. Cover-cropping a 1288-wide page into a
  // phone-shaped box zooms to about 110 CSS px and shows a corner of a header. Running it
  // full-width across the sheet at 42mm is a dark band that eats an office cartridge, and being
  // the last block on a nearly-full page it hit `break-inside: avoid` and threw itself onto a
  // sheet of its own — a stray picture two findings later, and a sixth page. The wide capture gets
  // its room in the screenshots section on page 3 instead, where there is space for it.
  return `
      <div class="evidence-rail">
        <div class="shot ${shot.portrait ? 'is-phone' : 'is-wide'}"><img src="${shot.src}" alt=""></div>
        <p class="shot-caption">${evidenceCaption(v, Boolean(v.shots.mobile))}</p>
      </div>`
}

/**
 * Page 1 when there is no score: the site is down, or it refused our checker, or our checker
 * broke. Three states, three sets of words, and only the first of them is the site's fault.
 *
 * The accent rule on the consequence line is deliberately conditional. A red bar next to "this
 * says nothing about your website" is the document contradicting itself in the one place it most
 * needs to be believed.
 */
function downBlock (v) {
  const c = noScoreCopy(v.band, v.measurement)
  const m = v.measurement
  return `
  <section class="down">
    <h2>${esc(c.headline)}</h2>
    <p class="lede">${esc(c.body)}</p>
    <p class="consequence${c.accent ? ' is-fault' : ''}">${esc(c.consequence)}</p>
    <p class="next">${esc(c.next)}</p>
    <div class="no-score"><span class="no-score-label">Why there is no score</span>${esc(c.noScore)}</div>
  </section>
  <section class="attempt">
    <div><span class="k">Address tried</span><span>${esc(m.url || '—')}</span></div>
    <div><span class="k">Ended at</span><span>${esc(m.finalUrl || '—')}</span></div>
    <div><span class="k">${esc(c.attemptLabel)}</span><span>${esc(m.error || 'no response')}</span></div>
    ${m.unreachableReason ? `<div><span class="k">Reason</span><span>${esc(m.unreachableReason)}</span></div>` : ''}
    <div><span class="k">Checked</span><span>${esc(m.fetchedAt || '—')}</span></div>
  </section>`
}

/* ── page 2: the developer ────────────────────────────────────────────────────────────────── */

function findingRow (f) {
  const sev = SEVERITY_LABEL[f.severity] || f.severity || ''
  const effort = EFFORT_LABEL[f.effort] || f.effort || '—'
  const area = areaLabel(f.area)
  return `
      <div class="finding${f.severity === SEVERITY.GOOD ? ' is-good' : ''}">
        <div class="finding-head">
          <h4>${esc(f.title)}</h4>
          <span class="tag tag-area">${esc(area)}</span>
          <span class="tag sev-${esc(f.severity)}">${esc(sev)}</span>
        </div>
        <div class="finding-meta">
          <span class="evidence"><span class="label">Measured</span>${esc(f.evidence)}</span>
          <span class="effort"><span class="label">Effort</span>${esc(effort)}</span>
        </div>
      </div>`
}

/**
 * One flat list, in the order the scorer gave us, with the good news held back to the end.
 *
 * Grouping these by area was the first attempt and it was wrong: it silently re-ranks the list, and
 * the scorer's order — worst, heaviest, quickest to fix — is the thing a developer wants to work
 * top-down. The area is a tag on the row instead.
 */
function findingList (v) {
  if (!v.findings.length) return '<p class="empty-note">No findings were produced for this site.</p>'

  const problems = v.problems.length
    ? `
    <div class="section-head"><h2>Everything we found</h2><span class="aside">Worst first, then by how much it costs</span></div>
    ${v.problems.map(findingRow).join('')}`
    : `
    <div class="section-head"><h2>Everything we found</h2><span class="aside">Nothing needing repair</span></div>
    <p class="empty-note">No problems were raised against this site.</p>`

  const good = v.working.length
    ? `
    <div class="section-head good-head"><h2>Already working</h2><span class="aside">Checked and passing — leave these alone</span></div>
    ${v.working.map(findingRow).join('')}`
    : ''

  return problems + good
}

/* ── page 3: measurement and method ───────────────────────────────────────────────────────── */

const row = (k, v, empty = false) =>
  `<div class="metric"><span class="k">${esc(k)}</span><span class="v${empty ? ' is-empty' : ''}">${esc(v)}</span></div>`

function metrics (v) {
  const m = v.measurement
  if (!v.reachable) {
    return `<p class="empty-note">${esc(noScoreCopy(v.band, m).appendix)}</p>`
  }
  const t = m.timing || {}, w = m.weight || {}, h = m.https || {}, mo = m.mobile || {},
        a = m.a11y || {}, s = m.seo || {}, fr = m.freshness || {}
  return `
  <div class="metrics">
    <div class="metric-group">
      <h4>Loading</h4>
      ${row('Time to first byte', ms(t.ttfbMs))}
      ${row('DOM content loaded', ms(t.domContentLoadedMs))}
      ${row('Load complete', ms(t.loadMs))}
      ${row('Requests', count(w.requests))}
      ${row('Total transferred', bytes(w.totalBytes))}
      ${row('Images', bytes(w.imageBytes))}
      ${row('Scripts', bytes(w.scriptBytes))}
      ${row('Largest image', w.largestImage ? `${w.largestImage.url} (${bytes(w.largestImage.bytes)})` : 'none', !w.largestImage)}
    </div>
    <div class="metric-group">
      <h4>Phone (390 × 844)</h4>
      ${row('Viewport meta', yesNo(mo.hasViewportMeta))}
      ${row('Viewport content', mo.viewportContent || 'absent', !mo.viewportContent)}
      ${row('Horizontal overflow', mo.horizontalOverflowPx ? `${mo.horizontalOverflowPx} px` : 'none')}
      ${row('Tap targets under 44 px', count(mo.tapTargetsUnder44))}
      ${row('Smallest tap target', mo.smallestTapTargetPx != null ? `${mo.smallestTapTargetPx} px` : '—', mo.smallestTapTargetPx == null)}
    </div>
    <div class="metric-group">
      <h4>Accessibility</h4>
      ${row('Images without alt text', `${count(a.imagesMissingAlt)} of ${count(a.imagesTotal)}`)}
      ${row('Inputs without a label', count(a.inputsMissingLabel))}
      ${row('Heading order breaks', count(a.headingOrderBreaks))}
      ${row('Low-contrast nodes', count(a.lowContrastNodes))}
      ${row('Main landmark', yesNo(a.hasMainLandmark))}
      ${row('Skip link', yesNo(a.hasSkipLink))}
      ${row('html lang set', yesNo(a.htmlLangSet))}
    </div>
    <div class="metric-group">
      <h4>Being found</h4>
      ${row('Title', s.title ? `${s.title} (${s.titleLength})` : 'missing', !s.title)}
      ${row('Meta description', s.metaDescription ? `${s.metaDescriptionLength} chars` : 'missing', !s.metaDescription)}
      ${row('H1 count', count(s.h1Count))}
      ${row('Canonical', s.canonical || 'none', !s.canonical)}
      ${row('robots.txt', yesNo(s.hasRobotsTxt))}
      ${row('Sitemap', yesNo(s.hasSitemap))}
      ${row('Open Graph tags', s.ogTags?.length ? s.ogTags.join(', ') : 'none', !s.ogTags?.length)}
      ${row('Structured data', s.structuredDataTypes?.length ? s.structuredDataTypes.join(', ') : 'none', !s.structuredDataTypes?.length)}
    </div>
    <div class="metric-group">
      <h4>Trust</h4>
      ${row('HTTPS', yesNo(h.enabled))}
      ${row('Redirects to HTTPS', yesNo(h.redirectsToHttps))}
      ${row('Mixed content', h.mixedContent?.length ? `${h.mixedContent.length} resource(s)` : 'none')}
      ${row('Copyright year', fr.copyrightYear ?? 'not stated', fr.copyrightYear == null)}
      ${row('Generator', fr.generator || 'not declared', !fr.generator)}
      ${row('Last modified', fr.lastModified || 'not sent', !fr.lastModified)}
      ${row('Broken links', fr.brokenLinks?.length ? fr.brokenLinks.join(', ') : 'none', !fr.brokenLinks?.length)}
    </div>
  </div>`
}

function evidenceSection (v) {
  const { desktop, mobile } = v.shots
  if (!desktop && !mobile) return ''
  // Built with plain ternaries rather than yes(cond, html).
  //
  // yes() takes an already-built string, so its second argument is evaluated whether the condition
  // holds or not — `yes(desktop, \`...${desktop.src}...\`)` throws on a null desktop instead of
  // rendering nothing. It never fired while all three fixtures had both screenshots null; the
  // first audit with a phone shot and no desktop shot took the whole render down.
  const desktopCol = desktop
    ? `
      <div class="col-wide">
        <div class="shot is-desktop"><img src="${desktop.src}" alt=""></div>
        <p class="shot-caption"><strong>Desktop — 1440 × 900 viewport.</strong> Top of the page. ${esc(v.measurement.finalUrl || '')}</p>
      </div>`
    : ''
  const mobileCol = mobile
    ? `
      <div class="${desktop ? 'col-narrow' : 'col-wide'}">
        <div class="shot"><img src="${mobile.src}" alt=""></div>
        <p class="shot-caption"><strong>Phone — 390 × 844 viewport.</strong> Top of the page, as the browser laid it out at that size${mobile.width ? ` (captured ${mobile.width} × ${mobile.height} px)` : ''}.</p>
      </div>`
    : ''
  return `
  <section>
    <div class="section-head"><h2>Screenshots</h2><span class="aside">Captured during this audit</span></div>
    <div class="shot-pair">${desktopCol}${mobileCol}</div>
  </section>`
}

function methodNote (v) {
  const weights = Object.values(AREAS).map(a => `${a.label} ${Math.round(a.weight * 100)}%`).join(', ')
  return `
  <section>
    <div class="section-head"><h2>How this was measured</h2><span class="aside">And what it does not tell you</span></div>
    <div class="method">
      <p>The site was loaded twice in a real Chrome — once at 1440 × 900 and once at 390 × 844 with a
      3× device pixel ratio — and every number in this report comes from that visit. Page weight is
      counted from the network requests the browser actually made, not estimated from the HTML.</p>
      <p>The overall score is a weighted average of the five areas (${esc(weights)}), and each area
      starts at 100 with a penalty subtracted per finding. The weights are a judgement about what
      matters to a small business with local customers, not an industry standard. Two sites a point
      apart are not meaningfully different; a site at 30 and a site at 80 are.</p>
      <p>This is one page, on one day, from one network. It does not test forms, checkout,
      logged-in pages, or anything behind a click. It is a first look, meant to tell you where an
      hour of closer attention would go — not the last word on the site.</p>
    </div>
  </section>`
}

/* ── the document ─────────────────────────────────────────────────────────────────────────── */

/**
 * @param {import('../contract.js').Audit} audit
 * @param {{preparedBy?:string, imageQuality?:number, compressImages?:boolean}} [opts]
 *   `preparedBy` overrides `audit.preparedBy`; normally the audit carries it.
 * @returns {string} a complete, self-contained HTML document
 */
export function renderHtml (audit, opts = {}) {
  assertAudit(audit)
  const v = view(audit, opts)
  const title = `Website audit — ${v.business.name || v.measurement.url || 'site'}`

  const sheet1 = !v.reachable
    ? downBlock(v)
    : `${v.hasScore ? verdictBlock(v) : ''}${areaBars(v)}<hr class="rule">${ownerFindings(v)}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
${fontCss()}
${stylesheet()}
</style>
</head>
<body>

<article class="sheet" id="sheet-owner">
  ${masthead(v, { kicker: 'Website audit', page: '1' })}
  ${sheet1}
  ${colophon(v, 'For the owner')}
</article>

<article class="sheet" id="sheet-findings">
  ${masthead(v, { kicker: 'Every finding, with the evidence', page: '2' })}
  <div class="sheet-gap"></div>
  ${findingList(v)}
  ${colophon(v, 'For the developer')}
</article>

<article class="sheet" id="sheet-appendix">
  ${masthead(v, { kicker: 'Measurements and method', page: '3' })}
  <div class="sheet-gap"></div>
  <section>
    <div class="section-head"><h2>What we measured</h2><span class="aside">${esc(v.measurement.fetchedAt || '')}</span></div>
    ${metrics(v)}
  </section>
  ${evidenceSection(v)}
  <hr class="rule">
  ${methodNote(v)}
  ${colophon(v, 'For the developer')}
</article>

</body>
</html>
`
}
