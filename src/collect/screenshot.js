import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isRendering } from '@alexpower/rig/harness/hittest.js'

/**
 * Capture a PNG, but only from a tab that is actually painting.
 *
 * A backgrounded or occluded tab renders nothing, and Chrome will still hand you an image for it —
 * a white rectangle, or the last frame from before it was hidden. That picture then goes into a
 * document a business owner reads as evidence about their own site. So the render check comes
 * first and a failure returns null rather than a lie.
 */
export async function capture (page, { outDir, name, clip = null, scale = 1 }) {
  if (!(await isRendering(page))) return { path: null, skipped: 'tab was not rendering' }
  await mkdir(outDir, { recursive: true })
  const params = { format: 'png', captureBeyondViewport: !!clip, optimizeForSpeed: false }
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale }
  const shot = await page.send('Page.captureScreenshot', params)
  const buf = Buffer.from(shot.data, 'base64')
  const path = join(outDir, `${name}.png`)
  await writeFile(path, buf)
  return { path, bytes: buf.length, ...pngSize(buf) }
}

/** A stable, filesystem-safe stem for one site, so two audits in one directory cannot collide. */
export function stemFor (url) {
  let host = 'site'
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep the default */ }
  const safe = host.replace(/[^a-z0-9.-]/gi, '-').slice(0, 48)
  return `${safe}-${createHash('sha1').update(String(url)).digest('hex').slice(0, 8)}`
}

/** Read width and height straight out of the PNG header — enough to prove a capture is real. */
export function pngSize (buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
