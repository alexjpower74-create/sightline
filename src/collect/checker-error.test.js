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
const { collect, confirmUnreachable } = await import('./index.js')
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

  // RED IF: a browser-side transport failure is written up as the owner's website being down.
  // This is the check that would have caught the a live site report before it went out.
  await t.check('a site Chrome cannot reach but a plain request can is OUR error, not theirs', {
    assert: async () => {
      const m = await measure(broken.origin + '/')
      return m.ok === false && m.unreachableReason === 'checker-error' &&
        m.error.includes('net::ERR_HTTP2_PROTOCOL_ERROR') && m.error.includes('a plain request returned 200')
    },
    // The control makes the site genuinely unreachable — HTTP/1.1 stops working too. Now both
    // opinions agree it is down, and calling it checker-error would be the wrong answer.
    breaks: flipHttp1(false)
  })

  // RED IF: the two opinions are not actually independent. Node 26's fetch negotiates HTTP/2 and
  // failed against this same fixture with the identical protocol error — a second opinion that
  // reproduces the first is not a second opinion at all.
  await t.check('the second opinion speaks HTTP/1.1, so it does not reproduce the first', {
    assert: async () => {
      const viaPlain = await confirmUnreachable(broken.origin + '/')
      const viaFetch = await fetch(broken.origin + '/').then(r => r.status).catch(() => null)
      return viaPlain.reachable === true && viaPlain.status === 200 && viaFetch === null
    },
    breaks: flipHttp1(false)
  })

  // RED IF: the confirming request is so eager that a genuinely broken site is excused. A plain
  // request that gets a 500 has confirmed the site is broken, not refuted it.
  await t.check('a plain request that gets an error does not excuse the site', {
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
  await t.check('a redirect loop has not reached the site, however many hops we follow', {
    assert: async () => {
      const r = await confirmUnreachable(good.url('/loop'))
      return r.reachable === false && r.status === null
    },
    breaks: () => { const was = good.cfg.loopHops; good.cfg.loopHops = 1; return () => { good.cfg.loopHops = was } }
  })

  // RED IF: a site that is really gone gets the gentle treatment. Confirming with a second request
  // must not turn every failure into somebody else's problem — the dead case has to stay dead.
  //
  // The first version of this asserted `unreachableReason !== 'checker-error'`, which a working
  // site satisfies just as well as a dead one, so no control could ever turn it red. It now names
  // the reason it expects.
  await t.check('a server that is truly gone is still reported as unreachable', {
    assert: async () => {
      const m = await collect(deadOrigin + '/', { browser, screenshots: false, checkLinks: false, timeoutMs: 15_000 })
      return m.ok === false && m.unreachableReason === 'timeout' && !/plain request returned/.test(m.error)
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
