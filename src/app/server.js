// The front door.
//
// The CLI is the better tool for a list of fifteen businesses. It is the wrong tool for showing
// someone what this does: nobody leans forward at a terminal. This is a local page — paste a URL,
// watch it work, read the report where it appears.
//
// Local only. It binds to 127.0.0.1, serves nothing outside the run folder, and holds no state
// beyond the jobs in this process.

import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { auditOne, callList, tidyScreenshots, writeReports } from '../cli/run.js'
import { rank } from '../score/index.js'
import { runFolder, HOME_FOLDER } from '../cli/paths.js'

const here = dirname(fileURLToPath(import.meta.url))
const TYPES = { '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.json': 'application/json',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.css': 'text/css', '.js': 'text/javascript' }

const jobs = new Map()
let nextId = 1

function send (res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

/** Serve a file, but only from inside the reports folder. */
function serveReport (res, relPath) {
  const full = resolve(HOME_FOLDER, decodeURIComponent(relPath))
  // Path traversal guard: the resolved path must still sit under the reports folder.
  if (!full.startsWith(resolve(HOME_FOLDER) + sep)) return send(res, 403, { error: 'outside the reports folder' })
  if (!existsSync(full) || !statSync(full).isFile()) return send(res, 404, { error: 'not found' })
  res.writeHead(200, { 'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream' })
  res.end(readFileSync(full))
}

async function runJob (job, businesses, preparedBy) {
  job.total = businesses.length
  const audits = []
  const out = runFolder(businesses.length === 1 ? businesses[0].name : 'batch')
  job.folder = out
  for (const [i, b] of businesses.entries()) {
    job.current = b.name
    job.done = i
    try {
      const a = await auditOne(b, { outDir: out, preparedBy })
      audits.push(a)
      job.results.push({ name: b.name, url: b.url, score: a.score.overall, band: a.score.band, hook: a.score.hook })
    } catch (e) {
      job.results.push({ name: b.name, url: b.url, score: null, band: 'error', hook: e.message.split('\n')[0] })
    }
  }
  job.done = businesses.length
  if (audits.length) {
    const ranked = rank(audits)
    await writeReports(ranked, out)
    tidyScreenshots(out)
    job.table = callList(ranked)
    job.files = ranked.map(a => ({
      name: a.business.name,
      html: `${a.business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.html`,
      pdf: `${a.business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pdf`
    }))
  }
  job.state = 'done'
}

export function serve ({ port = 5177, preparedBy, exitWhenIdle = false } = {}) {
  // When launched from the app icon there is no terminal to press Ctrl-C in, so the page holds
  // the server open and letting go of it shuts the server down. The off-switch is closing the tab,
  // which is the one a person already knows.
  let lastSeen = Date.now()
  const IDLE_MS = 25_000
  let idleTimer = null
  if (exitWhenIdle) {
    idleTimer = setInterval(() => {
      if (Date.now() - lastSeen > IDLE_MS) { console.log('page closed — shutting down'); process.exit(0) }
    }, 5_000)
    idleTimer.unref?.()
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)

    lastSeen = Date.now()

    if (url.pathname === '/') return send(res, 200, readFileSync(join(here, 'index.html')), TYPES['.html'])
    if (url.pathname === '/api/alive') return send(res, 200, { ok: true })

    if (url.pathname === '/api/audit' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed
      try { parsed = JSON.parse(body) } catch { return send(res, 400, { error: 'bad request' }) }
      const businesses = (parsed.businesses || []).filter(b => b && b.url).slice(0, 40)
      if (!businesses.length) return send(res, 400, { error: 'give me at least one website address' })
      const job = { id: String(nextId++), state: 'running', done: 0, total: businesses.length, current: null, results: [], folder: null }
      jobs.set(job.id, job)
      runJob(job, businesses, parsed.preparedBy || preparedBy).catch(e => { job.state = 'failed'; job.error = e.message })
      return send(res, 200, { id: job.id })
    }

    if (url.pathname.startsWith('/api/job/')) {
      const job = jobs.get(url.pathname.split('/').pop())
      return job ? send(res, 200, job) : send(res, 404, { error: 'no such job' })
    }

    if (url.pathname.startsWith('/reports/')) return serveReport(res, url.pathname.slice('/reports/'.length))

    send(res, 404, { error: 'not found' })
  })

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${port}` }))
  })
}
