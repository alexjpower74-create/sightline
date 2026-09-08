import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

// Reports go somewhere a person would look for them, not into an `out/` folder beside the code.
// You should never have to be told where your own files went.
export const HOME_FOLDER = join(homedir(), 'Documents', 'Sightline')

/** A dated folder per run, so successive runs do not silently overwrite each other. */
export function runFolder (label, at = new Date()) {
  const day = at.toISOString().slice(0, 10)
  const clean = (label || 'audit').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim()
  let dir = join(HOME_FOLDER, `${clean} - ${day}`)
  // Two runs of the same list on the same day are two different runs. Keep both.
  if (existsSync(dir)) {
    let n = 2
    while (existsSync(`${dir} (${n})`)) n++
    dir = `${dir} (${n})`
  }
  mkdirSync(dir, { recursive: true })
  return dir
}
