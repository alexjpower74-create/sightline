// Render every fixture to out/ so a human can look at the thing.
//
//   node src/report/preview.js          # HTML only, fast
//   node src/report/preview.js --pdf    # HTML + PDF through headless Chrome
//
// Looking at it matters more here than in most slices: every check in the suite can pass while the
// document is ugly, and ugly is the failure mode that loses the pitch.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHtml } from './html.js'
import { renderPdf } from './pdf.js'
import { sampleAudit, SAMPLES, usedRealScorer } from './sample-audit.js'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'out')

const wantPdf = process.argv.includes('--pdf')
mkdirSync(OUT, { recursive: true })
console.log(`scorer: ${usedRealScorer() ? 'src/score/ (real)' : 'scored-fixtures.json (snapshot)'}`)

for (const name of SAMPLES) {
  const audit = sampleAudit(name)
  const html = renderHtml(audit, { preparedBy: 'Example Web Studio' })
  const htmlPath = join(OUT, `${name}.html`)
  writeFileSync(htmlPath, html)
  console.log(`${name.padEnd(12)} ${(html.length / 1024).toFixed(0).padStart(4)} KB  ${htmlPath}`)
  if (wantPdf) {
    const pdfPath = await renderPdf(audit, join(OUT, `${name}.pdf`), { preparedBy: 'Example Web Studio' })
    console.log(`${''.padEnd(12)}      -> ${pdfPath}`)
  }
}
