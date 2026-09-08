// Checks on the PDF path.
//
//   node src/report/pdf.test.js
//
// Slower than the render suite because every check launches real Chrome, and the negative controls
// launch it a second time. That is the price of checking the three things that have actually gone
// wrong here before — fonts silently falling back to Times, images printing as blank boxes, and
// Chrome not exiting — none of which a check on the HTML string can see.

import { suite } from '@alexpower/rig/harness/check.js'
import { launch } from '@alexpower/rig/harness/cdp.js'
import { renderPdf, htmlToPdf } from './pdf.js'
import { renderHtml } from './html.js'
import { sampleAudit } from './sample-audit.js'
import { fontCss } from './assets.js'
import { shoot } from './shoot.js'
import { view } from './html.js'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const stage = mkdtempSync(join(tmpdir(), 'sightline-pdftest-'))
const TIMEOUT = 90_000

/** Page count, read out of the PDF itself rather than trusting the renderer's own report. */
function pageCount (buf) {
  const s = buf.toString('latin1')
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map(m => Number(m[1]))
  const types = (s.match(/\/Type\s*\/Page[^s]/g) || []).length
  return Math.max(types, counts.length ? Math.max(...counts) : 0)
}

/** Chrome processes still alive from the rig's launcher. Its profiles are all named rig-chrome-*. */
function strayChromes () {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', 'rig-chrome-'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length
  } catch {
    return 0   // pgrep exits 1 when nothing matched
  }
}

/**
 * Wait until the count stops moving before believing it.
 *
 * One browser is a dozen processes, and `browser.close()` returns well before the helpers are
 * reaped — sampling immediately after a render counts ghosts. That is not theoretical: it made
 * this check go red when the suites were run back to back, because the setup render's helpers were
 * still dying when the baseline was taken, so the baseline was higher than anything that followed.
 * Sampling once, at either end, is how a leak check reports on scheduling noise instead of leaks.
 */
async function settledChromes ({ tries = 20, gap = 300 } = {}) {
  let last = strayChromes()
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, gap))
    const now = strayChromes()
    if (now === last) return now
    last = now
  }
  return last
}

await suite('report / pdf', async s => {
  const audit = sampleAudit('neglected')
  const out = join(stage, 'neglected.pdf')
  await renderPdf(audit, out, { preparedBy: 'Example Web Studio' })
  const first = readFileSync(out)

  // Red if: the file is not a PDF, or is a single page — which is what a broken `break-after: page`
  // or a collapsed stylesheet produces, and it looks fine until someone tries to hand over page 2.
  // Control: truncate the artifact on disk. The assertion reads the file, so it must notice; if it
  // were quietly re-rendering instead, it would not.
  await s.check('renderPdf writes a real, multi-page PDF', {
    timeout: TIMEOUT,
    assert: () => {
      if (!existsSync(out)) return false
      const buf = readFileSync(out)
      return buf.subarray(0, 5).toString('latin1') === '%PDF-' && pageCount(buf) >= 3
    },
    breaks: () => {
      writeFileSync(out, Buffer.from('not a pdf'))
      return () => writeFileSync(out, first)
    }
  })

  // The one this whole slice ships TTFs for. woff2 does not reliably decode in the headless print
  // path, and when it fails it falls back to Times silently — a document you have already emailed.
  // Red if: the embedded font resources stop naming our faces.
  // Control: print the same document with the @font-face block stripped out. If the assertion is
  // real, that PDF must not name them.
  const html = renderHtml(audit)
  await s.check('the bundled faces are embedded in the PDF, not silently swapped for Times', {
    timeout: TIMEOUT,
    assert: () => {
      const s2 = readFileSync(out).toString('latin1')
      // Chrome subsets and prefixes embedded fonts (ABCDEF+PublicSans), so match the family name.
      return /PublicSans/.test(s2) && /SourceSerif/.test(s2)
    },
    breaks: async () => {
      const stripped = html.replace(fontCss(), '')
      const bare = join(stage, 'bare.pdf')
      await htmlToPdf(stripped, bare)
      const kept = first
      writeFileSync(out, readFileSync(bare))
      return () => { writeFileSync(out, kept); rmSync(bare, { force: true }) }
    }
  })

  // Red if: an image that never decoded is printed as a blank box. settle() is supposed to refuse
  // to print in that case rather than produce a document with a hole in it.
  // Control: swap the broken image for a real one — the same code must then print without
  // complaint, which proves the check is watching decoding and not just watching for any throw.
  const BROKEN_IMG = '<!doctype html><title>t</title><body><img src="data:image/png;base64,QUJD"><p>x</p>'
  const GOOD_IMG = '<!doctype html><title>t</title><body><img src="data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' +
    '"><p>x</p>'
  let imgHtml = BROKEN_IMG
  await s.check('a screenshot that never decoded stops the print instead of leaving a blank box', {
    timeout: TIMEOUT,
    assert: async () => {
      try {
        await htmlToPdf(imgHtml, join(stage, 'img.pdf'))
        return false
      } catch (e) {
        return /never decoded/.test(e.message)
      }
    },
    breaks: () => {
      imgHtml = GOOD_IMG
      return () => { imgHtml = BROKEN_IMG }
    }
  })

  // Chrome does not always go quietly, and a batch run over a hundred businesses that leaks one
  // browser per site takes the machine down. Red if: renderPdf leaves a process behind.
  // Control: leak one deliberately. If the assertion cannot see that, it could not see a real leak
  // either.
  //
  // The baseline is taken once, here, and not inside the assertion. Measuring it inside made this
  // check pass for the wrong reason: the leak was already running by then, so it counted into
  // `before` as well as `after` and the comparison held — it only went red because Chrome's helper
  // processes were still appearing between the two samples. That is a race dressed as a control.
  const baseline = await settledChromes()
  let leaked = null
  await s.check('renderPdf leaves no Chrome behind', {
    timeout: TIMEOUT,
    assert: async () => {
      await renderPdf(sampleAudit('solid'), join(stage, 'solid.pdf'))
      return (await settledChromes()) === baseline
    },
    breaks: async () => {
      leaked = await launch({ headless: true, port: 9388 })
      await settledChromes()
      return async () => { if (leaked) { await leaked.close(); leaked = null } }
    }
  })

  /* ── the size budget ──────────────────────────────────────────────────────────────────── */

  // The whole point of the PDF is that a two-person shop attaches it to an email and sends it to a
  // prospect they have never spoken to. 15 live audits averaged 6.7 MB of PDF and 7.9 MB of HTML,
  // peaking at 12.2 MB. Most mail servers reject over 10 MB and plenty of corporate ones stop at 5,
  // so those reports either bounce or arrive apologising for their own size.
  //
  // Red if: either artefact breaks 2 MB with screenshots embedded. The control turns compression
  // off, which is the state that shipped — a budget that cannot fail is not a budget, and this one
  // also goes red if sips silently stops working, which would restore the original bug in silence.
  //
  // Measured against a photo-heavy stand-in, not the flat-colour demo: gradients and continuous
  // tone are what PNG is bad at and what real business sites are made of, and the cheap demo would
  // let this pass without ever meeting the content that caused the problem.
  const HEAVY = resolve(import.meta.dirname, 'demo', 'heavy-site.html')
  const heavyShots = {
    desktop: await shoot(HEAVY, join(stage, 'heavy-d.png'), { width: 1440, height: 900, dpr: 2, mobile: false, maxHeight: 900 }),
    mobile: await shoot(HEAVY, join(stage, 'heavy-m.png'), { width: 390, height: 844, dpr: 2, mobile: true, clipWidth: 390, scale: 1, maxHeight: 4000 })
  }
  const BUDGET = 2 * 1024 * 1024
  let compressImages = true
  await s.check('a report with screenshots fits in an email', {
    timeout: TIMEOUT,
    assert: async () => {
      const a = sampleAudit('neglected')
      a.measurement.screenshots = { ...heavyShots }
      const html = renderHtml(a, { compressImages })
      const pdfPath = join(stage, 'budget.pdf')
      await htmlToPdf(html, pdfPath)
      const pdfBytes = readFileSync(pdfPath).length
      const htmlBytes = Buffer.byteLength(html)
      // Reported either way, so a run that only just fits is visible rather than a silent pass.
      process.stdout.write(`        html ${(htmlBytes / 1048576).toFixed(2)} MB, pdf ${(pdfBytes / 1048576).toFixed(2)} MB\n`)
      return htmlBytes < BUDGET && pdfBytes < BUDGET
    },
    breaks: () => {
      compressImages = false
      return () => { compressImages = true }
    }
  })

  // Red if: the screenshots stop actually being re-encoded — the budget above can be met for the
  // wrong reason if a capture happens to be small. Control: turn compression off.
  await s.check('screenshots are re-encoded on the way into the document', {
    timeout: TIMEOUT,
    assert: () => {
      const a = sampleAudit('neglected')
      a.measurement.screenshots = { ...heavyShots }
      const v = view(a, { compressImages })
      if (!v.shots.mobile || !v.shots.desktop) return false
      const src = readFileSync(heavyShots.mobile).length
      return v.shots.mobile.compressed && v.shots.desktop.compressed && v.shots.mobile.bytes < src / 2
    },
    breaks: () => {
      compressImages = false
      return () => { compressImages = true }
    }
  })

  // Red if: a site that did not respond cannot be turned into a PDF at all. It is the one document
  // a shop most wants to put in front of an owner, and the render path for it is the least
  // exercised. Control: hand renderPdf an audit missing `findings`, which the contract rejects.
  const dead = sampleAudit('unreachable')
  await s.check('an unreachable site still produces a PDF', {
    timeout: TIMEOUT,
    assert: async () => {
      const p = join(stage, 'dead.pdf')
      await renderPdf(dead, p)
      const buf = readFileSync(p)
      return buf.subarray(0, 5).toString('latin1') === '%PDF-' && pageCount(buf) >= 2
    },
    breaks: () => {
      const before = dead.findings
      delete dead.findings
      return () => { dead.findings = before }
    }
  })
})

rmSync(stage, { recursive: true, force: true })
