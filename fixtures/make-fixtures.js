// Fixtures exist so the report slice and the score slice can work before the collector is finished.
// They are generated from the contract, so a field added there shows up here rather than drifting.
import { emptyMeasurement, assertMeasurement } from '../src/contract.js'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))

/** A real-shaped bad site: a 2014 brochure build that has never been touched. */
const neglected = { ...emptyMeasurement('http://example-construction.ca'), ok: true,
  finalUrl: 'http://example-construction.ca/',
  timing: { ttfbMs: 1840, domContentLoadedMs: 6200, loadMs: 11400 },
  weight: { totalBytes: 14_800_000, requests: 118, imageBytes: 13_100_000, scriptBytes: 940_000,
            largestImage: { url: '/img/hero-full.jpg', bytes: 4_600_000 } },
  https: { enabled: false, redirectsToHttps: false, mixedContent: [], certificateProblem: null },
  mobile: { hasViewportMeta: false, viewportContent: null, horizontalOverflowPx: 412, tapTargetsUnder44: 17, smallestTapTargetPx: 18,
            overflowCulprit: { selector: 'table.pricing', widthPx: 900, pastPx: 510 } },
  a11y: { imagesMissingAlt: 24, imagesTotal: 31, inputsMissingLabel: 5, headingOrderBreaks: 3,
          hasMainLandmark: false, hasSkipLink: false, htmlLangSet: false, lowContrastNodes: 12 },
  seo: { title: 'Home', titleLength: 4, metaDescription: null, metaDescriptionLength: 0, h1Count: 0,
         canonical: null, hasRobotsTxt: false, hasSitemap: false, ogTags: [], structuredDataTypes: [] },
  freshness: { copyrightYear: 2014, generator: 'WordPress 4.1', lastModified: '2014-08-19T00:00:00Z',
               brokenLinks: [{ url: '/services/roofing', status: 404 }, { url: '/contact-us.html', status: 404 }] }
}

/** A decent site, so the scorer is not only ever exercised on disasters. */
const solid = { ...emptyMeasurement('https://example-tours.ca'), ok: true,
  finalUrl: 'https://example-tours.ca/',
  timing: { ttfbMs: 210, domContentLoadedMs: 900, loadMs: 1650 },
  weight: { totalBytes: 1_240_000, requests: 34, imageBytes: 860_000, scriptBytes: 180_000,
            largestImage: { url: '/img/hero.webp', bytes: 240_000 } },
  https: { enabled: true, redirectsToHttps: true, mixedContent: [], certificateProblem: null },
  mobile: { hasViewportMeta: true, viewportContent: 'width=device-width, initial-scale=1', horizontalOverflowPx: 0, tapTargetsUnder44: 1, smallestTapTargetPx: 40, overflowCulprit: null },
  a11y: { imagesMissingAlt: 2, imagesTotal: 18, inputsMissingLabel: 0, headingOrderBreaks: 0,
          hasMainLandmark: true, hasSkipLink: false, htmlLangSet: true, lowContrastNodes: 1 },
  seo: { title: 'Boat Tours in Central Newfoundland | Example Tours', titleLength: 49,
         metaDescription: 'Half-day and full-day iceberg and whale tours departing daily from central Newfoundland.', metaDescriptionLength: 88,
         h1Count: 1, canonical: 'https://example-tours.ca/', hasRobotsTxt: true, hasSitemap: true,
         ogTags: ['og:title', 'og:description', 'og:image'], structuredDataTypes: ['LocalBusiness'] },
  freshness: { copyrightYear: 2026, generator: null, brokenLinks: [], lastModified: '2026-06-02T00:00:00Z' }
}

/** A site that is simply down. Every stage has to survive this without throwing. */
const unreachable = { ...emptyMeasurement('https://example-gone.ca'), ok: false, error: 'ENOTFOUND', unreachableReason: 'dns' }

/** Bot protection turned our checker away. Reported completely differently from "down". */
const blocked = { ...emptyMeasurement('https://example-guarded.ca'), ok: false,
  error: 'HTTP 403 from https://example-guarded.ca', unreachableReason: 'blocked' }

for (const [name, m] of Object.entries({ neglected, solid, unreachable, blocked })) {
  if (m.ok) assertMeasurement(m)
  writeFileSync(join(here, `${name}.json`), JSON.stringify(m, null, 2) + '\n')
  console.log('wrote fixtures/' + name + '.json')
}

writeFileSync(join(here, 'businesses.sample.json'), JSON.stringify([
  { name: 'Example Construction', url: 'http://example-construction.ca', town: 'Grand Falls-Windsor', sector: 'construction' },
  { name: 'Example Tours', url: 'https://example-tours.ca', town: 'Twillingate', sector: 'tourism' },
  { name: 'Example Gone', url: 'https://example-gone.ca', town: 'Springdale', sector: 'retail' },
  { name: 'Example Guarded', url: 'https://example-guarded.ca', town: 'Botwood', sector: 'retail' }
], null, 2) + '\n')
console.log('wrote fixtures/businesses.sample.json')
