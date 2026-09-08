// Every site has to come back as a Measurement.
//
// A collector that throws on a dead domain takes the whole call list down with it, and the sites
// most worth phoning are exactly the ones most likely to be broken. So: a dead server, a redirect
// loop, a 500, a page whose load event never fires, 40MB of DOM, and a run that outlasts its own
// budget — six ways to fail, six Measurements, no exceptions.
//
// Each control flips a failure mode on the running server rather than pointing the collector
// somewhere else, so the thing under test is the thing that changes.

import { suite } from '@alexpower/rig/harness/check.js'
import { launch } from '@alexpower/rig/harness/cdp.js'
import { startServer } from './server.js'
import { startTlsServer } from './tls.js'
import { collect, describe as describeError, NETWORK_ERRORS, classifyRefusal } from './index.js'
import { assertMeasurement } from '../contract.js'
import { freePort } from './free-port.js'

const server = await startServer()
const browser = await launch({ headless: true, port: await freePort() })

const runs = new Map()
function measure (path, opts = {}) {
  const key = path + JSON.stringify(opts)
  if (!runs.has(key)) runs.set(key, collect(server.url(path), { browser, screenshots: false, ...opts }))
  return runs.get(key)
}
const flip = (key, broken) => () => {
  const was = server.cfg[key]
  server.cfg[key] = broken
  runs.clear()
  return () => { server.cfg[key] = was; runs.clear() }
}

/** Every one of these must be a Measurement, whatever else is true of it. */
const wellFormed = m => {
  assertMeasurement(m)
  return typeof m.error === 'string' || m.error === null
}

await suite('resilience', async t => {

  // ---- the site is simply gone -----------------------------------------------------------------
  //
  // A server that was there and is not any more: we take a port, shut it down, and knock.
  // Nothing leaves this machine, so the check cannot be broken by somebody else's DNS.
  const dead = await startServer()
  const deadOrigin = dead.origin
  await dead.close()

  // RED IF: an unreachable site throws, or comes back claiming to be ok.
  await t.check('a dead server comes back as a Measurement, not an exception', {
    assert: async () => {
      const m = await collect(deadOrigin + '/', { browser, screenshots: false, timeoutMs: 15_000 })
      return wellFormed(m) && m.ok === false && /refused|reached|answered/.test(m.error)
    },
    breaks: async () => {
      // Put a working site back on that exact address. If the check still passes, it is not
      // watching reachability at all.
      const revived = await startServer({ port: Number(new URL(deadOrigin).port) })
      return () => revived.close()
    }
  })

  // RED IF: a redirect loop hangs, throws, or is reported as a working site.
  await t.check('a redirect loop is reported in words an owner could read', {
    assert: async () => {
      const m = await measure('/loop')
      return wellFormed(m) && m.ok === false && /loop/.test(m.error)
    },
    breaks: flip('loopHops', 1)      // one hop, then a real page
  })

  // RED IF: a homepage answering 500 is scored as a working site. It is down as far as its
  // owner's customers are concerned, and the report has a path for that.
  await t.check('a 500 is reached but not ok, and says so', {
    assert: async () => {
      const m = await measure('/boom')
      return wellFormed(m) && m.ok === false && m.error.includes('HTTP 500')
    },
    breaks: flip('boomStatus', 200)
  })

  // RED IF: a page whose load event never fires is treated as unreachable. Half the small-business
  // web has one request hanging behind an analytics tag; the page is perfectly visible, and
  // loadMs staying at 0 is itself the finding.
  await t.check('a page that never finishes loading is still measured', {
    assert: async () => {
      const m = await measure('/hang', { navTimeoutMs: 3000, timeoutMs: 30_000 })
      return wellFormed(m) && m.ok === true && m.timing.loadMs === 0 &&
        m.timing.domContentLoadedMs === 0 && m.seo.title === 'Still loading' && m.mobile.hasViewportMeta
    },
    breaks: flip('hangCloses', true)   // let the socket close, and the load event fires
  })

  // RED IF: a very large page exhausts the budget or the heap. 40MB of real DOM.
  await t.check('40MB of DOM comes back inside the budget', {
    assert: async () => {
      const started = Date.now()
      const m = await measure('/huge', { timeoutMs: 45_000 })
      return wellFormed(m) && m.weight.totalBytes > 30_000_000 && Date.now() - started < 45_000
    },
    breaks: flip('hugeChunks', 10)
  })

  // RED IF: the per-site cap is advisory. A run that outlasts it has to come back anyway, with
  // whatever it managed to measure and an honest reason.
  await t.check('a run that outlasts its budget returns rather than hanging', {
    assert: async () => {
      const started = Date.now()
      const m = await collect(server.url('/huge'), { browser, screenshots: false, timeoutMs: 2500 })
      const elapsed = Date.now() - started
      // The budget covers the measurement; confirming with a plain request is allowed a further
      // 5s on top, because never calling a live site dead is worth one more request.
      return wellFormed(m) && m.ok === false && /gave up after 2500ms/.test(m.error) && elapsed < 10_000
    },
    breaks: flip('hugeChunks', 5)     // small enough to finish well inside 2.5s
  })

  // ---- turned away is not the same as down -------------------------------------------------
  //
  // Telling a business owner their working site is down is the single worst thing this tool can
  // do. Worse than missing a finding, worse than a wrong score. These three checks are the guard.

  // RED IF: bot protection is reported as a broken site.
  await t.check('bot protection is a refusal, not a site being down', {
    assert: async () => {
      const m = await measure('/blocked')
      return wellFormed(m) && m.ok === false && m.unreachableReason === 'blocked' &&
        /refused/.test(m.error) && m.seo.title === null
    },
    breaks: flip('blockedMode', 'plain404')
  })

  // RED IF: a challenge page that answers 200 is measured as if it were the site. The owner would
  // be shown a score for a Cloudflare waiting room.
  await t.check('a 200 that is really a waiting room is a refusal, not a page', {
    assert: async () => {
      const m = await measure('/challenge')
      // Nothing about the waiting room may be recorded as if it described the business.
      return wellFormed(m) && m.ok === false && m.unreachableReason === 'blocked' &&
        m.seo.title === null && m.mobile.hasViewportMeta === false && m.a11y.imagesTotal === 0
    },
    breaks: flip('challengeMode', 'real')
  })

  // RED IF: the refusal test is so eager that a genuinely broken page is excused. A 404 is an
  // http error and has to keep saying so — including on a page whose title is "Access Denied".
  await t.check('a genuine 404 is an http error, not a refusal', {
    assert: async () => {
      const m = await measure('/gone')
      const realPage = classifyRefusal(200, {}, { title: 'Access Denied', textLength: 6000 })
      return wellFormed(m) && m.unreachableReason === 'http-error' && realPage === null
    },
    breaks: flip('goneStatus', 403)
  })

  // RED IF: a certificate Chrome will not accept is measured as if it were the site. Headless
  // fails the navigation outright rather than showing an interstitial, which is what we want — a
  // screenshot of a browser warning page is not a screenshot of anybody's website.
  await t.check('an untrusted certificate is reported as a certificate problem', {
    assert: async () => {
      let serveTls = true
      const tls = await startTlsServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><html lang="en"><head><title>Behind a bad cert</title></head><body><h1>Hello</h1></body></html>')
      })
      try {
        const m = await collect(tls.origin + '/', { browser, screenshots: false, checkLinks: false, timeoutMs: 20_000 })
        return wellFormed(m) && m.ok === false && m.https.enabled === false &&
          /certificate/.test(m.error) && m.error.includes('net::ERR_CERT') && m.seo.title === null &&
          m.unreachableReason === 'tls' && /^net::ERR_CERT/.test(m.https.certificateProblem || '')
      } finally { await tls.close() }
    },
    // Take the sentence out of the table the collector reads, so a real certificate failure comes
    // back as raw Chrome-speak instead. This check exists because ERR_CERT_AUTHORITY_INVALID was
    // missing from that table until a live probe against a self-signed cert turned it up.
    breaks: () => {
      const was = { ...NETWORK_ERRORS }
      for (const k of Object.keys(NETWORK_ERRORS)) if (k.includes('CERT')) delete NETWORK_ERRORS[k]
      return () => { Object.assign(NETWORK_ERRORS, was) }
    }
  })

  // RED IF: net:: codes reach the report, or a code we have no sentence for gets explained away
  // with a guess. This string is read by a business owner about their own site.
  await t.check('network failures are translated out of Chrome-speak', {
    assert: () => {
      const known = describeError(new Error('net::ERR_NAME_NOT_RESOLVED (http://x.test/)'))
      const unknown = describeError(new Error('net::ERR_MADE_UP_CODE'))
      return /does not resolve/.test(known) && /ERR_NAME_NOT_RESOLVED/.test(known) && unknown === 'net::ERR_MADE_UP_CODE'
    },
    // Take the sentence out of the table the function reads. The first version of this control
    // tested a different input and restored nothing, so it broke nothing and the harness said so.
    breaks: () => {
      const was = NETWORK_ERRORS['net::ERR_NAME_NOT_RESOLVED']
      delete NETWORK_ERRORS['net::ERR_NAME_NOT_RESOLVED']
      return () => { NETWORK_ERRORS['net::ERR_NAME_NOT_RESOLVED'] = was }
    }
  })
})

await browser.close()
await server.close()
process.exit(process.exitCode || 0)
