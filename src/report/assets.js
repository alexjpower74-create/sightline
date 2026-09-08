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
 * PNG pixel dimensions, straight out of the IHDR chunk.
 *
 * The report needs these before it can lay out: a tall phone capture belongs in a narrow rail
 * beside the text, and a wide one has to go full width or it arrives on the page four centimetres
 * across and persuades nobody. Guessing the aspect from the filename is how you end up with the
 * wrong one. PNG only — that is what the collector writes — and null for anything else, which the
 * caller treats as "unknown aspect" rather than as an error.
 *
 * @param {Buffer} buf
 * @returns {{width:number, height:number}|null}
 */
export function pngSize (buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  for (let i = 0; i < SIG.length; i++) if (buf[i] !== SIG[i]) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!width || !height) return null
  return { width, height }
}

/**
 * A screenshot path off a Measurement, as a data URI plus its dimensions.
 *
 * Returns null for every way this can go wrong — path absent, file gone, zero bytes, too big,
 * unreadable, not an image type we know. A missing screenshot has to degrade to "we did not
 * capture one", never to a broken image icon in a document sitting in front of a client.
 *
 * @param {string|null|undefined} path
 * @param {{maxBytes?:number}} [opts]
 * @returns {{src:string, width:number|null, height:number|null, portrait:boolean}|null}
 */
export function image (path, { maxBytes = 12 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !path.trim()) return null
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return null
    const mime = MIME[path.split('.').pop().toLowerCase()]
    if (!mime) return null
    const buf = readFileSync(path)
    const size = pngSize(buf)
    return {
      src: `data:${mime};base64,${buf.toString('base64')}`,
      width: size?.width ?? null,
      height: size?.height ?? null,
      // Unknown aspect is treated as portrait: the rail crops gracefully, the full-width band
      // does not, so the safe guess is the one that cannot produce a stretched hero image.
      portrait: size ? size.height >= size.width * 1.2 : true
    }
  } catch {
    return null
  }
}
