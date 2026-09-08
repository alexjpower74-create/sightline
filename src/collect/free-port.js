import { createServer } from 'node:net'

/**
 * An ephemeral port the OS just told us is free.
 *
 * Chrome's remote debugging port was a fixed number, which works right up until two collectors run
 * at once — then the second `launch()` finds an endpoint already answering on that port, quietly
 * attaches to the FIRST browser, and the two runs share one Chrome until whichever finishes first
 * closes it out from under the other. That failure looks like a test flake and is not one: a CLI
 * auditing a list of sites in parallel would hit it on real work.
 */
export function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}
