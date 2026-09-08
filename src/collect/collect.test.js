// The collector, end to end, against a site served from this directory.
//
// Nothing here touches the live internet. A test that depends on someone else's website fails when
// their CDN hiccups and passes when their page changes underneath you, and tells you nothing
// either way.
//
// Every negative control below breaks the PAGE — it edits the fixture on disk and re-collects.
// Breaking the collector's own module state would prove only that the test can reach a variable.

import { readFile, writeFile, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from '@alexpower/rig/harness/check.js'
import { launch } from '@alexpower/rig/harness/cdp.js'
import { startServer } from './server.js'
import { collect } from './index.js'
import { pngSize } from './screenshot.js'
import { siteFiles } from './links.js'
import { freePort } from './free-port.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIX = join(here, 'fixtures')
const OUT = join(here, '..', '..', 'out', 'test-shots')

const server = await startServer()
const browser = await launch({ headless: true, port: await freePort() })

// Any fixture we edit is restored even if this process dies partway through a check.
const originals = new Map()
async function snapshot (name) {
  if (!originals.has(name)) originals.set(name, await readFile(join(FIX, name), 'utf8'))
}
async function restoreAll () {
  for (const [name, text] of originals) await writeFile(join(FIX, name), text)
}
process.on('exit', () => { for (const [name, text] of originals) { try { require('node:fs').writeFileSync(join(FIX, name), text) } catch {} } })

/** One collect() per page, memoised — until something breaks the page and invalidates it. */
const runs = new Map()
let softMode = true
const shots = new Map()
function measure (path, opts = {}) {
  if (!runs.has(path)) {
    runs.set(path, collect(server.url(path), {
      browser,
      outDir: OUT,
      onNote: n => { if (n.kind === 'screenshot' && n.which === 'mobile') shots.set(path, n) },
      ...opts
    }))
  }
  return runs.get(path)
}

/** Take the page away entirely, so the server answers 404 for it. */
function withdrawing (name) {
  return async () => {
    await snapshot(name)
    const before = await readFile(join(FIX, name), 'utf8')
    await rename(join(FIX, name), join(FIX, name + '.withdrawn'))
    runs.clear(); shots.clear()
    return async () => { await rename(join(FIX, name + '.withdrawn'), join(FIX, name)); await writeFile(join(FIX, name), before); runs.clear(); shots.clear() }
  }
}

/**
 * Edit a fixture on disk, drop the memoised run, and hand back the undo. This is the only kind of
 * negative control worth having here: the thing under test is what the page contains.
 */
function editing (name, transform) {
  return async () => {
    await snapshot(name)
    const before = await readFile(join(FIX, name), 'utf8')
    const after = transform(before)
    if (after === before) throw new Error(`negative control for ${name} changed nothing — it would prove nothing`)
    await writeFile(join(FIX, name), after)
    runs.clear(); shots.clear()
    return async () => { await writeFile(join(FIX, name), before); runs.clear(); shots.clear() }
  }
}

await suite('collector', async t => {
  // Every check below drives two full measurements — the real page and the broken one — so the
  // harness's 10s default is a thin margin. One full run flaked on it at exactly 10002ms while the
  // same check took 3.9s standalone: machine load, not a defect, but a suite that goes red under
  // load is a suite people learn to re-run instead of read. Nothing here should legitimately take
  // 30 seconds.
  const check = (name, opts) => t.check(name, { timeout: 30_000, ...opts })


  // ---- shape and reachability ----------------------------------------------------------------

  // RED IF: a reachable page comes back as unreachable, or a page that is gone comes back as ok.
  //
  // The first control here wrote an empty file, and the check stayed green — rightly, because an
  // empty 200 IS reachable. Taking the page away is the break that actually tests the claim.
  await check('a page that loads comes back ok, with its final url', {
    assert: async () => {
      const m = await measure('/good.html')
      return m.ok === true && m.error === null && m.finalUrl === server.url('/good.html')
    },
    breaks: withdrawing('good.html')
  })

  // ---- weight, from the network and not from the markup ---------------------------------------

  // RED IF: page weight is inferred from the HTML. The 2MB image on good.html is attached by a
  // script after parse, so a markup reader scores it at zero.
  await check('page weight counts bytes a script asked for after parse', {
    assert: async () => {
      const m = await measure('/good.html')
      return m.weight.imageBytes >= 1_900_000 && m.weight.largestImage?.url === '/big.png'
    },
    breaks: editing('good.html', s => s.replace("framing').src = '/big.png'", "framing').src = '/pixel.png'"))
  })

  // RED IF: script bytes are not attributed separately from everything else.
  await check('script bytes are counted separately', {
    assert: async () => (await measure('/good.html')).weight.scriptBytes >= 250_000,
    breaks: editing('good.html', s => s.replace('<script src="/heavy.js"></script>', ''))
  })

  // ---- accessibility ---------------------------------------------------------------------------

  // RED IF: alt="" is treated as a fault, or a missing alt is not. imagesTotal drives a ratio in
  // the scoring, so it has to be right even when nothing is missing.
  await check('counts missing alt text but not a deliberate empty alt', {
    assert: async () => {
      const m = await measure('/bad.html')
      return m.a11y.imagesMissingAlt === 2 && m.a11y.imagesTotal === 3
    },
    breaks: editing('bad.html', s => s.replace('<img src="/pixel.png">', '<img src="/pixel.png" alt="A van">'))
  })

  // RED IF: a control counts as labelled when nothing labels it.
  await check('counts form controls with no label of any kind', {
    assert: async () => (await measure('/bad.html')).a11y.inputsMissingLabel === 3,
    breaks: editing('bad.html', s => s.replace('<input type="text" name="q">', '<input type="text" name="q" aria-label="Search">'))
  })

  // RED IF: a jump from h1 straight to h4 is not seen as a break in the outline.
  await check('sees a heading level skipped', {
    assert: async () => (await measure('/bad.html')).a11y.headingOrderBreaks === 1,
    breaks: editing('bad.html', s => s.replace('<h4>Skipped from h1 straight to h4</h4>', '<h2>Skipped from h1 straight to h4</h2>'))
  })

  // RED IF: the landmark, skip link and lang checks report on something other than what is there.
  await check('finds the main landmark, the skip link and the lang attribute', {
    assert: async () => {
      const a = (await measure('/good.html')).a11y
      return a.hasMainLandmark && a.hasSkipLink && a.htmlLangSet
    },
    breaks: editing('good.html', s => s.replace('<html lang="en">', '<html>'))
  })

  // ---- the money finding -----------------------------------------------------------------------

  // RED IF: horizontal overflow is measured against the wrong viewport width. 900 - 390 = 510.
  await check('measures how far the page runs past a 390px screen', {
    assert: async () => (await measure('/bad.html')).mobile.horizontalOverflowPx === 510,
    breaks: editing('bad.html', s => s.replace('.wide-table { width: 900px;', '.wide-table { width: 300px;'))
  })

  // RED IF: geometry alone decides it. This page is 900px wide inside a root that clips, so
  // nothing moves and the visitor sees nothing wrong. A number here is a false accusation.
  await check('reports no overflow when the root clips it away', {
    assert: async () => (await measure('/clipped.html')).mobile.horizontalOverflowPx === 0,
    breaks: editing('clipped.html', s => s.replace('html, body { overflow-x: hidden; }', ''))
  })

  // RED IF: overflow is read once, at load. The wide block on this page is inserted by an
  // IntersectionObserver partway down, so a single early reading misses it entirely.
  await check('catches overflow that only appears once the page is scrolled', {
    assert: async () => (await measure('/long.html')).mobile.horizontalOverflowPx > 300,
    breaks: editing('long.html', s => s.replace("document.getElementById('slot').appendChild(d)", 'void d'))
  })

  // RED IF: the report can only say "your page overflows by 510px" — a complaint — instead of
  // naming the thing to fix.
  await check('names the element that is actually dragging the page sideways', {
    assert: async () => {
      const c = (await measure('/bad.html')).mobile.overflowCulprit
      return c && c.selector === 'div.wide-table' && c.widthPx === 900 && c.pastPx === 510
    },
    breaks: editing('bad.html', s => s.replace('.wide-table { width: 900px;', '.wide-table { width: 300px;'))
  })

  // RED IF: the widest box wins regardless of context. The 1400px table on this page scrolls
  // inside its own window — it sticks out further than anything else and contributes nothing to
  // the page's sideways scroll. Naming it sends a developer to fix the one thing already fixed.
  await check('does not blame a wide table that scrolls inside its own window', {
    assert: async () => {
      const m = await measure('/scrollwrap.html')
      return m.mobile.horizontalOverflowPx === 210 && m.mobile.overflowCulprit?.selector === 'div.banner'
    },
    breaks: editing('scrollwrap.html', s => s.replace('.scroller { overflow-x: auto; width: 100%; }', '.scroller { width: 100%; }'))
  })

  // ---- tap targets ------------------------------------------------------------------------------

  // RED IF: tap targets are measured by getBoundingClientRect. Two of the four small links on this
  // page sit under a fixed header; a rect reports them as fine and a finger never reaches them.
  await check('hit-tests tap targets instead of measuring rectangles', {
    assert: async () => {
      const m = await measure('/covered.html')
      return m.mobile.tapTargetsUnder44 === 1 && m.mobile.smallestTapTargetPx === 30
    },
    breaks: editing('covered.html', s => s.replace('.bar { position: fixed;', '.bar { position: static;'))
  })

  // RED IF: the page is only examined at the top. Targets four screens down have to be reached
  // with real input before they can be hit-tested.
  await check('sweeps the whole page for tap targets, not just the first screen', {
    assert: async () => (await measure('/long.html')).mobile.tapTargetsUnder44 === 4,
    breaks: editing('long.html', s => s.replace('.small { display: inline-block; width: 28px; height: 28px;', '.small { display: inline-block; width: 64px; height: 64px;'))
  })

  // RED IF: an off-canvas skip link is counted as a 24px tap target — a finding against the one
  // site that got accessibility right.
  await check('does not count a skip link parked off the canvas', {
    assert: async () => {
      const m = await measure('/good.html')
      return m.mobile.tapTargetsUnder44 === 0 && m.mobile.smallestTapTargetPx >= 44
    },
    breaks: editing('good.html', s => s.replace('.skip { position: absolute; left: -9999px; }', '.skip { position: static; height: 20px; }'))
  })

  // RED IF: the phone screenshot is clipped to 390 on a page that did not lay out at 390. Chrome
  // widens the layout viewport for a page with no viewport meta and scales the whole thing down;
  // clipping that to 390 crops it to the left third, which is not what anybody sees. What a
  // visitor sees is the entire page shrunk to unreadable, and that is the image that persuades.
  await check('the phone screenshot shows the whole page a no-viewport site shrinks to', {
    assert: async () => {
      const m = await measure('/noviewport.html')
      const shot = shots.get('/noviewport.html')
      if (!shot) return false
      const png = pngSize(await readFile(m.screenshots.mobile))
      return m.mobile.hasViewportMeta === false && shot.shrunkToFit === true &&
        shot.layoutWidthCss >= 900 && png.width === 780
    },
    breaks: editing('noviewport.html', s => s.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">'))
  })

  // RED IF: a site that DOES declare a viewport gets captured at some other width. The same
  // formula has to leave a well-built page exactly as it was.
  await check('a site with a viewport meta is still captured at phone width', {
    assert: async () => {
      await measure('/good.html')
      const shot = shots.get('/good.html')
      return !!shot && shot.layoutWidthCss === 390 && shot.shrunkToFit === false && shot.width === 780
    },
    breaks: editing('good.html', s => s.replace('<meta name="viewport" content="width=device-width, initial-scale=1">', ''))
  })

  // ---- being found -------------------------------------------------------------------------------

  // RED IF: title, description, canonical, og tags or structured data are read wrongly.
  await check('reads the title, description, canonical, og tags and structured data', {
    assert: async () => {
      const s = (await measure('/good.html')).seo
      return s.titleLength === 42 && s.metaDescriptionLength === 141 && s.h1Count === 1 &&
        s.canonical === server.url('/good.html') && s.ogTags.length === 3 &&
        s.structuredDataTypes.includes('LocalBusiness')
    },
    breaks: editing('good.html', s => s.replace('"@type":"LocalBusiness"', '"@type":"Thing"'))
  })

  // RED IF: robots.txt and sitemap.xml are credited on status alone. This server answers both with
  // its homepage, which is what a great many real sites do.
  await check('does not credit a robots.txt that is really the homepage', {
    assert: async () => {
      const s2 = await startServer({ softFiles: softMode })
      try {
        const f = await siteFiles(s2.origin)
        return f.hasRobotsTxt === false && f.hasSitemap === false
      } finally { await s2.close() }
    },
    // The control serves the genuine article instead. If the assertion cannot tell a real
    // robots.txt from the homepage wearing its name, it is measuring nothing — which is exactly
    // what the first version of this control failed to reveal, because it set a global and
    // changed nothing about the server under test.
    breaks: () => { softMode = false; return () => { softMode = true } }
  })

  // ---- freshness -----------------------------------------------------------------------------

  // RED IF: a stale copyright year in the footer is missed, or this year's is misread as stale.
  await check('reads the copyright year out of the footer', {
    assert: async () => (await measure('/bad.html')).freshness.copyrightYear === 2011,
    breaks: editing('bad.html', s => s.replace('&copy; 2011 Somebody', '&copy; 2026 Somebody'))
  })

  // RED IF: same-origin links are not actually requested, or the status is lost on the way. The
  // report renders "url (status)", so a link that is dead has to say how.
  await check('finds the links that are dead, and what they answered', {
    assert: async () => {
      const b = (await measure('/bad.html')).freshness.brokenLinks
      return b.length === 2 && b.every(l => l.status === 404) &&
        b.some(l => l.url === '/gone') && b.some(l => l.url === '/nowhere.html')
    },
    breaks: editing('bad.html', s => s.replace('href="/nowhere.html"', 'href="/good.html"'))
  })

  // RED IF: the platform is guessed from the markup rather than from what the page loaded.
  await check('infers the platform from what the page requested', {
    assert: async () => (await measure('/bad.html')).freshness.generator === 'WordPress',
    breaks: editing('bad.html', s => s.replace('<script src="/wp-content/themes/harbour/main.js"></script>', ''))
  })

  // ---- screenshots ----------------------------------------------------------------------------

  // RED IF: we hand the report a blank rectangle. A screenshot of a tab that is not painting is a
  // picture of a lie, and it goes into a document a business owner reads as evidence.
  await check('writes real screenshots at both viewports', {
    assert: async () => {
      const m = await measure('/good.html')
      if (!m.screenshots.desktop || !m.screenshots.mobile) return false
      const d = await readFile(m.screenshots.desktop)
      const p = await readFile(m.screenshots.mobile)
      const ds = pngSize(d), ps = pngSize(p)
      return ds.width === 2880 && ds.height === 1800 && ps.width === 780 &&
        d.length > 30_000 && p.length > 30_000
    },
    breaks: editing('good.html', s => s.replace(/<body>[\s\S]*<\/body>/, '<body></body>'))
  })
})

await restoreAll()
await browser.close()
await server.close()
process.exit(process.exitCode || 0)
