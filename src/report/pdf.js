// HTML to PDF, through real Chrome.
//
// Three things have burned this pipeline before and are handled deliberately below:
//
//   1. woff2 does not reliably decode in the headless print path, and when it fails it fails
//      silently — you get Times in a document you have already emailed. Fonts are TTF, inlined
//      by assets.js, and we block on `document.fonts.ready` before printing.
//   2. Chrome does not always exit. Every launch is wrapped so `browser.close()` runs on the
//      failure path too, and the caller can assert on the process being gone.
//   3. Images that have not decoded print as blank boxes. We await every image's decode before
//      asking for the PDF, with a ceiling so one bad data URI cannot hang a batch run.

import { launch } from '@alexpower/rig/harness/cdp.js'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderHtml } from './html.js'

/** Letter, in inches, because that is what printToPDF speaks. */
const PAGE = { paperWidth: 8.5, paperHeight: 11 }

/**
 * Render an Audit straight to a PDF on disk.
 *
 * @param {import('../contract.js').Audit} audit
 * @param {string} outPath
 * @param {{preparedBy?:string, port?:number, keepHtml?:string}} [opts]
 * @returns {Promise<string>} outPath
 */
export async function renderPdf (audit, outPath, opts = {}) {
  const html = renderHtml(audit, opts)
  return htmlToPdf(html, outPath, opts)
}

/**
 * The half of renderPdf that has nothing to do with audits, split out so a test can drive the
 * browser path with a two-line document instead of a 500 KB one.
 *
 * @param {string} html
 * @param {string} outPath
 * @returns {Promise<string>} outPath
 */
export async function htmlToPdf (html, outPath, opts = {}) {
  const out = resolve(outPath)
  mkdirSync(dirname(out), { recursive: true })

  // A random port: a batch run of a hundred sites should not deadlock on a fixed one.
  const port = opts.port ?? 9400 + Math.floor(Math.random() * 500)

  const stage = mkdtempSync(join(tmpdir(), 'sightline-pdf-'))
  const htmlPath = join(stage, 'report.html')
  writeFileSync(htmlPath, html, 'utf8')
  if (opts.keepHtml) { mkdirSync(dirname(resolve(opts.keepHtml)), { recursive: true }); writeFileSync(resolve(opts.keepHtml), html, 'utf8') }

  let browser = null
  let page = null
  try {
    browser = await launch({ headless: true, port, width: 1100, height: 1400 })
    page = await browser.newPage(null, { width: 1100, height: 1400, dpr: 1 })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30_000 })

    await settle(page)

    const { data } = await page.send('Page.printToPDF', {
      ...PAGE,
      // The stylesheet owns the margins via @page; duplicating them here would double them.
      preferCSSPageSize: true,
      printBackground: true,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      transferMode: 'ReturnAsBase64'
    })
    if (!data) throw new Error('printToPDF returned no data')

    const buf = Buffer.from(data, 'base64')
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('printToPDF returned something that is not a PDF')
    }
    writeFileSync(out, buf)
    return out
  } finally {
    // Order matters: close the tab, then the browser, then the staging dir. Each step is
    // independently guarded, because a throw here would mask the real error above it.
    try { if (page) await page.close() } catch {}
    try { if (browser) await browser.close() } catch {}
    try { rmSync(stage, { recursive: true, force: true }) } catch {}
  }
}

/**
 * Block until the page is genuinely printable: fonts decoded, images decoded.
 *
 * `document.fonts.ready` is the one that matters — without it the first print of a cold profile
 * comes out in the fallback stack, and it looks close enough that you can ship it by accident.
 */
async function settle (page, { timeout = 15_000 } = {}) {
  const ok = await page.eval(`(async () => {
    const cap = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('timeout'), ms))])
    const fonts = await cap(document.fonts.ready.then(() => 'fonts'), ${timeout})
    const imgs = [...document.images].map(i => i.decode().catch(() => {}))
    await cap(Promise.all(imgs), ${timeout})
    return {
      fonts,
      loaded: document.fonts.status,
      faces: document.fonts.size,
      images: document.images.length,
      undecoded: [...document.images].filter(i => !i.complete || i.naturalWidth === 0).length
    }
  })()`)
  if (ok?.undecoded > 0) {
    throw new Error(`${ok.undecoded} of ${ok.images} images never decoded — the PDF would print blank boxes`)
  }
  if (ok?.loaded !== 'loaded') {
    throw new Error(`fonts did not finish loading (document.fonts.status = ${ok?.loaded}) — the PDF would print in a fallback face`)
  }
  return ok
}
