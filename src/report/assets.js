// Everything the document needs, turned into text that can live inside a single .html file.
//
// The finished report gets emailed, printed, and opened months later on a laptop in a truck. So it
// carries its own fonts and its own screenshots: no <link>, no <img src>, no network. The cost is
// a fat HTML string; the benefit is that it cannot degrade after we hand it over.

import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

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

/* ── screenshot compression ───────────────────────────────────────────────────────────────── */

// Screenshots are re-encoded on the way into the document, and this is the difference between a
// report a shop can email and one that bounces.
//
// The measured problem: 15 live audits averaged 6.7 MB of PDF and 7.9 MB of HTML, topping out at
// 12.2 MB. Most mail servers reject attachments over 10 MB and plenty of corporate ones stop at 5.
// A report that bounces, or that arrives apologising for its own size, undoes exactly the
// credibility the document exists to build.
//
// Two causes, both ours rather than the collector's. PNG is the wrong format for a photograph of a
// web page — continuous-tone content, gradients, antialiased text — and costs 15x over JPEG on
// real content (measured: a 5.9 MB PNG becomes 380 KB at q75). And the captures carry three to
// five times more pixels than the page can print: a shot printed 54mm wide needs about 640px at
// 300dpi, not 2880.
//
// The originals on disk are never touched. They are the evidence; how a document chooses to
// present them is a rendering decision, and rendering decisions belong to this slice.

const CACHE = join(tmpdir(), 'sightline-img-cache')

/** Whether sips is usable. macOS-only, so the answer is allowed to be no. */
let sipsOk = null
function haveSips () {
  if (sipsOk === null) {
    try { execFileSync('/usr/bin/sips', ['--help'], { stdio: 'ignore' }); sipsOk = true }
    catch { sipsOk = false }
  }
  return sipsOk
}

/**
 * Re-encode a screenshot to a JPEG, scaled down to the size the page can actually print.
 *
 * Scaled, never cropped. Cropping the long tail off a phone capture was the obvious saving and it
 * is not worth what it costs: sips crops from the centre, `--cropOffset 0 0` is silently ignored
 * on this version, and the result threw away the top of the page — the hero, the header, the one
 * screenful that persuades anybody — and embedded the middle instead. It was measured, and it was
 * unmistakable. The CSS already crops to the top correctly at the frame, and keeping the whole
 * page costs little: a 780 x 6752 capture is 318 KB as a 760-wide JPEG.
 *
 * The pixel ceiling exists for pathological pages, and it works by scaling the width down rather
 * than by discarding rows, so no part of the evidence is ever thrown away silently. It will not go
 * below MIN_WIDTH: the phone shot prints 54mm wide, and past a certain point the sideways-overflow
 * evidence stops being legible on an office printer, which is the one thing this must not do.
 *
 * Returns null rather than throwing on any failure. A screenshot that cannot be compressed is
 * still worth embedding uncompressed — a big report beats a missing one.
 *
 * @returns {{path:string, mime:string}|null}
 */
const MAX_PIXELS = 6_000_000
const MIN_WIDTH = 560

function compressed (path, srcSize, { maxWidth, quality }) {
  if (!haveSips()) return null
  try {
    const st = statSync(path)
    const key = createHash('sha1')
      .update(`${resolve(path)}|${st.mtimeMs}|${st.size}|${maxWidth}|${quality}|v2`)
      .digest('hex').slice(0, 16)
    mkdirSync(CACHE, { recursive: true })
    const out = join(CACHE, `${key}.jpg`)
    if (existsSync(out) && statSync(out).size > 0) return { path: out, mime: 'image/jpeg' }

    let width = maxWidth
    if (srcSize) {
      width = Math.min(srcSize.width, maxWidth)
      const aspect = srcSize.height / srcSize.width
      if (width * width * aspect > MAX_PIXELS) {
        width = Math.max(MIN_WIDTH, Math.floor(Math.sqrt(MAX_PIXELS / aspect)))
      }
    }

    const args = []
    if (!srcSize || srcSize.width > width) args.push('--resampleWidth', String(width))
    args.push('-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), path, '--out', out)

    execFileSync('/usr/bin/sips', args, { stdio: 'ignore' })
    if (!existsSync(out) || statSync(out).size === 0) return null
    return { path: out, mime: 'image/jpeg' }
  } catch {
    return null
  }
}

/**
 * A screenshot path off a Measurement, as a data URI plus its dimensions.
 *
 * Returns null for every way this can go wrong — path absent, file gone, zero bytes, too big,
 * unreadable, not an image type we know. A missing screenshot has to degrade to "we did not
 * capture one", never to a broken image icon in a document sitting in front of a client.
 *
 * @param {string|null|undefined} path
 * @param {{maxBytes?:number, maxWidth?:number, quality?:number, compress?:boolean}} [opts]
 * @returns {{src:string, width:number|null, height:number|null, portrait:boolean,
 *           bytes:number, compressed:boolean}|null}
 */
export function image (path, opts = {}) {
  const {
    maxBytes = 24 * 1024 * 1024,
    maxWidth = 1400,
    quality = 78,
    compress = true
  } = opts
  if (typeof path !== 'string' || !path.trim()) return null
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return null
    let mime = MIME[path.split('.').pop().toLowerCase()]
    if (!mime) return null

    // The source's own dimensions decide the layout, and they are read before any re-encoding —
    // scaling does not change an aspect ratio, and portrait-vs-wide is the only thing the layout
    // needs from them.
    const size = pngSize(readFileSync(path))

    let readFrom = path
    let didCompress = false
    if (compress) {
      const c = compressed(path, size, { maxWidth, quality })
      if (c) { readFrom = c.path; mime = c.mime; didCompress = true }
    }
    const buf = readFileSync(readFrom)

    return {
      src: `data:${mime};base64,${buf.toString('base64')}`,
      width: size?.width ?? null,
      height: size?.height ?? null,
      // Unknown aspect is treated as portrait: the rail crops gracefully, the full-width band
      // does not, so the safe guess is the one that cannot produce a stretched hero image.
      portrait: size ? size.height >= size.width * 1.2 : true,
      bytes: buf.length,
      compressed: didCompress
    }
  } catch {
    return null
  }
}
