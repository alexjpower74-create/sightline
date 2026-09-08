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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const baseline = strayChromes()
  let leaked = null
  await s.check('renderPdf leaves no Chrome behind', {
    timeout: TIMEOUT,
    assert: async () => {
      await renderPdf(sampleAudit('solid'), join(stage, 'solid.pdf'))
      await new Promise(r => setTimeout(r, 800))
      return strayChromes() === baseline
    },
    breaks: async () => {
      leaked = await launch({ headless: true, port: 9388 })
      // One browser is several processes; wait for its helpers so the count is settled either way.
      await new Promise(r => setTimeout(r, 800))
      return async () => { if (leaked) { await leaked.close(); leaked = null } }
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
