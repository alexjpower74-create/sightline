import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

// Reports go somewhere a person would look for them, not into an `out/` folder beside the code.
// You should never have to be told where your own files went.
// SIGHTLINE_HOME moves the tree, so a test never has to write into a real Documents folder.
export const HOME_FOLDER = process.env.SIGHTLINE_HOME || join(homedir(), 'Documents', 'Sightline')

// The app files each tool's runs under its own name, and an audit from this command line is the
// same kind of thing as an audit from the window. Both land in one place or neither is findable.
export const AUDITS_FOLDER = join(HOME_FOLDER, 'Audits')

/** A dated folder per run, so successive runs do not silently overwrite each other. */
export function runFolder (label, at = new Date()) {
  const day = at.toISOString().slice(0, 10)
  const clean = (label || 'audit').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim()
  let dir = join(AUDITS_FOLDER, `${clean} - ${day}`)
  // Two runs of the same list on the same day are two different runs. Keep both.
  if (existsSync(dir)) {
    let n = 2
    while (existsSync(`${dir} (${n})`)) n++
    dir = `${dir} (${n})`
  }
  mkdirSync(dir, { recursive: true })
  return dir
}
