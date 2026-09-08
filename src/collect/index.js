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

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { emptyMeasurement } from '../contract.js'
import { launch } from '@alexpower/rig/harness/cdp.js'
import { wheel, sleep } from '@alexpower/rig/harness/input.js'
import { recordNetwork } from './network.js'
import { checkLinks, siteFiles, relativise, UA } from './links.js'
import { capture, stemFor } from './screenshot.js'
import { freePort } from './free-port.js'
import {
  evalFn, docInfoScript, timingScript, seoScript, a11yScript, freshnessScript, pageLinksScript,
  viewportMetaScript, overflowGeometryScript, readScrollScript, overflowCulpritScript,
  tapSetupScript, tapSweepScript, tapTallyScript, refusalSignalsScript
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
  const first = await attempt(url, opts, {})

  // It worked, or the server gave us a real HTTP answer we already understand — a 404, a 500, or
  // bot protection turning us away. Nothing to second-guess.
  if (first.m.ok) return first.m
  if (first.m.unreachableReason === 'blocked' || first.m.unreachableReason === 'http-error') return first.m

  // Never declare a site down on one tool's word.
  //
  // This exists because we did exactly that to a real business. Chrome could not negotiate HTTP/2
  // with a live site and returned ERR_HTTP2_PROTOCOL_ERROR; the report went out saying "anyone
  // who looks you up right now sees an error page instead of your business". curl got a 200 in
  // 1.3 seconds. The site was fine. Our checker was not.
  const second = await confirmUnreachable(url, opts)
  if (!second.reachable) {
    // Both instruments agree. The site really is unreachable.
    first.m.unreachableReason = classifyFailure(first.err)
    return first.m
  }

  // A plain HTTP/1.1 client just got through, so an HTTP/1.1 conversation with this server works
  // and it is the browser that could not hold one. Give the browser the same conversation before
  // settling for a non-answer: a real measurement beats a graceful shrug, and a site whose server
  // speaks broken HTTP/2 is otherwise a permanent blind spot.
  const note = opts.onNote || (() => {})
  let retriedWith = null
  if (opts.retryWithoutHttp2 !== false && !(first.err instanceof TimeoutError)) {
    note({ kind: 'retry', why: rawCodeOf(first.err) || describe(first.err), plainStatus: second.status })
    const retry = await attempt(url, {
      ...opts,
      browser: null,          // the borrowed browser cannot be relaunched with different flags
      port: undefined,
      timeoutMs: opts.retryTimeoutMs ?? Math.min(opts.timeoutMs ?? 45_000, 30_000)
    }, { chromeArgs: ['--disable-http2'] })

    if (retry.m.ok) {
      note({ kind: 'retry', outcome: 'measured over HTTP/1.1' })
      return retry.m
    }
    // The retry failed too, and HOW it failed is worth keeping. On a live site the first attempt
    // gets ERR_HTTP2_PROTOCOL_ERROR and the HTTP/1.1 attempt gets ERR_EMPTY_RESPONSE — two
    // different refusals, which is a materially more interesting fact than one repeated.
    retriedWith = rawCodeOf(retry.err) || (retry.err ? describe(retry.err) : 'no page')
    note({ kind: 'retry', outcome: 'failed', error: retriedWith })
  }

  // Still nothing. Ours, not theirs — and say so with every side showing, because the next step
  // is a human checking this site by hand and this string is what they start from.
  first.m.unreachableReason = 'checker-error'
  first.m.error = [
    `${rawCodeOf(first.err) || describe(first.err)} from Chrome`,
    retriedWith ? `${retriedWith} over HTTP/1.1` : null,
    `a plain request returned ${second.status}`
  ].filter(Boolean).join('; ')
  return first.m
}

/**
 * One go at a site. Returns the Measurement and, when it failed, the error that stopped it — the
 * caller decides what that failure means, because deciding needs a second opinion this function
 * deliberately does not have.
 */
async function attempt (url, opts = {}, { chromeArgs = [] } = {}) {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const deadline = Date.now() + timeoutMs
  const note = opts.onNote || (() => {})
  const m = emptyMeasurement(url)

  let browser = opts.browser || null
  const borrowedBrowser = !!opts.browser
  let timer = null
  let failure = null

  try {
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`gave up after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    })
    const work = (async () => {
      if (!browser) {
        browser = await launch({
          headless: opts.headless ?? true,
          port: opts.port ?? await freePort(),
          width: DESKTOP.width, height: DESKTOP.height,
          args: chromeArgs
        })
      }
      await runPasses(browser, url, m, { ...opts, deadline, note })
    })()
    await Promise.race([work, expiry])
    // A stage that failed softly (a 500, say) has already written its own error.
    if (!m.error) m.ok = true
  } catch (err) {
    // Whatever we did manage to measure stays in `m`. The caller gets a partial picture and an
    // honest reason, which is far more useful downstream than an exception.
    failure = err
    m.ok = false
    m.error = describe(err)
    const cert = certificateCodeOf(err)
    if (cert && !m.https.certificateProblem) {
      m.https.certificateProblem = `${cert}${NETWORK_ERRORS[cert] ? ` — ${NETWORK_ERRORS[cert]}` : ''}`
    }
  } finally {
    clearTimeout(timer)
    if (browser && !borrowedBrowser) { try { await browser.close() } catch { /* it is going away regardless */ } }
  }
  return { m, err: failure }
}


async function runPasses (browser, url, m, opts) {
  const { deadline, note } = opts

  // ---- desktop: timing, weight, https, seo, a11y, freshness ----------------------------------
  const desk = await browser.newPage('about:blank', DESKTOP)
  const net = recordNetwork(desk)
  let sameOriginLinks = []
  let notMeasurable = false
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

      // Reached, but did it let us in? Three outcomes, and the difference between the last two is
      // the most consequential judgement this file makes.
      const signals = await evalFn(desk, refusalSignalsScript).catch(() => ({ title: '', challengeScript: false, challengeMarkup: false, textLength: 0 }))
      const refusal = classifyRefusal(doc.status, doc.headers, signals)
      // What we reached is a Cloudflare waiting room or an error page — not the site. Everything
      // downstream of here would be describing the wrong document: its title, its contrast, its
      // tap targets, a screenshot of somebody else's error page in a document about this business.
      // So we keep the transaction (timing, weight, https, Last-Modified) and record nothing at
      // all about content.
      if (refusal) notMeasurable = true
      if (refusal === 'blocked') {
        // Turned away, not broken. Telling an owner their working site is down is the worst thing
        // this tool can do, so a refusal that looks like bot protection is never reported as down.
        m.unreachableReason = 'blocked'
        m.error = doc.status >= 400
          ? `the site refused an automated visit (HTTP ${doc.status})`
          : 'the site answered with a bot-protection challenge instead of the page'
      } else if (refusal === 'http-error') {
        // A homepage answering 404 or 500 is down as far as its owner's customers are concerned.
        m.unreachableReason = 'http-error'
        m.error = `HTTP ${doc.status} from ${doc.url}`
      }
    }

    await settle(desk, deadline)
    m.timing = await evalFn(desk, timingScript)
    m.weight = normaliseWeight(net.weight(), info.origin)
    if (notMeasurable) return

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
    // Name the offender from whichever reading actually found the overflow.
    m.mobile.overflowCulprit = (afterSweep.px >= settled.px ? afterSweep.culprit : settled.culprit) || null

    const tally = await evalFn(phone, tapTallyScript, { min: 44 })
    m.mobile.tapTargetsUnder44 = tally.under
    m.mobile.smallestTapTargetPx = tally.smallest
    note({ kind: 'tapTargets', candidates: targets, screensSwept: sweep.screens, ...tally })

    if (opts.screenshots !== false && opts.outDir) {
      const info = await evalFn(phone, docInfoScript)
      // Capture at the width the page actually laid out at, not at 390.
      //
      // A page with no viewport meta does not lay out at the device width: Chrome widens the
      // layout viewport to the content and scales the whole thing down to fit the screen. Clipping
      // such a page to 390 crops it to the left third, which is not what anybody sees. What the
      // visitor sees is the entire page shrunk to unreadable — and for a report that is the most
      // persuasive image there is, because the owner recognises it instantly.
      const layoutWidth = Math.max(MOBILE.width, Math.round(info.clientWidth || MOBILE.width))
      const screenfuls = 2
      const maxHeight = Math.round((layoutWidth * MOBILE.height) / MOBILE.width) * screenfuls
      const height = Math.min(info.scrollHeight || maxHeight, maxHeight)
      // Whatever the layout width, the PNG comes out 780 across — a phone at 2x — so the report
      // gets a consistent image and the shrinking is visible in it rather than described.
      const scale = (MOBILE.width * 2) / (layoutWidth * MOBILE.dpr)
      const shot = await capture(phone, { outDir: opts.outDir, name: `${stemFor(m.url)}-mobile`, clip: { x: 0, y: 0, width: layoutWidth, height }, scale })
      m.screenshots.mobile = shot.path
      note({ kind: 'screenshot', which: 'mobile', layoutWidthCss: layoutWidth, shrunkToFit: layoutWidth > MOBILE.width, ...shot })
    }
  } finally {
    await phone.close().catch(() => {})
  }

  const { broken, files } = await probes
  m.freshness.brokenLinks = broken.map(b => ({ url: relativise(b.url, origin), status: b.status }))
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
    if (loadFired) return confirmLanded(page, url, { loadFired: true })
    const failed = net && net.documentFailure()
    if (failed) throw new NavigationError(`${failed.error}${failed.blocked ? ` (${failed.blocked})` : ''} (${url})`)
    await sleep(100)
  }

  const state = await page.eval('document.readyState + "|" + (document.body ? document.body.childElementCount : -1)').catch(() => 'unknown|-1')
  const [readyState, children] = state.split('|')
  if (readyState === 'complete' || domFired || Number(children) > 0) return confirmLanded(page, url, { loadFired: false, readyState })
  throw new NavigationError(`no page after ${budget}ms (readyState "${readyState}") (${url})`)
}

/**
 * The load event is not proof. Chrome fires it on its OWN error page, and that page has a title
 * (the hostname), a body, and a perfectly convincing readyState — so a navigation that failed
 * looks exactly like one that worked unless you ask where you actually landed.
 *
 * The desktop pass would have caught this through the network recorder. The mobile pass has no
 * recorder, so until this existed a phone-pass failure would have been measured as the site: no
 * viewport meta, enormous overflow, and a screenshot of a browser error page presented to a
 * business owner as their own home page.
 */
async function confirmLanded (page, url, result) {
  const href = await page.eval('location.href').catch(() => '')
  if (!/^chrome-error:\/\//.test(href)) return result
  const code = await page
    .eval('(document.body ? document.body.innerText : "").match(/ERR_[A-Z0-9_]+/)?.[0] || "UNKNOWN"')
    .catch(() => 'UNKNOWN')
  throw new NavigationError(`net::${code} — the browser landed on its own error page (${url})`)
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

/**
 * The second opinion: `node:http`/`node:https` directly, which speak HTTP/1.1 and nothing else.
 *
 * Not `fetch`. Node 26's fetch negotiates HTTP/2, and against the broken-h2 fixture it failed with
 * the very same protocol error Chrome did — a second opinion that reproduces the first is not a
 * second opinion. The whole value here is a different stack: no h2, no renderer, none of the
 * hundred things a browser needs to agree with a server about before it can show a page.
 *
 * Only a final 2xx counts as reachable. A plain request that gets a 500 has confirmed the site is
 * broken rather than refuted it, and one still being redirected has not arrived anywhere at all.
 */
export async function confirmUnreachable (url, { confirmTimeoutMs = 5000, confirmProbe = plainRequest } = {}) {
  const deadline = Date.now() + confirmTimeoutMs
  for (const method of ['HEAD', 'GET']) {
    const left = deadline - Date.now()
    if (left < 250) break
    const res = await confirmProbe(url, { method, timeoutMs: left })
    if (res.status === null) { if (method === 'GET') return { reachable: false, status: null }; continue }
    // Servers that refuse HEAD but serve the page happily are common enough to be worth asking twice.
    if (method === 'HEAD' && [403, 405, 501].includes(res.status)) continue
    return { reachable: res.status < 400, status: res.status }
  }
  return { reachable: false, status: null }
}

/** One HTTP/1.1 request, following redirects by hand. Status, or null if nothing came back. */
function plainRequest (url, { method = 'HEAD', timeoutMs = 5000, hops = 5 } = {}) {
  return new Promise(resolve => {
    let target
    try { target = new URL(url) } catch { return resolve({ status: null }) }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return resolve({ status: null })

    const send = (target.protocol === 'https:' ? httpsRequest : httpRequest)
    const req = send(target, { method, headers: { 'user-agent': UA, accept: '*/*', connection: 'close' }, timeout: timeoutMs }, res => {
      const status = res.statusCode
      res.resume()   // drain, or the socket is held open
      if (status >= 300 && status < 400) {
        // Still being redirected. Only a final answer counts: a request that ran out of hops in a
        // redirect loop has not reached the site any more than Chrome did, and returning the 3xx
        // as if it were a result would turn the site's own fault into ours.
        if (!res.headers.location || hops <= 0) return resolve({ status: null })
        let next
        try { next = new URL(res.headers.location, target).href } catch { return resolve({ status: null }) }
        return resolve(plainRequest(next, { method, timeoutMs, hops: hops - 1 }))
      }
      resolve({ status })
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: null }) })
    req.on('error', () => resolve({ status: null }))
    req.end()
  })
}

function rawCodeOf (err) {
  const m = String(err?.message || err).match(/net::ERR_[A-Z0-9_]+/)
  return m ? m[0] : null
}

/**
 * Bot protection, or a broken site? The rule when it is genuinely unclear is to pick the answer
 * that does not accuse: a site wrongly called "blocked" costs us one manual check, a working site
 * wrongly called "down" costs us the room.
 *
 * A challenge title alone is never enough — a real page may well be called "Access denied" — so a
 * 2xx is only treated as a refusal when there is an actual challenge mechanism in the page.
 */
export function classifyRefusal (status, headers = {}, signals = {}) {
  const behindCloudflare = !!(headers['cf-ray'] || headers['cf-mitigated'] || /cloudflare/i.test(headers.server || ''))
  const guarded = !!(signals.challengeScript || signals.challengeMarkup)
  const challengeTitle = CHALLENGE_TITLE.test(signals.title || '')

  if (status === 403 || status === 429) return 'blocked'
  if (status === 503 && (behindCloudflare || guarded || challengeTitle)) return 'blocked'
  // A 200 that is really a waiting room: a challenge mechanism, a challenge title, and almost no
  // page behind it. All three, or we let it through as a real page.
  if (status < 400 && guarded && challengeTitle && signals.textLength < 2000) return 'blocked'
  if (status >= 400) return 'http-error'
  return null
}

const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify (you are|yourself)|are you (a )?human|security check|ddos protection|access denied|forbidden|blocked/i

/** Which of the contract's five reasons a navigation failure was. */
export function classifyFailure (err) {
  if (err instanceof TimeoutError) return 'timeout'
  const raw = err?.message || String(err)
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS/.test(raw)) return 'dns'
  if (/ERR_CERT|ERR_SSL/.test(raw)) return 'tls'
  if (/ERR_BLOCKED_BY|ERR_ACCESS_DENIED/.test(raw)) return 'blocked'
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|no page after/.test(raw)) return 'timeout'
  // Refused, reset, empty, unreachable: the server was there to say no, or hung up mid-sentence.
  // Not a timeout — telling an owner their site "timed out" about a refused connection describes
  // something that did not happen.
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_FAILED/.test(raw)) return 'refused'
  return 'timeout'
}

function certificateCodeOf (err) {
  const m = String(err?.message || err).match(/net::ERR_(?:CERT|SSL)[A-Z_]*/)
  return m ? m[0] : null
}

function describe (err) {
  if (err instanceof TimeoutError) return err.message
  const raw = err?.message || String(err)
  for (const [code, sentence] of Object.entries(NETWORK_ERRORS)) if (raw.includes(code)) return `${sentence} (${code})`
  return raw
}

/**
 * net::ERR_NAME_NOT_RESOLVED and friends read like a stack trace to anyone downstream, and this
 * string ends up in a sentence a business owner reads about their own site. Anything not in here
 * is passed through untranslated rather than explained away with a guess.
 */
export const NETWORK_ERRORS = {
  'net::ERR_NAME_NOT_RESOLVED': 'that domain does not resolve — the site is gone or the name has lapsed',
  'net::ERR_CONNECTION_REFUSED': 'the server refused the connection',
  'net::ERR_CONNECTION_TIMED_OUT': 'the server never answered',
  'net::ERR_CONNECTION_RESET': 'the server dropped the connection',
  'net::ERR_TOO_MANY_REDIRECTS': 'the site redirects to itself in a loop and never arrives',
  'net::ERR_CERT_COMMON_NAME_INVALID': 'the security certificate does not match this domain',
  'net::ERR_CERT_DATE_INVALID': 'the security certificate has expired',
  'net::ERR_CERT_AUTHORITY_INVALID': 'the security certificate is not one browsers trust, so visitors see a full-page warning',
  'net::ERR_CERT_REVOKED': 'the security certificate has been revoked',
  'net::ERR_CERT_INVALID': 'the security certificate is not valid',
  'net::ERR_SSL_PROTOCOL_ERROR': 'the secure connection could not be established',
  'net::ERR_EMPTY_RESPONSE': 'the server answered with nothing at all',
  'net::ERR_ADDRESS_UNREACHABLE': 'the server could not be reached'
}

export { measureHorizontalOverflow, navigate, confirmLanded, describe, certificateCodeOf, rawCodeOf }
export default collect
