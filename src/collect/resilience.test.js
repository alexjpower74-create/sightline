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
import { collect, describe as describeError, NETWORK_ERRORS } from './index.js'
import { assertMeasurement } from '../contract.js'

const server = await startServer()
const browser = await launch({ headless: true, port: 9381 })

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
      return wellFormed(m) && m.ok === false && /gave up after 2500ms/.test(m.error) && elapsed < 6000
    },
    breaks: flip('hugeChunks', 5)     // small enough to finish well inside 2.5s
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
