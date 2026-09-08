// Never declare a site down on one tool's word.
//
// This file exists because we did exactly that to a real business. Chrome could not negotiate
// HTTP/2 with a live site, returned ERR_HTTP2_PROTOCOL_ERROR, and the report went out telling
// the owner that "anyone who looks you up right now sees an error page instead of your business".
// curl got a 200 in 1.3 seconds. The site was fine.
//
// The fixture is that failure in miniature: a server that negotiates h2 and then talks nonsense,
// while serving perfectly good HTTP/1.1 to anything that asks for it.
//
// Two env settings, both scoped to this process and neither reaching collect(): RIG_CHROME points
// Chrome at a wrapper that tolerates the locally generated certificate, and TLS verification is
// relaxed so the second-opinion request can reach the same fixture. Production code sets neither.

import { chromeWrapperPath, startBrokenHttp2Server } from './tls.js'
import { freePort } from './free-port.js'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
process.env.RIG_CHROME = chromeWrapperPath()

const { suite } = await import('@alexpower/rig/harness/check.js')
const { launch } = await import('@alexpower/rig/harness/cdp.js')
const { collect, confirmUnreachable, confirmLanded } = await import('./index.js')
const { startServer } = await import('./server.js')

const broken = await startBrokenHttp2Server()
const good = await startServer()
const browser = await launch({ headless: true, port: await freePort() })

// An address that had a server and does not any more.
const dead = await startServer()
const deadOrigin = dead.origin
const deadPort = Number(new URL(deadOrigin).port)
await dead.close()

const runs = new Map()
function measure (url) {
  if (!runs.has(url)) runs.set(url, collect(url, { browser, screenshots: false, checkLinks: false, timeoutMs: 25_000 }))
  return runs.get(url)
}
const flipHttp1 = works => () => { broken.cfg.http1Works = works; runs.clear(); return () => { broken.cfg.http1Works = !works; runs.clear() } }

await suite('our failure is not their fault', async t => {
  // Every check below drives two full measurements — the real page and the broken one — so the
  // harness's 10s default is a thin margin. One full run flaked on it at exactly 10002ms while the
  // same check took 3.9s standalone: machine load, not a defect, but a suite that goes red under
  // load is a suite people learn to re-run instead of read. Nothing here should legitimately take
  // 30 seconds.
  const check = (name, opts) => t.check(name, { timeout: 30_000, ...opts })


  // RED IF: a site whose server speaks broken HTTP/2 is written off instead of measured. This is
  // the a live site site: Chrome cannot negotiate h2, a plain request gets a 200, and the answer
  // is neither "you are down" nor a shrug — it is a real audit taken over HTTP/1.1.
  await check('a server with broken HTTP/2 is measured over HTTP/1.1, not written off', {
    assert: async () => {
      const m = await measure(broken.origin + '/')
      return m.ok === true && m.unreachableReason === null &&
        m.seo.title === "Young's Refrigeration" && m.seo.h1Count === 1 && m.mobile.hasViewportMeta === true
    },
    // The control makes the site genuinely unreachable — HTTP/1.1 stops working too, so the retry
    // has nothing to fall back to and there is no measurement to be had.
    breaks: flipHttp1(false)
  })

  // RED IF: a failure the retry cannot rescue is still blamed on the owner. This server hangs up
  // on anything asking for HTML and answers a plain request perfectly well, so neither HTTP/2 nor
  // HTTP/1.1 gets Chrome a page — and the honest answer is that our checker failed.
  await check('a browser failure a retry cannot fix is OUR error, not theirs', {
    assert: async () => {
      const m = await measure(good.url('/hostile'))
      // Both refusals have to survive into the error. A human checking this site by hand starts
      // from this string, and "it failed the same way twice" and "it failed two different ways"
      // are different facts.
      return m.ok === false && m.unreachableReason === 'checker-error' &&
        /a plain request returned 200/.test(m.error) && /^net::ERR_/.test(m.error) &&
        /over HTTP\/1\.1/.test(m.error) && m.error.split('; ').length === 3
    },
    breaks: () => { good.cfg.hostileToBrowsers = false; runs.clear(); return () => { good.cfg.hostileToBrowsers = true; runs.clear() } }
  })

  // RED IF: the two opinions are not actually independent. Node 26's fetch negotiates HTTP/2 and
  // failed against this same fixture with the identical protocol error — a second opinion that
  // reproduces the first is not a second opinion at all.
  await check('the second opinion speaks HTTP/1.1, so it does not reproduce the first', {
    assert: async () => {
      const viaPlain = await confirmUnreachable(broken.origin + '/')
      const viaFetch = await fetch(broken.origin + '/').then(r => r.status).catch(() => null)
      return viaPlain.reachable === true && viaPlain.status === 200 && viaFetch === null
    },
    breaks: flipHttp1(false)
  })

  // RED IF: the confirming request is so eager that a genuinely broken site is excused. A plain
  // request that gets a 500 has confirmed the site is broken, not refuted it.
  await check('a plain request that gets an error does not excuse the site', {
    assert: async () => {
      const boom = await confirmUnreachable(good.url('/boom'))
      const fine = await confirmUnreachable(good.url('/good.html'))
      return boom.reachable === false && boom.status === 500 && fine.reachable === true
    },
    breaks: () => { const was = good.cfg.boomStatus; good.cfg.boomStatus = 200; return () => { good.cfg.boomStatus = was } }
  })

  // RED IF: the confirming request treats "still being redirected" as an answer. Following five
  // hops of a redirect loop and reporting the last 302 as reachable turns the site's own fault
  // into ours — which is exactly what happened the first time this was wired up, and the redirect
  // loop check in resilience.test.js went red for it.
  await check('a redirect loop has not reached the site, however many hops we follow', {
    assert: async () => {
      const r = await confirmUnreachable(good.url('/loop'))
      return r.reachable === false && r.status === null
    },
    breaks: () => { const was = good.cfg.loopHops; good.cfg.loopHops = 1; return () => { good.cfg.loopHops = was } }
  })

  // RED IF: the landing check does not recognise a browser error page.
  //
  // Tested directly, because the end-to-end path never reaches it: for every failure I could
  // construct locally, Page.navigate reports errorText and the collector throws before the load
  // event is ever considered. I verified that by disabling this guard and watching the end-to-end
  // check below stay green. So the guard is exercised here, against a page genuinely sitting on
  // chrome-error://chromewebdata/, or it is not exercised at all.
  //
  // The other half — that it lets a real page through — is what every other navigation in all
  // five suites depends on. A guard that rejected working sites would take the whole run with it.
  await check('the landing check spots a browser error page and lets a real one through', {
    assert: async () => {
      const onError = await browser.newPage('about:blank', { width: 390, height: 844, dpr: 3, mobile: true })
      await onError.send('Page.navigate', { url: good.url('/empty') })
      await new Promise(r => setTimeout(r, 900))
      const href = await onError.eval('location.href').catch(() => '')
      let rejected = null
      try { await confirmLanded(onError, 'x', { fine: true }) } catch (e) { rejected = e.message }
      await onError.close()

      const onReal = await browser.newPage('about:blank', { width: 390, height: 844, dpr: 3, mobile: true })
      await onReal.send('Page.navigate', { url: good.url('/good.html') })
      await new Promise(r => setTimeout(r, 900))
      let allowed = false
      try { allowed = !!(await confirmLanded(onReal, 'y', { fine: true })) } catch { allowed = false }
      await onReal.close()

      return /^chrome-error:/.test(href) && !!rejected && /ERR_EMPTY_RESPONSE/.test(rejected) && allowed
    },
    // Make /empty serve a real page: there is no longer an error page to spot, and an assertion
    // that cannot tell the difference goes red.
    breaks: () => { good.cfg.emptyServesPage = true; return () => { good.cfg.emptyServesPage = false } }
  })

  // RED IF: a load event is taken as proof the page is the site. Chrome fires it on its OWN error
  // page, and that page has a title (the hostname), a body and a convincing readyState.
  //
  // This server serves the first visit and hangs up on every one after, so the phone pass fails
  // where the desktop pass succeeded. What it pins is the OUTCOME — that a failed second
  // navigation never becomes a measurement — rather than which guard catches it; here it is
  // Page.navigate's errorText, checked before the load event is ever waited on.
  await check('a browser error page is never measured as the site', {
    assert: async () => {
      const m = await collect(good.url('/flaky'), { browser, screenshots: false, checkLinks: false, timeoutMs: 20_000 })
      return m.ok === false && /ERR_/.test(m.error)
    },
    breaks: () => { good.cfg.flakyFailsAfterFirst = false; return () => { good.cfg.flakyFailsAfterFirst = true } }
  })

  // RED IF: a site that is really gone gets the gentle treatment. Confirming with a second request
  // must not turn every failure into somebody else's problem — the dead case has to stay dead.
  //
  // The first version of this asserted `unreachableReason !== 'checker-error'`, which a working
  // site satisfies just as well as a dead one, so no control could ever turn it red. It now names
  // the reason it expects.
  await check('a server that is truly gone is still reported as unreachable', {
    assert: async () => {
      const m = await collect(deadOrigin + '/', { browser, screenshots: false, checkLinks: false, timeoutMs: 15_000 })
      // 'refused' and not 'timeout': the server was there to say no. An owner told their site
      // "timed out" about a refused connection has been told something that did not happen.
      return m.ok === false && m.unreachableReason === 'refused' && !/plain request returned/.test(m.error)
    },
    breaks: async () => {
      // Put a working site back on that exact address. Both opinions now agree it is fine.
      const revived = await startServer({ port: deadPort })
      return () => revived.close()
    }
  })
})

await browser.close()
await broken.close()
await good.close()
process.exit(process.exitCode || 0)
