// The collector.
//
//   collect(url, opts) -> Measurement   (src/contract.js)
//
// Two passes through real Chrome: 1440x900 for timing and weight, 390x844 for everything the
// owner sees holding their phone. Real Chrome and not a fetch of the HTML, because half of what
// is wrong with a neglected small-business site only exists after its scripts have run.
//
// The contract for failure is as important as the contract for success: every site — a dead
// domain, a redirect loop, a 500, a page whose load event never fires, a 40MB monster — comes back
// as a Measurement with `ok:false` and a real `error`. Nothing here throws at the caller.

import { emptyMeasurement } from '../contract.js'
import { launch } from '@alexpower/rig/harness/cdp.js'
import { wheel, sleep } from '@alexpower/rig/harness/input.js'
import { recordNetwork } from './network.js'
import { checkLinks, siteFiles, relativise } from './links.js'
import { capture, stemFor } from './screenshot.js'
import {
  evalFn, docInfoScript, timingScript, seoScript, a11yScript, freshnessScript, pageLinksScript,
  viewportMetaScript, overflowGeometryScript, readScrollScript, overflowCulpritScript,
  tapSetupScript, tapSweepScript, tapTallyScript
} from './page-scripts.js'

export const DESKTOP = { width: 1440, height: 900, dpr: 2, mobile: false }
export const MOBILE = { width: 390, height: 844, dpr: 3, mobile: true }

/**
 * @param {string} url
 * @param {{timeoutMs?:number, navTimeoutMs?:number, outDir?:string|null, browser?:object,
 *          headless?:boolean, port?:number, maxLinks?:number, onNote?:(n:object)=>void,
 *          checkLinks?:boolean, screenshots?:boolean}} opts
 * @returns {Promise<import('../contract.js').Measurement>}
 */
export async function collect (url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const deadline = Date.now() + timeoutMs
  const note = opts.onNote || (() => {})
  const m = emptyMeasurement(url)

  let browser = opts.browser || null
  const borrowedBrowser = !!opts.browser
  let timer = null

  try {
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`gave up after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    })
    const work = (async () => {
      if (!browser) browser = await launch({ headless: opts.headless ?? true, port: opts.port ?? 9333 + (process.pid % 500), width: DESKTOP.width, height: DESKTOP.height })
      await runPasses(browser, url, m, { ...opts, deadline, note })
    })()
    await Promise.race([work, expiry])
    // A stage that failed softly (a 500, say) has already written its own error.
    if (!m.error) m.ok = true
  } catch (err) {
    // Whatever we did manage to measure stays in `m`. The caller gets a partial picture and an
    // honest reason, which is far more useful downstream than an exception.
    m.ok = false
    m.error = describe(err)
  } finally {
    clearTimeout(timer)
    if (browser && !borrowedBrowser) { try { await browser.close() } catch { /* it is going away regardless */ } }
  }
  return m
}

async function runPasses (browser, url, m, opts) {
  const { deadline, note } = opts

  // ---- desktop: timing, weight, https, seo, a11y, freshness ----------------------------------
  const desk = await browser.newPage('about:blank', DESKTOP)
  const net = recordNetwork(desk)
  let sameOriginLinks = []
  try {
    await desk.send('Network.enable', { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 })
    await desk.send('Network.setCacheDisabled', { cacheDisabled: true })
    await navigate(desk, url, { budget: share(deadline, 0.45, opts.navTimeoutMs ?? 20_000), net })

    const info = await evalFn(desk, docInfoScript)
    m.finalUrl = info.href
    m.https.enabled = m.finalUrl.startsWith('https://')
    m.https.redirectsToHttps = /^http:\/\//.test(url) && m.https.enabled
    m.https.mixedContent = net.mixedContent(m.finalUrl).map(u => relativise(u, info.origin))

    const doc = net.document()
    if (doc) {
      const lm = doc.headers['last-modified']
      if (lm) { const d = new Date(lm); if (!Number.isNaN(+d)) m.freshness.lastModified = d.toISOString() }
      // Reached, but broken. `ok:false` here is deliberate — a homepage answering 500 or 404 is
      // down as far as its owner's customers are concerned, and the report has a path for that.
      if (doc.status >= 400) m.error = `HTTP ${doc.status} from ${doc.url}`
    }

    await settle(desk, deadline)
    m.timing = await evalFn(desk, timingScript)
    m.weight = normaliseWeight(net.weight(), info.origin)

    const seo = await evalFn(desk, seoScript, {})
    Object.assign(m.seo, {
      title: seo.title || null, titleLength: seo.titleLength,
      metaDescription: seo.metaDescription, metaDescriptionLength: seo.metaDescriptionLength,
      h1Count: seo.h1Count, canonical: seo.canonical, ogTags: seo.ogTags,
      structuredDataTypes: seo.structuredDataTypes
    })

    const a11y = await evalFn(desk, a11yScript, { maxNodes: opts.maxNodes || 4000 })
    Object.assign(m.a11y, {
      imagesMissingAlt: a11y.imagesMissingAlt, imagesTotal: a11y.imagesTotal,
      inputsMissingLabel: a11y.inputsMissingLabel, headingOrderBreaks: a11y.headingOrderBreaks,
      hasMainLandmark: a11y.hasMainLandmark, hasSkipLink: a11y.hasSkipLink,
      htmlLangSet: a11y.htmlLangSet, lowContrastNodes: a11y.lowContrastNodes
    })
    note({ kind: 'contrast', examined: a11y.contrastExamined, unresolved: a11y.contrastUnresolved, samples: a11y.contrastSamples })

    const fresh = await evalFn(desk, freshnessScript, {})
    m.freshness.copyrightYear = fresh.copyrightYear
    m.freshness.generator = fresh.generator || inferGenerator(net.all())

    sameOriginLinks = await evalFn(desk, pageLinksScript, { max: opts.maxLinks ?? 40 })

    if (opts.screenshots !== false && opts.outDir) {
      const shot = await capture(desk, { outDir: opts.outDir, name: `${stemFor(url)}-desktop`, clip: { x: 0, y: 0, width: DESKTOP.width, height: DESKTOP.height }, scale: 1 })
      m.screenshots.desktop = shot.path
      note({ kind: 'screenshot', which: 'desktop', ...shot })
    }
  } finally {
    await desk.close().catch(() => {})
  }

  // Network probes are IO — start them now and let them run alongside the mobile pass rather than
  // spending the budget twice.
  const origin = originOf(m.finalUrl)
  const probes = (async () => {
    if (opts.checkLinks === false || !origin) return { broken: [], files: { hasRobotsTxt: false, hasSitemap: false } }
    const [broken, files] = await Promise.all([
      checkLinks(sameOriginLinks, { max: opts.maxLinks ?? 40, timeoutMs: 5000, deadline: deadline - 1000 }),
      siteFiles(origin, { timeoutMs: 5000 })
    ])
    return { broken, files }
  })().catch(() => ({ broken: [], files: { hasRobotsTxt: false, hasSitemap: false } }))

  // ---- mobile: the page in a hand ------------------------------------------------------------
  const phone = await browser.newPage('about:blank', MOBILE)
  try {
    await phone.send('Network.setCacheDisabled', { cacheDisabled: true })
    await navigate(phone, m.finalUrl, { budget: share(deadline, 0.6, opts.navTimeoutMs ?? 20_000) })
    await settle(phone, deadline)

    Object.assign(m.mobile, await evalFn(phone, viewportMetaScript))

    // Read it twice. Web fonts swap in and lazy images arrive after the load event, and either can
    // push a page sideways a second later; a page measured only at load and a page measured after
    // a visitor has scrolled it routinely disagree. The second reading comes after the tap-target
    // sweep, which has scrolled the whole page with real input and pulled in the lazy content.
    const settled = await measureHorizontalOverflow(phone, note)

    const targets = await evalFn(phone, tapSetupScript, { max: opts.maxTapTargets ?? 600 })
    const sweep = await sweepWithRealInput(phone, deadline, opts.sweepScreens ?? 6)

    const afterSweep = await measureHorizontalOverflow(phone, note, { probeWithInput: false, label: 'after-sweep' })
    m.mobile.horizontalOverflowPx = Math.max(settled.px, afterSweep.px)

    const tally = await evalFn(phone, tapTallyScript, { min: 44 })
    m.mobile.tapTargetsUnder44 = tally.under
    m.mobile.smallestTapTargetPx = tally.smallest
    note({ kind: 'tapTargets', candidates: targets, screensSwept: sweep.screens, ...tally })

    if (opts.screenshots !== false && opts.outDir) {
      const info = await evalFn(phone, docInfoScript)
      const height = Math.min(info.scrollHeight || MOBILE.height, MOBILE.height * 2)
      const shot = await capture(phone, { outDir: opts.outDir, name: `${stemFor(m.url)}-mobile`, clip: { x: 0, y: 0, width: MOBILE.width, height }, scale: 2 / MOBILE.dpr })
      m.screenshots.mobile = shot.path
      note({ kind: 'screenshot', which: 'mobile', ...shot })
    }
  } finally {
    await phone.close().catch(() => {})
  }

  const { broken, files } = await probes
  m.freshness.brokenLinks = broken.map(b => relativise(b.url, origin))
  m.seo.hasRobotsTxt = files.hasRobotsTxt
  m.seo.hasSitemap = files.hasSitemap
}

// -----------------------------------------------------------------------------------------------
// Horizontal overflow — the finding an owner feels before you finish the sentence.

/**
 * Two independent readings, and we take the larger only when both agree the page is scrollable:
 *
 *  1. Real wheel input. What the page does when a hand pushes it sideways.
 *  2. scrollWidth - clientWidth on the root, at a pinned 390px viewport.
 *
 * Neither alone is enough. Geometry on its own reports a number for pages whose root clips
 * horizontally, where nothing moves and the visitor sees nothing wrong — a false positive on the
 * heaviest-weighted finding in the catalogue. Input on its own reads zero whenever a carousel or a
 * map eats the wheel event, which would miss the finding entirely. So: if the root clips, the
 * answer is zero whatever the geometry says; otherwise take whichever reading is larger.
 */
async function measureHorizontalOverflow (page, note = () => {}, { probeWithInput = true, label = 'settled' } = {}) {
  const before = await evalFn(page, overflowGeometryScript)
  let scrolled = 0
  if (probeWithInput && !before.clipped && before.layoutOverflowPx > 0) {
    for (let round = 0; round < 3; round++) {
      await wheel(page, { x: Math.round(before.innerWidth / 2), y: 60, dx: 1200, dy: 0, ticks: 10, ms: 8 })
      await sleep(120)
      const at = await evalFn(page, readScrollScript)
      if (at.x <= scrolled) break
      scrolled = at.x
    }
    // Put it back the way we found it, with real input again, before anything is captured.
    for (let round = 0; round < 4 && scrolled > 0; round++) {
      await wheel(page, { x: Math.round(before.innerWidth / 2), y: 60, dx: -1600, dy: 0, ticks: 10, ms: 8 })
      await sleep(80)
      const at = await evalFn(page, readScrollScript)
      if (at.x === 0) break
    }
  }
  const px = before.clipped ? 0 : Math.max(scrolled, before.layoutOverflowPx)
  const culprit = px > 8 ? await evalFn(page, overflowCulpritScript, { viewportWidth: before.clientWidth, maxNodes: 3000 }) : null
  note({ kind: 'overflow', at: label, px, scrolledByInput: scrolled, geometry: before, culprit })
  return { px, culprit }
}

/**
 * Walk the page a screenful at a time with real wheel input, hit-testing whatever is on screen at
 * each stop. A tap target measured by its rectangle alone can be sitting under a sticky header,
 * and getBoundingClientRect will report it as a healthy 48px button all the way to the client.
 */
async function sweepWithRealInput (page, deadline, maxScreens) {
  let screens = 0
  await evalFn(page, tapSweepScript)
  for (; screens < maxScreens; screens++) {
    if (Date.now() > deadline - 4000) break
    const at = await evalFn(page, readScrollScript)
    await wheel(page, { x: Math.round(MOBILE.width / 2), y: Math.round(MOBILE.height / 2), dy: MOBILE.height - 60, ticks: 8, ms: 8 })
    await sleep(140)
    const after = await evalFn(page, readScrollScript)
    await evalFn(page, tapSweepScript)
    if (after.y <= at.y) break              // bottom of the page, or it does not scroll at all
  }
  // Back to the top so a screenshot shows what a visitor sees first.
  for (let i = 0; i <= screens; i++) {
    await wheel(page, { x: Math.round(MOBILE.width / 2), y: Math.round(MOBILE.height / 2), dy: -(MOBILE.height * 2), ticks: 6, ms: 6 })
  }
  await sleep(200)
  return { screens }
}

// -----------------------------------------------------------------------------------------------
// Navigation and settling

class TimeoutError extends Error {}
class NavigationError extends Error {}

/**
 * Navigate and wait for load — but treat a load event that never arrives as a fact about the site
 * rather than as a reason to give up. Plenty of real small-business sites have one request that
 * hangs forever behind an analytics tag; the page is perfectly visible and perfectly measurable,
 * and `timing.loadMs` staying at 0 is itself the finding.
 */
async function navigate (page, url, { budget, net = null }) {
  let loadFired = false
  let domFired = false
  page.on('Page.loadEventFired', () => { loadFired = true })
  page.on('Page.domContentEventFired', () => { domFired = true })

  const nav = await page.send('Page.navigate', { url })
  if (nav.errorText) throw new NavigationError(`${nav.errorText} (${url})`)

  const until = Date.now() + budget
  while (Date.now() < until) {
    if (loadFired) return { loadFired: true }
    const failed = net && net.documentFailure()
    if (failed) throw new NavigationError(`${failed.error}${failed.blocked ? ` (${failed.blocked})` : ''} (${url})`)
    await sleep(100)
  }

  const state = await page.eval('document.readyState + "|" + (document.body ? document.body.childElementCount : -1)').catch(() => 'unknown|-1')
  const [readyState, children] = state.split('|')
  if (readyState === 'complete' || domFired || Number(children) > 0) return { loadFired: false, readyState }
  throw new NavigationError(`no page after ${budget}ms (readyState "${readyState}") (${url})`)
}

/** Give late layout a moment: web fonts swapping in move text, and text is what we measure. */
async function settle (page, deadline) {
  const room = Math.max(0, Math.min(1200, deadline - Date.now() - 3000))
  if (!room) return
  await page.eval(`Promise.race([
    (document.fonts && document.fonts.ready) || Promise.resolve(),
    new Promise(r => setTimeout(r, ${Math.round(room)}))
  ]).then(() => true)`).catch(() => {})
  await sleep(Math.min(300, room))
}

// -----------------------------------------------------------------------------------------------
// Small helpers

/** How long this stage may take: a slice of what is left, never more than its own cap. */
function share (deadline, fraction, cap) {
  return Math.max(1000, Math.min(cap, Math.round((deadline - Date.now()) * fraction)))
}

function normaliseWeight (w, origin) {
  if (w.largestImage) w.largestImage = { url: relativise(w.largestImage.url, origin), bytes: w.largestImage.bytes }
  return w
}

function originOf (url) { try { return new URL(url).origin } catch { return null } }

/** WordPress does not always announce itself in a meta tag, but /wp-content/ is not ambiguous. */
function inferGenerator (records) {
  for (const r of records) {
    if (typeof r.url !== 'string') continue
    if (r.url.includes('/wp-content/') || r.url.includes('/wp-includes/')) return 'WordPress'
    if (r.url.includes('cdn.shopify.com')) return 'Shopify'
    if (r.url.includes('static.parastorage.com')) return 'Wix'
    if (r.url.includes('assets.squarespace.com')) return 'Squarespace'
  }
  return null
}

function describe (err) {
  if (err instanceof TimeoutError) return err.message
  const raw = err?.message || String(err)
  // net::ERR_NAME_NOT_RESOLVED and friends read like a stack trace to anyone downstream. The
  // report puts this sentence in front of a person, so make it a sentence.
  const map = {
    'net::ERR_NAME_NOT_RESOLVED': 'that domain does not resolve — the site is gone or the name has lapsed',
    'net::ERR_CONNECTION_REFUSED': 'the server refused the connection',
    'net::ERR_CONNECTION_TIMED_OUT': 'the server never answered',
    'net::ERR_CONNECTION_RESET': 'the server dropped the connection',
    'net::ERR_TOO_MANY_REDIRECTS': 'the site redirects to itself in a loop and never arrives',
    'net::ERR_CERT_COMMON_NAME_INVALID': 'the security certificate does not match this domain',
    'net::ERR_CERT_DATE_INVALID': 'the security certificate has expired',
    'net::ERR_SSL_PROTOCOL_ERROR': 'the secure connection could not be established',
    'net::ERR_EMPTY_RESPONSE': 'the server answered with nothing at all',
    'net::ERR_ADDRESS_UNREACHABLE': 'the server could not be reached'
  }
  for (const [code, sentence] of Object.entries(map)) if (raw.includes(code)) return `${sentence} (${code})`
  return raw
}

export { measureHorizontalOverflow, navigate, describe }
export default collect
