// Everything the document needs, turned into text that can live inside a single .html file.
//
// The finished report gets emailed, printed, and opened months later on a laptop in a truck. So it
// carries its own fonts and its own screenshots: no <link>, no <img src>, no network. The cost is
// a fat HTML string; the benefit is that it cannot degrade after we hand it over.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_DIR = resolve(here, '..', '..', 'templates')

/** TTF, never woff2 — headless print silently falls back to Times on a woff2 it cannot decode. */
const FACES = [
  { family: 'Public Sans', weight: 400, file: 'PublicSans-400.ttf' },
  { family: 'Public Sans', weight: 600, file: 'PublicSans-600.ttf' },
  { family: 'Public Sans', weight: 700, file: 'PublicSans-700.ttf' },
  { family: 'Source Serif 4', weight: 600, file: 'SourceSerif4-600.ttf' },
  { family: 'IBM Plex Mono', weight: 400, file: 'IBMPlexMono-400.ttf' }
]

let fontCssCache = null

/** @returns {string} @font-face rules with every face inlined as base64 TTF. */
export function fontCss () {
  if (fontCssCache) return fontCssCache
  const rules = FACES.map(f => {
    const path = join(TEMPLATE_DIR, 'fonts', f.file)
    const b64 = readFileSync(path).toString('base64')
    return `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};` +
           `font-display:block;src:url(data:font/ttf;base64,${b64}) format("truetype")}`
  })
  fontCssCache = rules.join('\n')
  return fontCssCache
}

let sheetCache = null

export function stylesheet () {
  if (sheetCache == null) sheetCache = readFileSync(join(TEMPLATE_DIR, 'report.css'), 'utf8')
  return sheetCache
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/**
 * A screenshot path off a Measurement, as a data URI.
 *
 * Returns null for every way this can go wrong — path absent, file gone, zero bytes, unreadable.
 * A missing screenshot must degrade to "we did not capture one", never to a broken image icon in
 * a document sitting in front of a client.
 *
 * @param {string|null|undefined} path
 * @param {{maxBytes?:number}} [opts]
 * @returns {string|null}
 */
export function imageDataUri (path, { maxBytes = 12 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !path.trim()) return null
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return null
    const ext = path.split('.').pop().toLowerCase()
    const mime = MIME[ext]
    if (!mime) return null
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`
  } catch {
    return null
  }
}
