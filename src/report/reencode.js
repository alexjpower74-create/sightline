#!/usr/bin/env node
// Re-encode one image to a JPEG with sharp: `node reencode.js <in> <out> <width|0> <quality>`.
//
// A separate process on purpose. `image()` in assets.js is synchronous all the way up to the
// renderer, and sharp is async-only; on macOS the same job is a synchronous `sips` child, so this
// is the identical shape with a different encoder inside. Width 0 means "do not scale".
import sharp from 'sharp'

const [input, output, width, quality] = process.argv.slice(2)
const w = Number(width)
let img = sharp(input)
if (w > 0) img = img.resize({ width: w, withoutEnlargement: true })
await img.jpeg({ quality: Number(quality) }).toFile(output)
