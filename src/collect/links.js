// Link and site-file probes. These run from Node rather than the page: a same-origin fetch from
// inside the document would be shaped by the page's own CSP and service worker, and we want to
// know what a visitor clicking the link gets, not what the page is allowed to ask for.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36 Sightline/0.1'

/**
 * HEAD each URL; anything that answers 4xx/5xx is broken.
 *
 * A timeout is NOT counted as broken. A slow link is a different (real) problem, and putting a
 * page in front of an owner that says "this link is dead" when it merely took six seconds is the
 * kind of error that loses the room.
 */
export async function checkLinks (urls, { timeoutMs = 5000, concurrency = 6, max = 40, deadline = Infinity } = {}) {
  const list = urls.slice(0, max)
  const broken = []
  let next = 0

  const worker = async () => {
    while (next < list.length) {
      if (Date.now() > deadline) return
      const url = list[next++]
      const status = await probe(url, timeoutMs)
      if (status !== null && status >= 400) broken.push({ url, status })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))

  broken.sort((a, b) => list.indexOf(a.url) - list.indexOf(b.url))
  return broken
}

/** HTTP status, or null when we could not get a verdict we would be willing to defend. */
async function probe (url, timeoutMs) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept: '*/*' } })
      // Plenty of servers refuse HEAD but serve the page happily. Ask again properly before
      // calling a link dead over it.
      if (method === 'HEAD' && (res.status === 405 || res.status === 501 || res.status === 403)) continue
      try { await res.body?.cancel() } catch { /* nothing to drain */ }
      return res.status
    } catch (e) {
      if (isTimeout(e)) return null
      if (method === 'HEAD') continue        // some servers just hang up on HEAD
      return 599                             // connection refused / reset / redirect loop: broken
    }
  }
  return null
}

function isTimeout (e) {
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed? ?out/i.test(e?.message || '')
}

/**
 * robots.txt and sitemap.xml, checked by content and not just by status. A site that answers 200
 * with its homepage for every unknown path — and there are many — would otherwise be credited
 * with both files.
 */
export async function siteFiles (origin, { timeoutMs = 5000 } = {}) {
  const out = { hasRobotsTxt: false, hasSitemap: false, sitemapFromRobots: null }
  if (!/^https?:$/.test(safeProtocol(origin))) return out

  const robots = await getText(new URL('/robots.txt', origin).href, timeoutMs)
  if (robots && robots.ok && !looksLikeHtml(robots)) {
    if (/^\s*(user-agent|sitemap|disallow|allow|crawl-delay)\s*:/im.test(robots.text)) {
      out.hasRobotsTxt = true
      const m = robots.text.match(/^\s*sitemap\s*:\s*(\S+)/im)
      if (m) { out.sitemapFromRobots = m[1]; out.hasSitemap = true }
    }
  }

  if (!out.hasSitemap) {
    for (const path of ['/sitemap.xml', '/sitemap_index.xml']) {
      const sm = await getText(new URL(path, origin).href, timeoutMs)
      if (sm && sm.ok && /<(urlset|sitemapindex)[\s>]/i.test(sm.text)) { out.hasSitemap = true; break }
    }
  }
  return out
}

function safeProtocol (u) { try { return new URL(u).protocol } catch { return '' } }

function looksLikeHtml (r) {
  return /text\/html/i.test(r.contentType) || /^\s*<(!doctype|html)/i.test(r.text)
}

async function getText (url, timeoutMs, maxBytes = 512 * 1024) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA } })
    const buf = await res.arrayBuffer()
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      text: new TextDecoder().decode(buf.slice(0, maxBytes))
    }
  } catch { return null }
}

/** Same-origin URLs read better in a report as paths, which is also how fixtures/*.json holds them. */
export function relativise (url, origin) {
  try {
    const u = new URL(url)
    if (u.origin === origin) return u.pathname + u.search
    return u.href
  } catch { return url }
}
