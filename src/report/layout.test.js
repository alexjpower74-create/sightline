// Checks on the printed geometry.
//
//   node src/report/layout.test.js
//
// These exist because of a defect that every other check in this slice was blind to. The owner's
// sheet rendered correct HTML, containing every sentence it was supposed to contain, and printed
// with its cost list and its screenshot pushed onto page 2 — leaving a heading alone above half a
// blank page. String assertions cannot see that. Neither could the fixtures: all three carry
// `screenshots: null`, so nothing had an intrinsic height until the collector landed and the CLI
// was run end to end against a real site.
//
// The page is measured in print media at the real paper size, so "page 1 fits on page 1" is an
// assertion rather than a hope.

import { suite } from '@alexpower/rig/harness/check.js'
import { launch } from '@alexpower/rig/harness/cdp.js'
import { renderHtml } from './html.js'
import { sampleAudit } from './sample-audit.js'
import { shoot } from './shoot.js'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MM = 96 / 25.4                       // CSS px per mm
const PAGE = { w: 216, h: 279.4 }          // Letter
const MARGIN = { top: 15, right: 16, bottom: 14, left: 16 }   // must match @page in report.css
const CONTENT_W = Math.round((PAGE.w - MARGIN.left - MARGIN.right) * MM)
const CONTENT_H = Math.round((PAGE.h - MARGIN.top - MARGIN.bottom) * MM)

const stage = mkdtempSync(join(tmpdir(), 'sightline-layout-'))

// The tallest thing the collector realistically hands over. These arguments are chosen to match
// what src/collect/ actually produced end to end — 780 x 3376 — rather than shoot()'s own
// defaults, which capture the full laid-out width and come back landscape. A landscape shot goes
// down a different branch of the renderer and would leave this suite measuring a page with no
// phone rail on it at all, which is how it passed the first time it was run.
const DEMO = resolve(import.meta.dirname, 'demo', 'overflowing-site.html')
const phone = await shoot(DEMO, join(stage, 'phone.png'), { clipWidth: 390, scale: 1, dpr: 2, maxHeight: 1700 })

// A desktop capture too, because the page-3 screenshot columns only take their two-column shape
// when both exist — and that is the shape in which the phone column ran off the right margin. A
// mobile-only audit goes down a different branch and would have left this suite reporting a clean
// page while the real one overflowed.
const desktop = await shoot(DEMO, join(stage, 'desktop.png'), { width: 1440, height: 900, dpr: 2, mobile: false, maxHeight: 900 })

const audit = sampleAudit('neglected')
audit.measurement.screenshots = { mobile: phone, desktop }

let page = null
let browser = null

async function measure () {
  return JSON.parse(await page.eval(`(() => {
    const r = el => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } }
    const shot = document.querySelector('.shot.is-phone')
    const img = shot && shot.querySelector('img')
    // Every framed screenshot in the document, page 3 included.
    const frames = [...document.querySelectorAll('.shot')].map(f => {
      const i = f.querySelector('img')
      const fb = f.getBoundingClientRect(), ib = i ? i.getBoundingClientRect() : null
      return { fw: Math.round(fb.width), fh: Math.round(fb.height),
               iw: ib ? Math.round(ib.width) : null, ih: ib ? Math.round(ib.height) : null,
               right: Math.round(fb.right) }
    })
    return JSON.stringify({
      owner: r(document.getElementById('sheet-owner')),
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      shot: shot ? r(shot) : null,
      img: img ? r(img) : null,
      // What the image's own aspect would make it at the frame's width. The frame has to come out
      // shorter than this, or it is not cropping — it is being sized by the screenshot.
      naturalAtWidth: img ? Math.round(r(shot).w * (img.naturalHeight / img.naturalWidth)) : null,
      frames,
      pageWidth: document.documentElement.clientWidth
    })
  })()`))
}

async function load (html) {
  writeFileSync(join(stage, 'page.html'), html)
  await page.goto(pathToFileURL(join(stage, 'page.html')).href)
  await page.eval('document.fonts.ready.then(() => 1)')
}

await suite('report / layout', async s => {
  browser = await launch({ headless: true, port: 9500 + Math.floor(Math.random() * 300), width: CONTENT_W, height: CONTENT_H })
  // A viewport taller than any sheet, and no scrollbars. With the viewport at exactly one page
  // height the document scrolls, a 15px scrollbar appears, the text rewraps narrower and therefore
  // taller, and the measurement describes a page that only exists inside the test.
  page = await browser.newPage(null, { width: CONTENT_W, height: 2400, dpr: 1 })
  // Without this the screen-only sheet styling (fixed width, drop shadow, grey ground) is what
  // gets measured, and the numbers describe a page nobody will ever print.
  await page.send('Emulation.setEmulatedMedia', { media: 'print' })
  await page.send('Emulation.setScrollbarsHidden', { hidden: true })
  await load(renderHtml(audit))

  // The defect this suite was written for. Red if: the owner's sheet is taller than the printable
  // area of one sheet of Letter, which is what silently pushes its own content onto page 2.
  // Control: put the old rule back — `max-height` on the frame with no height on the image — which
  // is exactly the CSS that shipped the bug.
  await s.check('the owner sheet fits on one printed page', {
    timeout: 30_000,
    assert: async () => {
      const m = await measure()
      return m.owner.h > 0 && m.owner.h <= CONTENT_H
    },
    breaks: async () => {
      await page.eval(`(() => {
        const st = document.createElement('style')
        st.id = 'control'
        st.textContent = '.shot.is-phone{height:auto;max-height:96mm}.shot.is-phone img{height:auto}'
        document.head.appendChild(st)
        return 1
      })()`)
      return () => page.eval(`(() => { document.getElementById('control')?.remove(); return 1 })()`)
    }
  })

  // Red if: anything runs off the side of the sheet. A report that complains about a site
  // scrolling sideways has to not do it itself.
  // Control: add an element wider than the page.
  await s.check('nothing overflows the sheet sideways', {
    timeout: 30_000,
    assert: async () => (await measure()).docOverflow <= 0,
    breaks: async () => {
      await page.eval(`(() => {
        const d = document.createElement('div')
        d.id = 'control-wide'
        d.style.cssText = 'width:400mm;height:2mm'
        document.body.appendChild(d)
        return 1
      })()`)
      return () => page.eval(`(() => { document.getElementById('control-wide')?.remove(); return 1 })()`)
    }
  })

  // The mechanism behind the first check, asserted directly: the frame's height is a design
  // decision, and the screenshot is cropped into it. Red if: the image starts sizing the frame.
  //
  // The obvious form of this — `img.height ≈ frame.height` — was VOID, and instructively so. When
  // the frame is sized BY the image those two are also equal, so the assertion held just as well
  // against the broken layout. What separates the two states is whether the frame is shorter than
  // the image's own aspect would make it.
  // Control: the CSS that shipped the bug, which restores the uncropped image.
  await s.check('the evidence image is cropped to its frame, not the other way round', {
    timeout: 30_000,
    assert: async () => {
      const m = await measure()
      if (!m.shot || !m.img) return false
      const cropping = m.shot.h < m.naturalAtWidth - 4
      const contained = m.img.h <= m.shot.h + 2 && m.img.w <= m.shot.w
      return cropping && contained
    },
    breaks: async () => {
      await page.eval(`(() => {
        const st = document.createElement('style')
        st.id = 'control2'
        st.textContent = '.shot.is-phone{height:auto;max-height:96mm}.shot.is-phone img{height:auto}'
        document.head.appendChild(st)
        return 1
      })()`)
      return () => page.eval(`(() => { document.getElementById('control2')?.remove(); return 1 })()`)
    }
  })

  // A good site has less to say and a dead one has almost nothing, so both must also fit — and the
  // dead one in particular must not somehow grow a second page out of an empty measurement table.
  // Red if: either sheet overruns. Control: pad the sheet past the page height.
  // Red if: any screenshot frame anywhere in the document escapes the page, or lets its image
  // escape the frame. The page-1 rail was fixed for this and page 3 was not — a 780px capture
  // pushed the phone column past the right margin, which the sheet-height and sideways-overflow
  // checks both missed, because the column overrun the printable width without extending the
  // document's scroll width.
  //
  // The control removes the image sizing, which is the rule that actually holds this. That was
  // worth measuring rather than guessing: the first control tried was `min-width: auto` on the
  // column, on the theory that flexbox's content-based minimum was the culprit, and it changed
  // nothing — the check came back VOID. Taking both away is what reproduces the overflow, so
  // min-width: 0 is a second line of defence rather than the fix, and the comment in report.css
  // now says so.
  await s.check('every screenshot frame stays inside the page and inside its frame', {
    timeout: 30_000,
    assert: async () => {
      const m = await measure()
      if (m.frames.length < 2) return false
      return m.frames.every(f =>
        f.right <= m.pageWidth + 1 && f.iw <= f.fw + 1 && f.ih <= f.fh + 2)
    },
    breaks: async () => {
      await page.eval(`(() => {
        const st = document.createElement('style')
        st.id = 'control-flex'
        st.textContent = '.shot-pair .shot img{width:auto;height:auto}.shot-pair .col-narrow{min-width:auto}'
        document.head.appendChild(st)
        return 1
      })()`)
      return () => page.eval(`(() => { document.getElementById('control-flex')?.remove(); return 1 })()`)
    }
  })

  // The document is loaded before the check, never inside the assertion.
  //
  // Both of these were VOID on the first run for that reason: the assertion called load(), which
  // re-navigates, which threw away the element the control had just injected — so the re-assertion
  // measured a pristine page and agreed with itself. A control that the assertion undoes before
  // looking is not a control.
  for (const name of ['solid', 'unreachable']) {
    await load(renderHtml(sampleAudit(name)))
    await s.check(`the ${name} owner sheet fits on one printed page`, {
      timeout: 30_000,
      assert: async () => {
        const m = await measure()
        return m.owner.h > 0 && m.owner.h <= CONTENT_H
      },
      breaks: async () => {
        await page.eval(`(() => {
          const d = document.createElement('div')
          d.id = 'control-tall'
          d.style.cssText = 'height:${CONTENT_H}px'
          document.getElementById('sheet-owner').appendChild(d)
          return 1
        })()`)
        return () => page.eval(`(() => { document.getElementById('control-tall')?.remove(); return 1 })()`)
      }
    })
  }
})

try { await page?.close() } catch {}
try { await browser?.close() } catch {}
rmSync(stage, { recursive: true, force: true })
