// A local site to point the collector at.
//
// Every test in this slice runs against this server and never against the live internet. A test
// that depends on someone else's website is not a test: it fails when their CDN hiccups, passes
// when their page changes underneath you, and tells you nothing either way.
//
// It also plays the parts of a site that has gone wrong — a redirect loop, a 500, a page whose
// load event never fires, a 40MB monster — because those are the cases the collector has to
// survive and they cannot be written as static files.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'fixtures')

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' }

// A real 1x1 PNG, so Network.* sees an actual image transfer rather than a 404.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

export async function startServer (options = {}) {
  const { port = 0 } = options
  // Every failure mode lives in this object rather than in a closure, so a test can flip one at
  // runtime. That is what lets a negative control break the site under test for real instead of
  // pointing the collector at a different address and calling it a control.
  const cfg = {
    robots: true, sitemap: true, softFiles: false,
    boomStatus: 500, loopHops: Infinity, hangCloses: false, hugeChunks: 44_000,
    blockedMode: 'blocked',      // 'blocked' | 'plain404'
    goneStatus: 404,
    challengeMode: 'challenge',  // 'challenge' | 'real'
    ...options
  }
  const hanging = new Set()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`)
    const p = url.pathname

    // --- the ways a site goes wrong ---------------------------------------------------------
    if (p === '/boom') {
      res.writeHead(cfg.boomStatus, { 'content-type': 'text/html' })
      return res.end(cfg.boomStatus >= 400 ? '<h1>Internal Server Error</h1>' : '<!doctype html><html lang="en"><head><title>Recovered</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Back up</h1></main></body></html>')
    }
    if (p === '/gone') { res.writeHead(cfg.goneStatus, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>') }

    // Bot protection turning an automated visitor away. Not a broken site, and the collector must
    // never report it as one.
    if (p === '/blocked') {
      if (cfg.blockedMode === 'plain404') {
        res.writeHead(404, { 'content-type': 'text/html' })
        return res.end('<!doctype html><html lang="en"><head><title>Page not found</title></head><body><h1>Not found</h1></body></html>')
      }
      res.writeHead(403, { 'content-type': 'text/html', 'cf-ray': '8a1f2c3d4e5f6789-YYZ', server: 'cloudflare' })
      return res.end('<!doctype html><html lang="en"><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-wrapper">Sorry, you have been blocked.</div></body></html>')
    }
    // The harder one: a 200 that is really a waiting room.
    if (p === '/challenge') {
      if (cfg.challengeMode === 'real') {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end('<!doctype html><html lang="en"><head><title>Access Denied — our policy page</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Access Denied</h1><p>' + 'This page explains our access policy in some detail. '.repeat(80) + '</p></main></body></html>')
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cf-ray': '8a1f2c3d4e5f6789-YYZ' })
      return res.end('<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body><div id="challenge-form">Checking your browser</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>')
    }
    if (p.startsWith('/cdn-cgi/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('/* challenge */') }
    if (p.startsWith('/loop')) {
      const n = Number(url.searchParams.get('n') || 0)
      if (n >= cfg.loopHops) { res.writeHead(302, { location: '/good.html' }); return res.end() }
      res.writeHead(302, { location: `/loop?n=${n + 1}` })
      return res.end()
    }
    if (p === '/hang') {
      // Headers and body go out, so the page renders; the socket simply never closes, so the
      // load event never fires. This is the analytics tag that hangs on half the web.
      const body = '<!doctype html><html lang="en"><head><title>Still loading</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>This page never finishes</h1><p>The socket stays open forever.</p></main>'
      res.writeHead(200, { 'content-type': 'text/html' })
      if (cfg.hangCloses) return res.end(body + '</body></html>')
      hanging.add(res)
      return res.write(body)
    }
    if (p === '/slow-asset') { hanging.add(res); res.writeHead(200, { 'content-type': 'image/png' }); return res.write(PIXEL.slice(0, 4)) }
    if (p === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<!doctype html><html lang="en"><head><title>40MB</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Heavy</h1>')
      // ~40MB of real DOM, streamed so the server does not hold it all either.
      const chunk = '<p>' + 'x'.repeat(900) + '</p>'
      for (let i = 0; i < cfg.hugeChunks; i++) { if (!res.write(chunk)) await new Promise(r => res.once('drain', r)) }
      return res.end('</main></body></html>')
    }
    if (p === '/big.png') {
      // A single 2MB image, so weight.largestImage has something unambiguous to find.
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(2_000_000) })
      return res.end(Buffer.concat([PIXEL, Buffer.alloc(2_000_000 - PIXEL.length, 0)]))
    }
    if (p === '/pixel.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PIXEL) }
    if (p === '/heavy.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('/*' + 'j'.repeat(300_000) + '*/\nwindow.__heavy = true') }

    // --- site files ---------------------------------------------------------------------------
    // The common false positive: a site that answers 200 with its homepage for any unknown path,
    // which credits it with a robots.txt and a sitemap it does not have.
    if (cfg.softFiles && (p === '/robots.txt' || p === '/sitemap.xml')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1></body></html>')
    }
    if (p === '/robots.txt') {
      if (!cfg.robots) { res.writeHead(404); return res.end('nope') }
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(`User-agent: *\nDisallow: /admin\n${cfg.sitemap ? `Sitemap: http://${req.headers.host}/sitemap.xml\n` : ''}`)
    }
    if (p === '/sitemap.xml') {
      if (!cfg.sitemap) { res.writeHead(404); return res.end('nope') }
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url></urlset>')
    }
    // --- static fixtures ------------------------------------------------------------------------
    const name = p === '/' ? '/good.html' : p
    try {
      const body = await readFile(join(FIXTURES, name.replace(/^\/+/, '')))
      res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream', 'last-modified': 'Tue, 19 Aug 2014 00:00:00 GMT' })
      return res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end('<h1>Not found</h1>')
    }
  })

  await new Promise(r => server.listen(port, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    cfg,
    url: path => origin + path,
    async close () {
      for (const res of hanging) { try { res.destroy() } catch { /* already gone */ } }
      hanging.clear()
      server.closeAllConnections?.()
      await new Promise(r => server.close(r))
    }
  }
}
