// Everything that has to run inside the page.
//
// These are written as real functions and shipped across with `Function.prototype.toString`, so
// they lint, highlight and read like code instead of like a string. The one rule: a script may not
// reference anything outside itself. Whatever it needs arrives as the single JSON argument.

/** Run an in-page function with one JSON-serialisable argument. */
export function evalFn (page, fn, arg = {}) {
  return page.eval(`(${fn.toString()})(${JSON.stringify(arg)})`)
}

// ---------------------------------------------------------------------------------------------
// Document basics

export function docInfoScript () {
  const de = document.documentElement
  return {
    href: location.href,
    origin: location.origin,
    readyState: document.readyState,
    lang: (de.getAttribute('lang') || '').trim(),
    title: document.title ? document.title.trim() : '',
    hidden: document.hidden,
    visibility: document.visibilityState,
    scrollHeight: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
    scrollWidth: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  }
}

export function timingScript () {
  const nav = performance.getEntriesByType('navigation')[0]
  if (!nav) return { ttfbMs: 0, domContentLoadedMs: 0, loadMs: 0 }
  const round = n => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0)
  return {
    // responseStart is measured from the start of navigation, redirects included. That is the
    // wait the visitor actually sits through, which is the number the owner cares about.
    ttfbMs: round(nav.responseStart),
    domContentLoadedMs: round(nav.domContentLoadedEventEnd),
    // 0 means the load event never fired. Deliberate: the page has an unfinished request, and a
    // fabricated number here would hide exactly that.
    loadMs: round(nav.loadEventEnd)
  }
}

// ---------------------------------------------------------------------------------------------
// SEO

export function seoScript (opts) {
  const attr = (sel, name) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const v = el.getAttribute(name)
    return v === null ? null : v.trim()
  }
  const title = document.title ? document.title.trim() : null
  const metaDescription = attr('meta[name="description" i]', 'content') || null
  const canonicalEl = document.querySelector('link[rel~="canonical" i][href]')

  const ogTags = []
  for (const m of document.querySelectorAll('meta[property^="og:" i], meta[name^="og:" i]')) {
    const p = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase()
    if (p && !ogTags.includes(p)) ogTags.push(p)
    if (ogTags.length >= 20) break
  }

  const types = []
  const push = t => {
    if (typeof t !== 'string') return
    const s = t.trim().replace(/^https?:\/\/schema\.org\//i, '')
    if (s && !types.includes(s) && types.length < 20) types.push(s)
  }
  const walk = (node, depth) => {
    if (!node || depth > 6) return
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return }
    if (typeof node !== 'object') return
    if (node['@type']) [].concat(node['@type']).forEach(push)
    if (node['@graph']) walk(node['@graph'], depth + 1)
  }
  const scripts = [...document.querySelectorAll('script[type="application/ld+json" i]')].slice(0, 20)
  for (const s of scripts) {
    try { walk(JSON.parse(s.textContent), 0) } catch { /* malformed JSON-LD is common; ignore it */ }
  }
  for (const el of [...document.querySelectorAll('[itemtype]')].slice(0, 40)) {
    push((el.getAttribute('itemtype') || '').split('/').pop())
  }

  return {
    title,
    titleLength: title ? title.length : 0,
    metaDescription,
    metaDescriptionLength: metaDescription ? metaDescription.length : 0,
    h1Count: document.querySelectorAll('h1').length,
    canonical: canonicalEl ? canonicalEl.href : null,
    ogTags,
    structuredDataTypes: types,
    maxNodes: opts.maxNodes || 0
  }
}

// ---------------------------------------------------------------------------------------------
// Accessibility, including the contrast walk

export function a11yScript (opts) {
  const MAX = opts.maxNodes || 4000
  const out = {
    imagesMissingAlt: 0, imagesTotal: 0, inputsMissingLabel: 0, headingOrderBreaks: 0,
    hasMainLandmark: false, hasSkipLink: false, htmlLangSet: false,
    lowContrastNodes: 0,
    // Not part of the contract — carried back for the report's own sanity checks and for us.
    contrastExamined: 0, contrastUnresolved: 0, contrastSamples: []
  }

  out.htmlLangSet = !!(document.documentElement.getAttribute('lang') || '').trim()
  out.hasMainLandmark = !!document.querySelector('main, [role="main" i]')

  // --- images ---------------------------------------------------------------------------------
  const imgs = [...document.querySelectorAll('img')].slice(0, MAX)
  for (const img of imgs) {
    if (img.getAttribute('aria-hidden') === 'true' || (img.getAttribute('role') || '').toLowerCase() === 'presentation' || (img.getAttribute('role') || '').toLowerCase() === 'none') continue
    out.imagesTotal++
    // alt="" is a valid claim that the image is decorative. A MISSING alt is the fault: the
    // screen reader falls back to reading the file name.
    if (!img.hasAttribute('alt')) out.imagesMissingAlt++
  }

  // --- form controls --------------------------------------------------------------------------
  const controls = [...document.querySelectorAll('input, select, textarea')].slice(0, MAX)
  for (const c of controls) {
    const type = (c.getAttribute('type') || '').toLowerCase()
    if (c.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue
    if (c.getAttribute('aria-hidden') === 'true') continue
    const labelled =
      !!(c.getAttribute('aria-label') || '').trim() ||
      !!(c.getAttribute('aria-labelledby') || '').trim() ||
      !!(c.getAttribute('title') || '').trim() ||
      !!c.closest('label') ||
      (!!c.id && !!document.querySelector(`label[for="${CSS.escape(c.id)}"]`))
    if (!labelled) out.inputsMissingLabel++
  }

  // --- heading order --------------------------------------------------------------------------
  let prev = 0
  for (const h of [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].slice(0, MAX)) {
    const level = Number(h.tagName[1])
    if (prev && level > prev + 1) out.headingOrderBreaks++
    prev = level
  }

  // --- skip link ------------------------------------------------------------------------------
  for (const a of [...document.querySelectorAll('a[href^="#"]')].slice(0, 5)) {
    const text = (a.textContent || '').trim()
    if (!/skip|jump/i.test(text)) continue
    const id = a.getAttribute('href').slice(1)
    if (id && document.getElementById(id)) { out.hasSkipLink = true; break }
  }

  // --- contrast -------------------------------------------------------------------------------
  //
  // The whole difficulty is the background. `getComputedStyle(el).backgroundColor` on a span is
  // almost always rgba(0,0,0,0) — the colour a reader sees comes from some ancestor. So we walk
  // up, compositing translucent layers as we go, until we reach something opaque or the canvas.
  //
  // Where we CANNOT know the answer — a background image, a filter, a gradient, a colour space we
  // cannot parse, anything under a partly transparent ancestor — we drop the node instead of
  // guessing. This report gets shown to a business owner. Telling them their site fails a
  // standard when it does not is worse than saying nothing.

  const parseColor = str => {
    if (!str) return null
    const s = str.trim().toLowerCase()
    if (s === 'transparent') return [0, 0, 0, 0]
    const m = s.match(/^rgba?\(([^)]+)\)$/)
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(p => p.length).map(p => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)))
      if (parts.length < 3 || parts.slice(0, 3).some(n => !Number.isFinite(n))) return null
      const a = parts.length > 3 ? parts[3] : 1
      if (!Number.isFinite(a)) return null
      return [parts[0], parts[1], parts[2], a]
    }
    const c = s.match(/^color\(srgb\s+([^)]+)\)$/)
    if (c) {
      const parts = c[1].split(/[\s/]+/).filter(p => p.length).map(parseFloat)
      if (parts.length < 3 || parts.slice(0, 3).some(n => !Number.isFinite(n))) return null
      const a = parts.length > 3 ? parts[3] : 1
      return [parts[0] * 255, parts[1] * 255, parts[2] * 255, a]
    }
    return null   // oklch, lab, display-p3, colour-mix: unresolvable, so the node is dropped
  }

  const over = (fg, bg) => {
    const a = fg[3]
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]
  }

  const lum = c => {
    const ch = v => { const s = Math.min(255, Math.max(0, v)) / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
  }

  const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05) }

  /** Effective background behind `el`, or null when it genuinely cannot be resolved. */
  const backgroundOf = el => {
    const layers = []
    let node = el
    let guard = 0
    while (node && node.nodeType === 1 && guard++ < 60) {
      const cs = getComputedStyle(node)
      if (cs.backgroundImage !== 'none') return null          // a photo or gradient behind the text
      if (cs.filter !== 'none') return null
      if (cs.backdropFilter && cs.backdropFilter !== 'none') return null
      if (parseFloat(cs.opacity) < 1) return null             // group compositing; see the note above
      const c = parseColor(cs.backgroundColor)
      if (!c) return null
      if (c[3] >= 0.999) { layers.push(c); break }
      if (c[3] > 0) layers.push(c)
      node = node.parentElement
      // Past <html> there is the canvas. html and body were both checked above and neither
      // painted anything opaque, so what the reader sees is the browser's white.
      if (!node) layers.push([255, 255, 255, 1])
    }
    if (!layers.length) return null
    if (layers[layers.length - 1][3] < 0.999) layers.push([255, 255, 255, 1])
    let bg = layers[layers.length - 1]
    for (let i = layers.length - 2; i >= 0; i--) bg = over(layers[i], bg)
    return bg
  }

  const isVisibleText = (el, cs) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    if (cs.visibility === 'hidden' || cs.display === 'none') return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false               // sr-only clipped to a pixel
    if (cs.clipPath && cs.clipPath !== 'none') return false
    if (parseFloat(cs.textIndent) < -999) return false          // the old image-replacement trick
    if (cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color) return false
    if ((cs.webkitBackgroundClip || cs.backgroundClip) === 'text') return false
    return true
  }

  const all = document.body ? document.body.getElementsByTagName('*') : []
  const limit = Math.min(all.length, MAX)
  for (let i = 0; i < limit; i++) {
    const el = all[i]
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE'].includes(el.tagName)) continue
    // Only elements that paint text themselves. Otherwise every wrapper counts its children again.
    let ownText = ''
    for (const n of el.childNodes) if (n.nodeType === 3) ownText += n.nodeValue
    if (!ownText.trim()) continue

    const cs = getComputedStyle(el)
    if (!isVisibleText(el, cs)) continue
    out.contrastExamined++

    const fg = parseColor(cs.color)
    const bg = backgroundOf(el)
    if (!fg || !bg) { out.contrastUnresolved++; continue }
    const text = fg[3] >= 0.999 ? fg : over(fg, bg)

    const size = parseFloat(cs.fontSize) || 16
    const weight = parseInt(cs.fontWeight, 10) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const need = large ? 3 : 4.5
    const r = ratio(text, bg)
    if (r + 0.005 < need) {
      out.lowContrastNodes++
      if (out.contrastSamples.length < 10) {
        out.contrastSamples.push({
          tag: el.tagName.toLowerCase(),
          text: ownText.trim().slice(0, 60),
          color: cs.color, background: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`,
          ratio: Math.round(r * 100) / 100, need, fontSizePx: size
        })
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------------------------
// Mobile: overflow and tap targets

export function overflowGeometryScript () {
  const de = document.documentElement
  const body = document.body
  const csDe = getComputedStyle(de)
  const csBody = body ? getComputedStyle(body) : null
  const hidden = v => v === 'hidden' || v === 'clip'
  // If either the root or the body clips horizontally, nothing slides sideways no matter how far
  // the content sticks out. Reporting a scroll distance there would be a finding about something
  // the visitor cannot see.
  const clipped = hidden(csDe.overflowX) || (!!csBody && hidden(csBody.overflowX))
  const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0)
  const clientW = de.clientWidth
  return {
    clipped,
    scrollWidth: scrollW,
    clientWidth: clientW,
    innerWidth: window.innerWidth,
    layoutOverflowPx: Math.max(0, Math.round(scrollW - clientW)),
    scrollX: Math.round(window.scrollX || de.scrollLeft || 0)
  }
}

export function readScrollScript () {
  const de = document.documentElement
  return {
    x: Math.round(Math.max(window.scrollX || 0, de.scrollLeft || 0, document.body ? document.body.scrollLeft : 0)),
    y: Math.round(Math.max(window.scrollY || 0, de.scrollTop || 0, document.body ? document.body.scrollTop : 0))
  }
}

/** Which element is actually sticking out — evidence for the developer page. */
export function overflowCulpritScript (opts) {
  const width = opts.viewportWidth || document.documentElement.clientWidth
  const all = document.body ? document.body.getElementsByTagName('*') : []
  const limit = Math.min(all.length, opts.maxNodes || 3000)
  let worst = null
  for (let i = 0; i < limit; i++) {
    const el = all[i]
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const past = Math.round(r.right + window.scrollX - width)
    if (past <= 1) continue
    if (!worst || past > worst.past) {
      const id = el.id ? '#' + el.id : ''
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      worst = { past, selector: el.tagName.toLowerCase() + id + cls, widthPx: Math.round(r.width) }
    }
  }
  return worst
}

export function viewportMetaScript () {
  const m = document.querySelector('meta[name="viewport" i]')
  const content = m ? (m.getAttribute('content') || '').trim() : null
  return { hasViewportMeta: !!m, viewportContent: content || null }
}

export function tapSetupScript (opts) {
  const SEL = 'a[href], button, input[type="button" i], input[type="submit" i], input[type="reset" i], input[type="image" i], [role="button" i], [role="link" i], summary'
  const els = [...document.querySelectorAll(SEL)]
  const targets = []
  for (const el of els) {
    if (targets.length >= (opts.max || 600)) break
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const cs = getComputedStyle(el)
    if (cs.pointerEvents === 'none') continue
    // A collapsed mobile menu holds a dozen links a visitor cannot tap yet. They are not targets.
    if (typeof el.checkVisibility === 'function') { if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue }
    else if (cs.visibility === 'hidden' || cs.display === 'none') continue
    targets.push(el)
  }
  window.__sightline = { targets, seen: new Array(targets.length).fill(null) }
  return targets.length
}

/**
 * Hit-test every target currently on screen. Called once per screenful as the page is scrolled by
 * real wheel input — getBoundingClientRect would happily report a healthy button that is sitting
 * under a sticky header, and a finger disagrees.
 */
export function tapSweepScript () {
  const st = window.__sightline
  if (!st) return { tested: 0 }
  let tested = 0
  for (let i = 0; i < st.targets.length; i++) {
    if (st.seen[i] && st.seen[i].hit) continue
    const el = st.targets[i]
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue
    const at = document.elementFromPoint(x, y)
    const hit = !!at && (at === el || el.contains(at))
    st.seen[i] = { hit, w: r.width, h: r.height }
    tested++
  }
  return { tested }
}

export function tapTallyScript (opts) {
  const st = window.__sightline
  if (!st) return { under: 0, counted: 0, smallest: null, hitTested: 0, assumed: 0 }
  const min = opts.min || 44
  let under = 0, counted = 0, smallest = null, hitTested = 0, assumed = 0
  for (let i = 0; i < st.targets.length; i++) {
    const el = st.targets[i]
    const seen = st.seen[i]
    let w, h
    if (seen) {
      if (!seen.hit) continue      // something covers it; the visitor never reaches it at all
      w = seen.w; h = seen.h
      hitTested++
    } else {
      // Never came into view during the sweep. We can still size it, but we cannot know whether
      // anything covers it, so this half of the count is geometry only.
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      w = r.width; h = r.height
      assumed++
    }
    counted++
    const m = Math.min(w, h)
    if (smallest === null || m < smallest) smallest = m
    if (m < min) under++
  }
  return { under, counted, smallest: smallest === null ? null : Math.round(smallest), hitTested, assumed }
}

// ---------------------------------------------------------------------------------------------
// Freshness

export function freshnessScript (opts) {
  const gen = document.querySelector('meta[name="generator" i]')
  const generator = gen ? (gen.getAttribute('content') || '').trim() || null : null

  // The footer is where a stale year lives. Fall back to the tail of the document, capped so a
  // 40MB page cannot turn a regex into a hang.
  const foot = document.querySelector('footer, [role="contentinfo" i], .footer, #footer')
  let text = (foot ? foot.textContent : '') || ''
  if (!/\d{4}/.test(text)) {
    const whole = (document.body ? document.body.textContent : '') || ''
    text = whole.slice(-(opts.tailChars || 20000))
  }

  const thisYear = new Date().getFullYear()
  let year = null
  const re = /(?:©|&copy;|\(c\)|copyright)[^0-9]{0,24}((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi
  let m
  while ((m = re.exec(text)) !== null) {
    for (const g of [m[1], m[2]]) {
      const y = g ? Number(g) : NaN
      if (Number.isFinite(y) && y >= 1990 && y <= thisYear + 1 && (year === null || y > year)) year = y
    }
  }
  return { copyrightYear: year, generator }
}

export function pageLinksScript (opts) {
  const origin = location.origin
  const here = location.href.split('#')[0]
  const out = []
  const seen = new Set()
  for (const a of document.querySelectorAll('a[href]')) {
    if (out.length >= (opts.max || 40)) break
    let u
    try { u = new URL(a.getAttribute('href'), location.href) } catch { continue }
    if (u.origin !== origin) continue
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    u.hash = ''
    if (u.href === here) continue
    if (seen.has(u.href)) continue
    seen.add(u.href)
    out.push(u.href)
  }
  return out
}
