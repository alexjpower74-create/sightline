// Contrast is the finding most likely to be wrong in a way nobody notices until a client does.
// Every check here therefore has to answer two questions: does it see the failure it should, and
// does it refuse the ones it cannot resolve?
//
// What would make each check red is written above it. Each `breaks` makes it red for real.

import { suite } from '@alexpower/rig/harness/check.js'
import { launch } from '@alexpower/rig/harness/cdp.js'
import { startServer } from './server.js'
import { evalFn, a11yScript } from './page-scripts.js'

const server = await startServer()
const browser = await launch({ headless: true, port: 9351 })
const page = await browser.newPage(server.url('/contrast.html'), { width: 1440, height: 900, dpr: 1, mobile: false })

const read = () => evalFn(page, a11yScript, {})
// Full sample text, not a prefix: truncating this to 12 characters once made two checks below
// unable to see the very node they claimed to watch, and the harness marked them VOID for it.
const ids = async () => (await read()).contrastSamples.map(s => s.text)

/** Inject a stylesheet, and hand back the undo. Restyling is the only honest way to break a
 *  colour measurement — assigning to a global would leave the page exactly as it was. */
async function restyle (css) {
  await page.eval(`(() => {
    const s = document.createElement('style'); s.id = '__control'; s.textContent = ${JSON.stringify(css)}
    document.head.appendChild(s)
  })()`)
  return () => page.eval('document.getElementById("__control")?.remove()')
}

await suite('contrast walk', async t => {

  // RED IF: the walk counted a node it should not have, or missed one of the two real failures.
  await t.check('finds exactly the two nodes that genuinely fail AA', {
    assert: async () => (await read()).lowContrastNodes === 2,
    breaks: () => restyle('#pass-black { color: #f4f4f4 }')
  })

  // RED IF: the count is right by luck — the wrong two nodes.
  await t.check('the two are the pale paragraph and the small grey one', {
    assert: async () => {
      const s = await ids()
      return s.length === 2 && s.some(t => t.startsWith('Nearly')) && s.some(t => t.startsWith('Small grey'))
    },
    breaks: () => restyle('#fail-pale { color: #000 }')
  })

  // RED IF: the walk stops at the first ancestor with a colour. #pass-composited sits on a 92%
  // white veil over a black panel; read the black and you report a failure that is not there.
  await t.check('composites a translucent ancestor instead of stopping at the first colour', {
    assert: async () => !(await ids()).some(t => t.startsWith('Dark text')),
    breaks: () => restyle('.veil { background: rgba(255, 255, 255, 0.04) }')
  })

  // RED IF: 3:1 for large text is not applied — the 30px grey would be counted as a failure.
  await t.check('large text is judged at 3:1, not 4.5:1', {
    assert: async () => !(await ids()).some(t => t.startsWith('Large grey')),
    breaks: () => restyle('#pass-gray-large { font-size: 14px }')
  })

  // RED IF: bold 19px is not treated as large text.
  await t.check('bold 19px counts as large text', {
    assert: async () => !(await ids()).some(t => t.startsWith('Bold nineteen')),
    breaks: () => restyle('#pass-gray-bold { font-weight: 400 }')
  })

  // RED IF: we guess at a background we cannot sample. White text over a gradient would read as a
  // failure against a default white, which is a finding invented out of nothing.
  await t.check('refuses to judge text over a background image', {
    assert: async () => {
      const r = await read()
      return r.contrastUnresolved >= 2 && !r.contrastSamples.some(s => s.text.startsWith('White text'))
    },
    breaks: () => restyle('.photo { background-image: none; background-color: #fff }')
  })

  // RED IF: a partly transparent group is judged at full opacity.
  await t.check('refuses to judge text inside a half-transparent group', {
    assert: async () => !(await ids()).some(t => t.startsWith('Text inside')),
    breaks: () => restyle('.faded { opacity: 1 }')
  })

  // RED IF: invisible screen-reader text is measured. It is never seen, so it can never fail.
  await t.check('skips visually hidden text entirely', {
    assert: async () => !(await ids()).some(t => t.startsWith('Screen reader')),
    breaks: () => restyle('.sr-only { position: static; width: auto; height: auto; clip-path: none }')
  })
})

await page.close()
await browser.close()
await server.close()
process.exit(process.exitCode || 0)
