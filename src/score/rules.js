// The finding catalogue.
//
// Every rule answers two questions in two voices: what is measurably wrong (for the developer) and
// what it costs the owner (for the owner). If a rule cannot express the second in one plain
// sentence a builder in Grand Falls-Windsor would nod at, it does not belong here.
//
// House style for `plainEnglish`:
//   - address the owner as "you", talk about their customers
//   - no jargon at all: no "viewport", no "DOM", no "render-blocking", no "LCP"
//   - say the consequence, not the mechanism
//   - never scold, never catastrophise, never invent a statistic

import { SEVERITY } from '../contract.js'

const bytes = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`
const secs = ms => `${(ms / 1000).toFixed(1)} seconds`

/** Turn a CSS selector into something an owner can picture, without pretending to more than we know. */
function describe (selector) {
  const s = selector.toLowerCase()
  if (/table/.test(s)) return 'a table'
  if (/img|image|photo|gallery|carousel|slider/.test(s)) return 'an image'
  if (/nav|menu/.test(s)) return 'the menu'
  if (/video|iframe|map|embed/.test(s)) return 'an embedded video or map'
  if (/header|hero|banner/.test(s)) return 'the banner at the top'
  if (/footer/.test(s)) return 'the footer'
  if (/form/.test(s)) return 'a form'
  return `an element (${selector})`
}

export const RULES = [

  // ---- Phones -------------------------------------------------------------------------------
  {
    id: 'no-viewport-meta', area: 'mobile', severity: SEVERITY.CRITICAL, penalty: 55, effort: 'moderate',
    title: 'Site was never set up for phones',
    when: m => !m.mobile.hasViewportMeta,
    evidence: () => 'no viewport meta tag — the page is served to phones at desktop width',
    plainEnglish: () => 'Your site was built before phones mattered, and it still behaves that way. On a phone it loads zoomed out, so everything is too small to read until the visitor pinches in. Most of them will not bother.'
  },
  {
    id: 'horizontal-overflow', area: 'mobile', severity: SEVERITY.CRITICAL, penalty: 40, effort: 'moderate',
    title: 'Page slides sideways on a phone',
    when: m => m.mobile.horizontalOverflowPx > 8,
    evidence: m => m.mobile.overflowCulprit
      ? `${m.mobile.horizontalOverflowPx}px of horizontal scroll at 390px; widest offender ${m.mobile.overflowCulprit.selector} at ${m.mobile.overflowCulprit.widthPx}px`
      : `${m.mobile.horizontalOverflowPx}px of horizontal scroll at 390px wide`,
    plainEnglish: m => m.mobile.overflowCulprit
      ? `On a phone your page is wider than the screen, so it slides side to side while people try to read it. The widest thing on it is ${describe(m.mobile.overflowCulprit.selector)}, at ${m.mobile.overflowCulprit.widthPx} pixels on a 390 pixel screen.`
      : 'On a phone your page is wider than the screen, so it slides side to side while people try to read it. It reads as broken even to visitors who could not tell you why.'
  },
  {
    id: 'tap-targets-small', area: 'mobile', severity: SEVERITY.MAJOR, penalty: 18, effort: 'moderate',
    title: 'Buttons and links are too small to tap',
    when: m => m.mobile.tapTargetsUnder44 >= 3,
    evidence: m => `${m.mobile.tapTargetsUnder44} tap targets under 44px${m.mobile.smallestTapTargetPx ? `, smallest ${m.mobile.smallestTapTargetPx}px` : ''}`,
    plainEnglish: m => `${m.mobile.tapTargetsUnder44} of your buttons and links are too small to hit reliably with a thumb. People miss, land on the wrong thing, and give up — usually on the way to phoning you.`
  },

  // ---- Speed --------------------------------------------------------------------------------
  {
    id: 'load-never-finishes', area: 'performance', severity: SEVERITY.CRITICAL, penalty: 40, effort: 'moderate',
    title: 'Page never finishes loading',
    // loadMs of 0 means the event never fired, NOT that the page was instant. Half the small
    // business web has one request hanging behind an analytics tag: the page looks fine, the
    // spinner never stops, and every timing number stays at zero.
    when: m => m.timing.loadMs === 0,
    evidence: () => 'the load event never fired — something on the page is still waiting',
    plainEnglish: () => 'Something on your site never finishes loading. The page usually looks fine, but the browser keeps spinning, and anything set to happen once the page is ready — a form, a map, a booking widget — may simply never start.'
  },
  {
    id: 'page-far-too-heavy', area: 'performance', severity: SEVERITY.CRITICAL, penalty: 45, effort: 'moderate',
    title: 'Page is enormous',
    when: m => m.weight.totalBytes > 6e6,
    evidence: m => `${bytes(m.weight.totalBytes)} over ${m.weight.requests} requests${m.weight.largestImage ? `; largest image ${bytes(m.weight.largestImage.bytes)}` : ''}`,
    plainEnglish: m => `Your home page is ${bytes(m.weight.totalBytes)}. That is roughly a hundred times what it needs to be. On a phone outside town it will not finish loading before the visitor leaves, and it eats their data allowance while they wait.`
  },
  {
    id: 'page-heavy', area: 'performance', severity: SEVERITY.MAJOR, penalty: 20, effort: 'quick',
    title: 'Page is heavier than it needs to be',
    when: m => m.weight.totalBytes > 2.5e6 && m.weight.totalBytes <= 6e6,
    evidence: m => `${bytes(m.weight.totalBytes)}, images ${bytes(m.weight.imageBytes)}`,
    plainEnglish: () => 'Your pictures are being sent at full camera size and shrunk down in the browser. Resizing them is an afternoon of work and the site will feel noticeably quicker.'
  },
  {
    id: 'slow-load', area: 'performance', severity: SEVERITY.CRITICAL, penalty: 35, effort: 'moderate',
    title: 'Page takes too long to appear',
    when: m => m.timing.loadMs > 5000,
    evidence: m => `${secs(m.timing.loadMs)} to finish loading, ${secs(m.timing.ttfbMs)} before the server even answered`,
    plainEnglish: m => `Your site takes ${secs(m.timing.loadMs)} to load. Visitors start leaving at about three, and Google has been ranking slow sites lower for years, so this costs you twice.`
  },
  {
    id: 'slow-server', area: 'performance', severity: SEVERITY.MAJOR, penalty: 15, effort: 'moderate',
    title: 'Server is slow to respond',
    when: m => m.timing.ttfbMs > 800,
    evidence: m => `${secs(m.timing.ttfbMs)} to first byte`,
    plainEnglish: () => 'Before your site can even begin to load, there is a long pause while the hosting answers. That pause is on every single page, for every visitor.'
  },

  // ---- Trust --------------------------------------------------------------------------------
  {
    id: 'no-https', area: 'trust', severity: SEVERITY.CRITICAL, penalty: 50, effort: 'quick',
    title: 'Browsers mark the site "Not secure"',
    when: m => !m.https.enabled,
    evidence: () => 'served over http, no redirect to https',
    plainEnglish: () => 'Chrome and Safari label your site "Not secure" in the address bar. Nothing is actually wrong with your business — the certificate is usually free and takes an hour — but every visitor sees that warning before they see your work.'
  },
  {
    id: 'certificate-problem', area: 'trust', severity: SEVERITY.CRITICAL, penalty: 45, effort: 'quick',
    title: 'Security certificate is not trusted',
    when: m => !!m.https.certificateProblem,
    evidence: m => m.https.certificateProblem,
    plainEnglish: () => 'Your site has a security certificate, but browsers do not trust it — usually because it has expired. Visitors get a full red warning page telling them the site may be unsafe, and most will not click past it.'
  },
  {
    id: 'stale-copyright', area: 'trust', severity: SEVERITY.MAJOR, penalty: 25, effort: 'quick',
    title: 'Site looks abandoned',
    when: m => m.freshness.copyrightYear !== null && (new Date().getFullYear() - m.freshness.copyrightYear) >= 3,
    evidence: m => `footer reads © ${m.freshness.copyrightYear}`,
    plainEnglish: m => `Your footer still says ${m.freshness.copyrightYear}. To someone deciding whether to call you, that reads as "these people may not be in business any more."`
  },
  {
    id: 'broken-links', area: 'trust', severity: SEVERITY.MAJOR, penalty: 20, effort: 'quick',
    title: 'Links that go nowhere',
    when: m => m.freshness.brokenLinks.length > 0,
    evidence: m => `${m.freshness.brokenLinks.length} broken link(s): ${m.freshness.brokenLinks.slice(0, 3).map(l => `${l.url} (${l.status})`).join(', ')}`,
    plainEnglish: m => `${m.freshness.brokenLinks.length} link${m.freshness.brokenLinks.length === 1 ? '' : 's'} on your site lead to a "page not found" error. One of them is usually the one somebody clicked to reach you.`
  },

  // ---- Being found --------------------------------------------------------------------------
  {
    id: 'weak-title', area: 'seo', severity: SEVERITY.CRITICAL, penalty: 35, effort: 'quick',
    title: 'Google has nothing useful to show',
    when: m => !m.seo.title || m.seo.titleLength < 15,
    evidence: m => `page title is ${m.seo.title ? `"${m.seo.title}"` : 'missing'}`,
    plainEnglish: m => `The blue headline Google shows for you reads "${m.seo.title || '(blank)'}". It should say what you do and where you do it, because that line is most of the reason somebody clicks you instead of the next result.`
  },
  {
    id: 'no-meta-description', area: 'seo', severity: SEVERITY.MAJOR, penalty: 18, effort: 'quick',
    title: 'No description in search results',
    when: m => !m.seo.metaDescription,
    evidence: () => 'no meta description',
    plainEnglish: () => 'Under your name in Google there should be two lines describing your business. You have not written them, so Google grabs whatever text it finds first — often a menu.'
  },
  {
    id: 'no-h1', area: 'seo', severity: SEVERITY.MAJOR, penalty: 15, effort: 'quick',
    title: 'Page has no main heading',
    when: m => m.seo.h1Count === 0,
    evidence: () => 'no <h1> on the page',
    plainEnglish: () => 'Your page never states its own headline in a way search engines can read, so Google has to guess what the page is about.'
  },
  {
    id: 'no-sitemap', area: 'seo', severity: SEVERITY.MINOR, penalty: 8, effort: 'quick',
    title: 'No sitemap',
    when: m => !m.seo.hasSitemap,
    evidence: () => 'no sitemap.xml found',
    plainEnglish: () => 'There is no index telling search engines what pages you have, so some of them may never be found at all.'
  },
  {
    id: 'no-local-business-schema', area: 'seo', severity: SEVERITY.MINOR, penalty: 10, effort: 'quick',
    title: 'Not marked up as a local business',
    when: m => !m.seo.structuredDataTypes.some(t => /LocalBusiness|Organization/i.test(t)),
    evidence: m => m.seo.structuredDataTypes.length ? `structured data present but no LocalBusiness (${m.seo.structuredDataTypes.join(', ')})` : 'no structured data',
    plainEnglish: () => 'Your address, hours and phone number are not written in the format Google reads for map results. That is the box people use when they are looking for someone nearby, right now.'
  },

  // ---- Accessibility ------------------------------------------------------------------------
  // These carry contract weight, not just goodwill: nonprofit, health and provincial-agency work
  // routinely requires WCAG conformance.
  {
    id: 'images-missing-alt', area: 'accessibility', severity: SEVERITY.MAJOR, penalty: 30, effort: 'quick',
    title: 'Pictures have no description',
    when: m => m.a11y.imagesTotal > 0 && (m.a11y.imagesMissingAlt / m.a11y.imagesTotal) > 0.3,
    evidence: m => `${m.a11y.imagesMissingAlt} of ${m.a11y.imagesTotal} images have no alt text`,
    plainEnglish: m => `${m.a11y.imagesMissingAlt} of your ${m.a11y.imagesTotal} pictures have no written description. Anyone using a screen reader hears silence where your work should be, and Google cannot read them either.`
  },
  {
    id: 'some-images-missing-alt', area: 'accessibility', severity: SEVERITY.MINOR, penalty: 8, effort: 'quick',
    title: 'A few pictures have no description',
    when: m => m.a11y.imagesTotal > 0 && (m.a11y.imagesMissingAlt / m.a11y.imagesTotal) > 0.05 && (m.a11y.imagesMissingAlt / m.a11y.imagesTotal) <= 0.3,
    evidence: m => `${m.a11y.imagesMissingAlt} of ${m.a11y.imagesTotal} images have no alt text`,
    plainEnglish: m => `${m.a11y.imagesMissingAlt} of your pictures are missing a written description. It is a small job and it helps both screen readers and Google.`
  },
  {
    id: 'a-few-small-tap-targets', area: 'mobile', severity: SEVERITY.MINOR, penalty: 5, effort: 'quick',
    title: 'A couple of links are small for a thumb',
    when: m => m.mobile.tapTargetsUnder44 > 0 && m.mobile.tapTargetsUnder44 < 3,
    evidence: m => `${m.mobile.tapTargetsUnder44} tap target(s) under 44px`,
    plainEnglish: m => `${m.mobile.tapTargetsUnder44} link${m.mobile.tapTargetsUnder44 === 1 ? ' is' : 's are'} a little small to hit comfortably on a phone. Worth nudging up next time the site is touched.`
  },
  {
    id: 'inputs-missing-label', area: 'accessibility', severity: SEVERITY.CRITICAL, penalty: 35, effort: 'quick',
    title: 'Form fields are unlabelled',
    when: m => m.a11y.inputsMissingLabel > 0,
    evidence: m => `${m.a11y.inputsMissingLabel} form field(s) with no associated label`,
    plainEnglish: m => `${m.a11y.inputsMissingLabel} of the boxes on your contact form have no label attached. Someone using a screen reader is asked to type into a box with no idea what it wants — which means your enquiry form does not work for them.`
  },
  {
    id: 'low-contrast', area: 'accessibility', severity: SEVERITY.MAJOR, penalty: 22, effort: 'moderate',
    title: 'Text is too faint to read',
    // The collector drops any node whose background it cannot resolve — images, gradients,
    // transparent ancestors — so this count undercounts, and only ever in one direction. The
    // threshold is low because of that, and the wording never claims to be a complete list.
    when: m => m.a11y.lowContrastNodes >= 3,
    evidence: m => `at least ${m.a11y.lowContrastNodes} text node(s) below WCAG AA contrast (a floor — nodes over images or transparency are not counted)`,
    plainEnglish: m => `At least ${m.a11y.lowContrastNodes} pieces of text on your site are too pale against their background to read comfortably — outdoors, on an older screen, or by anyone whose eyes are not what they were. There may be more we could not measure. It is a colour change, not a rebuild.`
  },
  {
    id: 'no-lang', area: 'accessibility', severity: SEVERITY.MINOR, penalty: 10, effort: 'quick',
    title: 'Page does not declare its language',
    when: m => !m.a11y.htmlLangSet,
    evidence: () => 'no lang attribute on <html>',
    plainEnglish: () => 'Your page never says which language it is written in, so screen readers may read it aloud with the wrong accent and pronunciation.'
  },
  {
    id: 'no-main-landmark', area: 'accessibility', severity: SEVERITY.MINOR, penalty: 8, effort: 'moderate',
    title: 'No way to skip past the menu',
    when: m => !m.a11y.hasMainLandmark && !m.a11y.hasSkipLink,
    evidence: () => 'no <main> landmark and no skip link',
    plainEnglish: () => 'Someone navigating by keyboard has to tab through your entire menu on every single page before reaching the content.'
  },

  // ---- Things done right --------------------------------------------------------------------
  // A report that can only ever say "everything is broken" is not credible, and the good news is
  // what makes an owner trust the bad news.
  {
    id: 'good-https', area: 'trust', severity: SEVERITY.GOOD, penalty: 0, effort: 'quick',
    title: 'Secure connection in place',
    when: m => m.https.enabled && m.https.mixedContent.length === 0,
    evidence: () => 'https with no mixed content',
    plainEnglish: () => 'Your site is served securely and browsers are happy with it.'
  },
  {
    id: 'good-mobile', area: 'mobile', severity: SEVERITY.GOOD, penalty: 0, effort: 'quick',
    title: 'Works properly on a phone',
    when: m => m.mobile.hasViewportMeta && m.mobile.horizontalOverflowPx <= 8,
    evidence: () => 'responsive, no sideways scroll at 390px',
    plainEnglish: () => 'Your site fits a phone screen properly, which is where most of your visitors are.'
  },
  {
    id: 'good-speed', area: 'performance', severity: SEVERITY.GOOD, penalty: 0, effort: 'quick',
    title: 'Loads quickly',
    // `> 0` is load-bearing: a page whose load event never fired reports 0 and must never be
    // congratulated on its speed.
    when: m => m.timing.loadMs > 0 && m.timing.loadMs <= 2500 && m.weight.totalBytes <= 2.5e6,
    evidence: m => `${secs(m.timing.loadMs)}, ${bytes(m.weight.totalBytes)}`,
    plainEnglish: () => 'Your site loads quickly, which visitors notice even if they never mention it.'
  }
]
