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

export async function startServer ({ port = 0, robots = true, sitemap = true } = {}) {
  const hanging = new Set()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`)
    const p = url.pathname

    // --- the ways a site goes wrong ---------------------------------------------------------
    if (p === '/boom') { res.writeHead(500, { 'content-type': 'text/html' }); return res.end('<h1>Internal Server Error</h1>') }
    if (p === '/gone') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>') }
    if (p.startsWith('/loop')) {
      const n = Number(url.searchParams.get('n') || 0)
      res.writeHead(302, { location: `/loop?n=${n + 1}` })
      return res.end()
    }
    if (p === '/hang') {
      // Headers and body go out, so the page renders; the socket simply never closes, so the
      // load event never fires. This is the analytics tag that hangs on half the web.
      hanging.add(res)
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.write('<!doctype html><html lang="en"><head><title>Still loading</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>This page never finishes</h1><p>The socket stays open forever.</p></main>')
    }
    if (p === '/slow-asset') { hanging.add(res); res.writeHead(200, { 'content-type': 'image/png' }); return res.write(PIXEL.slice(0, 4)) }
    if (p === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<!doctype html><html lang="en"><head><title>40MB</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Heavy</h1>')
      // ~40MB of real DOM, streamed so the server does not hold it all either.
      const chunk = '<p>' + 'x'.repeat(900) + '</p>'
      for (let i = 0; i < 44_000; i++) { if (!res.write(chunk)) await new Promise(r => res.once('drain', r)) }
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
    if (p === '/robots.txt') {
      if (!robots) { res.writeHead(404); return res.end('nope') }
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(`User-agent: *\nDisallow: /admin\n${sitemap ? `Sitemap: http://${req.headers.host}/sitemap.xml\n` : ''}`)
    }
    if (p === '/sitemap.xml') {
      if (!sitemap) { res.writeHead(404); return res.end('nope') }
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url></urlset>')
    }
    // The common false positive: a site that answers 200 with its homepage for any unknown path.
    if (p === '/soft404/robots.txt' || p === '/soft404/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><html><body><h1>Home</h1></body></html>')
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
    url: path => origin + path,
    async close () {
      for (const res of hanging) { try { res.destroy() } catch { /* already gone */ } }
      hanging.clear()
      server.closeAllConnections?.()
      await new Promise(r => server.close(r))
    }
  }
}
