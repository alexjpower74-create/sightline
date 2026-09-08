// Render every fixture to out/ so a human can look at the thing.
//
//   node src/report/preview.js            # HTML only, fast
//   node src/report/preview.js --pdf      # HTML + PDF through headless Chrome
//   node src/report/preview.js --shots    # screenshot the demo site and put it in the neglected
//                                         # report, so the evidence rail can actually be looked at
//
// Looking at it matters more here than in most slices: every check in the suite can pass while the
// document is ugly, and ugly is the failure mode that loses the pitch.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHtml } from './html.js'
import { renderPdf } from './pdf.js'
import { sampleAudit, SAMPLES, usedRealScorer } from './sample-audit.js'
import { shoot } from './shoot.js'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'out')

const wantPdf = process.argv.includes('--pdf')
const wantShots = process.argv.includes('--shots')
mkdirSync(OUT, { recursive: true })

// The fixtures carry `screenshots: {desktop: null, mobile: null}` — vera owns fixtures/, and the
// collector is the thing that fills those in. To see the evidence rail as a client would, shoot the
// demo site and hand the paths to the neglected audit. Nothing outside this preview does that.
let demoShots = null
if (wantShots) {
  const DEMO = join(dirname(fileURLToPath(import.meta.url)), 'demo', 'overflowing-site.html')
  demoShots = {
    mobile: await shoot(DEMO, join(OUT, 'demo-phone.png')),
    desktop: await shoot(DEMO, join(OUT, 'demo-desktop.png'), { width: 1440, height: 900, dpr: 1, mobile: false, maxHeight: 900 })
  }
  console.log(`shots:  ${demoShots.mobile}\n        ${demoShots.desktop}`)
}
console.log(`scorer: ${usedRealScorer() ? 'src/score/ (real)' : 'scored-fixtures.json (snapshot)'}`)

for (const name of SAMPLES) {
  const audit = sampleAudit(name)
  if (demoShots && name === 'neglected') audit.measurement.screenshots = { ...demoShots }
  const html = renderHtml(audit, { preparedBy: 'Example Web Studio' })
  const htmlPath = join(OUT, `${name}.html`)
  writeFileSync(htmlPath, html)
  console.log(`${name.padEnd(12)} ${(html.length / 1024).toFixed(0).padStart(4)} KB  ${htmlPath}`)
  if (wantPdf) {
    const pdfPath = await renderPdf(audit, join(OUT, `${name}.pdf`), { preparedBy: 'Example Web Studio' })
    console.log(`${''.padEnd(12)}      -> ${pdfPath}`)
  }
}
