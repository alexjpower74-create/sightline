// The three things that only exist over TLS: the padlock, the http-to-https redirect, and mixed
// content. All three are trust findings, and trust is contract-relevant for the public-sector
// adjacent clients this gets used on — so none of them ships on the strength of reading the code.
//
// Chrome will not touch a certificate it does not trust. RIG_CHROME is the harness's own hook for
// the browser binary, so this file points it at a wrapper that adds --ignore-certificate-errors
// before anything imports the harness. collect() itself never sees that flag.

import { createServer } from 'node:http'
import { chromeWrapperPath, startTlsServer } from './tls.js'
import { freePort } from './free-port.js'

process.env.RIG_CHROME = chromeWrapperPath()

// Imported dynamically: cdp.js reads RIG_CHROME once, when it is first loaded.
const { suite } = await import('@alexpower/rig/harness/check.js')
const { launch } = await import('@alexpower/rig/harness/cdp.js')
const { collect } = await import('./index.js')

const PAGE = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ridge Marine</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Ridge Marine</h1>${body}</main></body></html>`

// What the https site serves is a variable, so a control can change the site rather than the URL.
let secureBody = null   // set once plainOrigin is known: an http image on an https page
let redirectTo = null
const tls = await startTlsServer((req, res) => {
  if (redirectTo) { res.writeHead(302, { location: redirectTo }); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(PAGE(secureBody))
})

// A plain-http origin, for the redirect-to-https case and as a source of insecure subresources.
let plainRedirects = true
const plain = createServer((req, res) => {
  if (req.url === '/logo.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  }
  if (plainRedirects) { res.writeHead(301, { location: tls.origin + '/' }); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(PAGE('<p>Served over plain http, no redirect.</p>'))
})
await new Promise(r => plain.listen(0, '127.0.0.1', r))
const plainOrigin = `http://127.0.0.1:${plain.address().port}`
secureBody = `<img src="${plainOrigin}/logo.png" alt="A boat">`

const browser = await launch({ headless: true, port: await freePort() })
const run = url => collect(url, { browser, screenshots: false, checkLinks: false, timeoutMs: 25_000 })

await suite('https and mixed content', async t => {
  // Every check below drives two full measurements — the real page and the broken one — so the
  // harness's 10s default is a thin margin. One full run flaked on it at exactly 10002ms while the
  // same check took 3.9s standalone: machine load, not a defect, but a suite that goes red under
  // load is a suite people learn to re-run instead of read. Nothing here should legitimately take
  // 30 seconds.
  const check = (name, opts) => t.check(name, { timeout: 30_000, ...opts })


  // RED IF: the padlock is reported from the URL that was asked for rather than the one that
  // answered. A site that redirects away to plain http is not an https site.
  await check('an https page is recorded as https', {
    assert: async () => {
      const m = await run(tls.origin + '/')
      return m.ok === true && m.https.enabled === true && m.seo.title === 'Ridge Marine'
    },
    breaks: () => { redirectTo = plainOrigin + '/'; plainRedirects = false; return () => { redirectTo = null; plainRedirects = true } }
  })

  // RED IF: an http address that lands on https is not credited with the redirect. This is the
  // difference between "you have no certificate" and "you have one, it is wired up correctly".
  await check('an http address that redirects to https is credited with it', {
    assert: async () => {
      const m = await run(plainOrigin + '/')
      return m.ok === true && m.https.enabled === true && m.https.redirectsToHttps === true &&
        m.finalUrl.startsWith(tls.origin)
    },
    breaks: () => { plainRedirects = false; return () => { plainRedirects = true } }
  })

  // RED IF: an http subresource on an https page goes unnoticed. This is the one that takes the
  // padlock off a page the owner believes is secure.
  await check('finds an http image loaded into an https page', {
    assert: async () => {
      const m = await run(tls.origin + '/')
      return m.https.enabled === true && m.https.mixedContent.some(u => u.includes('/logo.png'))
    },
    breaks: () => {
      const was = secureBody
      secureBody = '<img src="/logo.png" alt="A boat">'   // same-origin, https: nothing insecure
      return () => { secureBody = was }
    }
  })
})

await browser.close()
await tls.close()
await new Promise(r => plain.close(r))
process.exit(process.exitCode || 0)
