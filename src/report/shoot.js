// Capture a PNG of a local page, so the report's screenshot path can be demonstrated.
//
// This is NOT the collector. c1 owns collecting screenshots off real sites, with all the hard parts
// — backgrounded tabs, redirect loops, 40 MB pages. This is a few lines pointed at a local file,
// and it exists for one reason: a report whose most persuasive element has never once been rendered
// with an actual image in it has not been checked.
//
// One thing found here that c1 will hit too. On a page with no viewport meta, Chrome's mobile
// emulation does not lay out at 390 — it expands the layout viewport to the page's content width
// (1288 for the demo file next door) and leaves it there. So `innerWidth` is not the device width,
// and a screenshot clipped to 390 shows the left third of the page rather than what a visitor sees,
// which is the whole thing shrunk to unreadable. Capturing the laid-out width is the honest shot
// for that case. Flagged to c1 in .rig/report-c2.md; the renderer takes whatever aspect it is given.

import { launch } from '@alexpower/rig/harness/cdp.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {string} filePath  a local .html file
 * @param {string} outPath   where to write the .png
 * @param {{width?:number, height?:number, dpr?:number, mobile?:boolean,
 *          maxHeight?:number, clipWidth?:number|null, scale?:number}} [opts]
 * @returns {Promise<string>} outPath
 */
export async function shoot (filePath, outPath, opts = {}) {
  const { width = 390, height = 844, dpr = 3, mobile = true,
          maxHeight = 1600, clipWidth = null, scale = 1 } = opts
  const out = resolve(outPath)
  mkdirSync(dirname(out), { recursive: true })
  const port = 9400 + Math.floor(Math.random() * 500)

  let browser = null, page = null
  try {
    browser = await launch({ headless: true, port, width, height })
    // Headless lays out at a ~500px floor whatever --window-size says; newPage pins the metrics.
    page = await browser.newPage(null, { width, height, dpr, mobile })
    await page.goto(pathToFileURL(resolve(filePath)).href)

    // documentElement.scrollHeight is inflated by the emulation (2788 for a 558px page). The body's
    // own box is the content, and a screenshot padded with 2000px of white says nothing.
    const box = await page.eval('JSON.stringify({ w: document.documentElement.scrollWidth, h: Math.ceil(document.body.scrollHeight) })')
    const { w, h } = JSON.parse(box)

    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: clipWidth ?? w, height: Math.min(h, maxHeight), scale }
    })
    if (!data) throw new Error('captureScreenshot returned no data')
    writeFileSync(out, Buffer.from(data, 'base64'))
    return out
  } finally {
    try { if (page) await page.close() } catch {}
    try { if (browser) await browser.close() } catch {}
  }
}
