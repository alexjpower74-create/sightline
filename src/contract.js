// THE CONTRACT.
//
// Owned by vera. Neither the collector nor the report may change this file — if a slice needs a
// new field, ask for it in your report and it gets added here once, for everyone.
//
// The pipeline is three stages and two hand-offs:
//
//   collect/  -> Measurement  -> score/ -> { Score, Finding[] } -> report/ -> HTML + PDF
//
// Everything a stage needs is in its input object. No stage reaches back for more.

/** Severity drives both the score weighting and the order findings appear in the report. */
export const SEVERITY = { CRITICAL: 'critical', MAJOR: 'major', MINOR: 'minor', GOOD: 'good' }

/** The five areas a small-business owner actually understands. Weights sum to 1. */
/**
 * The five areas a small-business owner actually understands. Weights sum to 1.
 *
 * `accessibility` here means "the specific barriers this tool checks for" and nothing wider. It is
 * eight checks, not a share of any standard, and a full score means those eight are clear — not
 * that a site conforms to anything. Never print the name of a standard beside it: a number out of
 * 100 next to those letters is a claim this tool is not entitled to make, and it is exactly the
 * claim that gets forwarded to somebody who checks.
 */
export const AREAS = {
  performance:   { label: 'Speed',         weight: 0.25 },
  mobile:        { label: 'Phones',        weight: 0.25 },
  accessibility: { label: 'Accessibility', weight: 0.20 },
  seo:           { label: 'Being found',   weight: 0.20 },
  trust:         { label: 'Trust',         weight: 0.10 }
}

/**
 * @typedef {Object} Measurement   Produced by src/collect/. One site, one visit.
 * @property {string}  url          as supplied
 * @property {string}  finalUrl     after redirects
 * @property {string}  fetchedAt    ISO 8601
 * @property {boolean} ok           false when the site could not be reached at all
 * @property {string|null} error
 * @property {'dns'|'timeout'|'refused'|'http-error'|'blocked'|'tls'|'checker-error'|null} unreachableReason
 *   Why we could not read the site. `blocked` is deliberately distinct from the rest: bot
 *   protection refusing our checker is NOT the same as the site being down, and telling an owner
 *   their working site is down is the single worst thing this tool could do.
 * @property {{url:string, status:number}[]} redirects
 *   The hops between the address someone typed and the page that was drawn. `collect` already
 *   follows this chain; recording it makes it reportable. "Your address takes five hops before
 *   anything appears" is actionable in a way a load time is not, and it is invisible to everyone
 *   except the person waiting.
 * @property {{ttfbMs:number, domContentLoadedMs:number, loadMs:number}} timing
 *   `loadMs` / `domContentLoadedMs` of **0 mean the event never fired**, not that the page was
 *   instant. A page with one request hanging behind an analytics tag is visible and usable and
 *   never finishes loading. Any rule reading these must check for 0 explicitly, or it will award
 *   a compliment for the exact thing that is broken.
 * @property {{totalBytes:number, requests:number, imageBytes:number, scriptBytes:number,
 *            largestImage:{url:string, bytes:number}|null}} weight
 * @property {{enabled:boolean, redirectsToHttps:boolean, mixedContent:string[],
 *            certificateProblem:string|null}} https
 * @property {{hasViewportMeta:boolean, viewportContent:string|null, horizontalOverflowPx:number,
 *            tapTargetsUnder44:number, smallestTapTargetPx:number|null,
 *            overflowCulprit:{selector:string, widthPx:number, pastPx:number}|null}} mobile
 *   `overflowCulprit` names the widest offending element. "Your price table is 900px wide on a
 *   390px screen" is an instruction; "your page overflows by 510px" is a complaint.
 * @property {{imagesMissingAlt:number, imagesTotal:number, inputsMissingLabel:number,
 *            headingOrderBreaks:number, hasMainLandmark:boolean, hasSkipLink:boolean,
 *            htmlLangSet:boolean, lowContrastNodes:number}} a11y
 * @property {{title:string|null, titleLength:number, metaDescription:string|null,
 *            metaDescriptionLength:number, h1Count:number, canonical:string|null,
 *            hasRobotsTxt:boolean, hasSitemap:boolean, ogTags:string[],
 *            structuredDataTypes:string[]}} seo
 * @property {{copyrightYear:number|null, generator:string|null,
 *            brokenLinks:{url:string, status:number|string}[], lastModified:string|null}} freshness
 * @property {{desktop:string|null, mobile:string|null}} screenshots  file paths, may be null
 */

/** A blank Measurement. The collector fills it in; anything it cannot measure stays at this value. */
export function emptyMeasurement (url) {
  return {
    url, finalUrl: url, fetchedAt: new Date().toISOString(), ok: false, error: null, unreachableReason: null,
    redirects: [],
    timing: { ttfbMs: 0, domContentLoadedMs: 0, loadMs: 0 },
    weight: { totalBytes: 0, requests: 0, imageBytes: 0, scriptBytes: 0, largestImage: null },
    https: { enabled: false, redirectsToHttps: false, mixedContent: [], certificateProblem: null },
    mobile: { hasViewportMeta: false, viewportContent: null, horizontalOverflowPx: 0, tapTargetsUnder44: 0, smallestTapTargetPx: null, overflowCulprit: null },
    a11y: { imagesMissingAlt: 0, imagesTotal: 0, inputsMissingLabel: 0, headingOrderBreaks: 0, hasMainLandmark: false, hasSkipLink: false, htmlLangSet: false, lowContrastNodes: 0 },
    seo: { title: null, titleLength: 0, metaDescription: null, metaDescriptionLength: 0, h1Count: 0, canonical: null, hasRobotsTxt: false, hasSitemap: false, ogTags: [], structuredDataTypes: [] },
    freshness: { copyrightYear: null, generator: null, brokenLinks: [], lastModified: null },
    screenshots: { desktop: null, mobile: null }
  }
}

/**
 * @typedef {Object} Finding    Produced by src/score/. One thing wrong (or right) with the site.
 * @property {string} id        stable slug, e.g. "images-missing-alt"
 * @property {keyof AREAS} area
 * @property {string} severity  one of SEVERITY
 * @property {string} title     short, for the report's finding list
 * @property {string} plainEnglish  what this costs the OWNER, in their words, no jargon
 * @property {string} evidence  the measured number that triggered it
 * @property {'quick'|'moderate'|'rebuild'} effort
 */

/**
 * @typedef {Object} Score
 * @property {number} overall            0-100
 * @property {Record<string, number>} areas  0-100 per key of AREAS
 * @property {string} hook               the single most damning finding, in one plain sentence
 * @property {string} band               'urgent' | 'weak' | 'fair' | 'strong'
 */

/**
 * @typedef {Object} Business
 * @property {string} name
 * @property {string} url
 * @property {string} [town]
 * @property {string} [sector]
 * @property {string} [phone]
 */

/**
 * @typedef {Object} Audit   The single object handed to src/report/. Self-contained on purpose.
 * @property {Business} business
 * @property {Measurement} measurement
 * @property {Score} score
 * @property {Finding[]} findings
 * @property {string} generatedAt
 * @property {string} [preparedBy]  who is sending this. An audit arriving unsigned from a stranger
 *   reads as spam; the same document with a name on it reads as a person who did some work.
 */

/**
 * WHAT YOU CAN STAND BEHIND A WEEK LATER.
 *
 * An audit is one visit. Some of what it records is a property of how the site is built and will
 * still be true when the owner checks; some is a property of the moment we looked. A report that
 * treats them alike will eventually be argued with by an owner who is right.
 *
 * Observed live: Marwood Ltd tripped `load-never-finishes` on one run and `slow-load` at 19.5
 * seconds on the next. Same site, same collector, a few hours apart. Both statements were true
 * about the visit that produced them.
 *
 * This covers every field. A partial classification invites exactly the confident guess it was
 * written to prevent.
 *
 * VOLATILE — quotable only as "when we checked":
 *   timing.*                      the field that moved on Marwood Ltd
 *   weight.totalBytes, .requests, .imageBytes, .scriptBytes, .largestImage
 *                                 ad and tag networks serve a different payload per visit
 *   freshness.brokenLinks         a link that answered 503 once is not dead (timeouts are already
 *                                 excluded for this reason; transient 5xx are not)
 *   mobile.horizontalOverflowPx   stable for a hard-coded width, but an injected ad or a lazy
 *                                 image can add or remove it
 *   mobile.overflowCulprit        follows horizontalOverflowPx, inherits its volatility
 *   unreachableReason             volatile by definition
 *
 * STABLE — properties of how the site is built:
 *   mobile.hasViewportMeta, .viewportContent             https.enabled, .redirectsToHttps
 *   seo.title, .metaDescription, .h1Count, .canonical, .ogTags, .structuredDataTypes
 *   a11y.hasMainLandmark          a11y.hasSkipLink       a11y.htmlLangSet
 *   a11y.imagesMissingAlt / imagesTotal                  freshness.copyrightYear, .generator
 *
 * STABLE PROPERTY, FLAKY MEASUREMENT — the site does not change, our reading of it might:
 *   seo.hasRobotsTxt, .hasSitemap  network probes, not page reads: a GET with a short timeout and
 *                                 a retry on 5xx. Whether a site HAS a sitemap is stable; whether
 *                                 we saw it is not, and the finding is categorical and disputable.
 *                                 "You have no sitemap" to an owner who has one costs you the rest
 *                                 of the document. The probe retries rather than the field being
 *                                 downgraded, because the thing measured really is stable.
 *   mobile.tapTargetsUnder44, .smallestTapTargetPx
 *                                 layout is stable, but a cookie banner or lazily-inserted content
 *                                 changes what is hit-testable; the count can move by a few.
 *   a11y.lowContrastNodes         a property of the CSS, but it is already a floor rather than a
 *                                 count — a background image appearing on one visit lowers it.
 *   https.mixedContent, .certificateProblem
 *                                 stable in practice; a certificate expires on a date, and that
 *                                 date can fall between two runs.
 *   freshness.lastModified        stable when present, absent on most dynamic sites — so its
 *                                 absence means nothing and must never be reported as a finding.
 *
 * The convenient part: the findings that sell are almost all in the second list. A stale copyright
 * year, no viewport meta, no HTTPS — an owner cannot dispute those and they will still be true
 * when they look. The ones that move are mostly the speed numbers, which is exactly where the
 * report's "when we checked" is already doing the work.
 *
 * No check can catch this class, and none could: it is a property of sampling once, not a defect.
 * If it ever matters, the two fixes are measuring twice and reporting the median, or carrying a
 * confidence marker on the volatile fields. Neither is worth building before someone is burned.
 */

/** Cheap structural validation, so a bad hand-off fails loudly at the seam instead of quietly downstream. */
export function assertMeasurement (m) {
  const need = ['url', 'finalUrl', 'fetchedAt', 'ok', 'timing', 'weight', 'https', 'mobile', 'a11y', 'seo', 'freshness']
  const missing = need.filter(k => !(k in m))
  if (missing.length) throw new Error(`Measurement is missing: ${missing.join(', ')} — see src/contract.js`)
  return m
}

export function assertAudit (a) {
  for (const k of ['business', 'measurement', 'score', 'findings']) {
    if (!(k in a)) throw new Error(`Audit is missing "${k}" — see src/contract.js`)
  }
  if (!Array.isArray(a.findings)) throw new Error('Audit.findings must be an array')
  return a
}
