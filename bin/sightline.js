#!/usr/bin/env node
import { auditOne, auditMany, writeReports, callList, score, explain, loadJson } from '../src/cli/run.js'
import { writeFileSync } from 'node:fs'

const HELP = `sightline — audit a small business website, and say what it costs the owner

  sightline audit <url> [--name "Business"] [--out out/]
      Visit one site, score it, and write the report.

  sightline list <businesses.json> [--out out/]
      Audit a list and print a ranked call list. Worst and most fixable first.

  sightline score <measurement.json>
      Score a measurement that was already collected.

  sightline explain <measurement.json>
      Show the arithmetic behind a score, rule by rule. Use this when a client argues with a number.

The score is a weighted heuristic, not a law of physics. Every point deducted is traceable to a
named rule and a measured value — which is why explain() exists.
`

const [cmd, ...rest] = process.argv.slice(2)
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d }
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))

try {
  switch (cmd) {
    case 'audit': {
      const url = positional[0]
      if (!url) throw new Error('usage: sightline audit <url>')
      const out = flag('--out', 'out')
      const business = { name: flag('--name', new URL(url).hostname.replace(/^www\./, '')), url }
      const audit = await auditOne(business, { outDir: out })
      console.log(explain(audit.measurement))
      console.log(`\n${audit.score.hook}\n`)
      console.log((await writeReports([audit], out)).join('\n'))
      break
    }
    case 'list': {
      const file = positional[0]
      if (!file) throw new Error('usage: sightline list <businesses.json>')
      const out = flag('--out', 'out')
      const audits = await auditMany(loadJson(file), { outDir: out })
      console.log('\n' + callList(audits) + '\n')
      writeFileSync(`${out}/call-list.json`, JSON.stringify(audits.map(a => ({ ...a, measurement: undefined })), null, 2))
      console.log((await writeReports(audits, out)).join('\n'))
      break
    }
    case 'score': {
      const m = loadJson(positional[0])
      const r = score(m)
      console.log(JSON.stringify({ score: r.score, findings: r.findings }, null, 2))
      break
    }
    case 'explain':
      console.log(explain(loadJson(positional[0])))
      break
    default:
      console.log(HELP)
      process.exit(cmd ? 2 : 0)
  }
} catch (e) {
  console.error(`\x1b[31m${e.message}\x1b[0m`)
  process.exit(1)
}
