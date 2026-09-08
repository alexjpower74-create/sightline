// The words the document says out loud.
//
// Kept apart from the layout because this is the part a shop will argue about, and because
// every string here is read by someone who did not ask for a website audit. The rule for anything
// on page 1: if an owner would have to search for a word, it does not belong in it.

import { AREAS, SEVERITY } from '../contract.js'

/**
 * The headline for a site that is doing fine.
 *
 * `score.hook` is the worst finding restated, which is the right headline for a bad site and the
 * wrong one for a good one — leading a 97/100 report with "2 of your pictures are missing a
 * written description" makes the document sound like it went looking for trouble. A strong band
 * says so plainly and lets the hook fall into the list underneath.
 */
export const STRONG_HEADLINE = 'This site is in good shape, and that is not the usual answer.'

/** Second line: what the shop is actually proposing. Strong sites get an honest "not much". */
export const BAND_FOLLOWUP = {
  strong: 'Nothing below is urgent. The notes overleaf are refinements, not repairs, and you should feel free to ignore them.',
  fair:   'A short list of fixes would move most of this, and none of it needs a rebuild.',
  weak:   'The problems below are fixable, but they are not cosmetic — they change how the site behaves for a visitor.',
  urgent: 'These are not cosmetic problems, and we would not recommend patching around them. Page 2 has the detail.'
}

/** Fallback only. `score.line` from the scorer is the phrase we print; this covers a missing one. */
export const BAND_LINE = {
  strong: 'in good shape',
  fair:   'workable, with real gaps',
  weak:   'costing you enquiries',
  urgent: 'losing you business today',
  unreachable: 'not responding'
}

/** Severity as a word an owner reads, not a colour they interpret. */
export const SEVERITY_LABEL = {
  [SEVERITY.CRITICAL]: 'Critical',
  [SEVERITY.MAJOR]: 'Major',
  [SEVERITY.MINOR]: 'Minor',
  [SEVERITY.GOOD]: 'Working'
}

/** Worst first, everywhere. One ordering, used by findings, sections and area bars alike. */
export const SEVERITY_RANK = {
  [SEVERITY.CRITICAL]: 0, [SEVERITY.MAJOR]: 1, [SEVERITY.MINOR]: 2, [SEVERITY.GOOD]: 3
}

/** Effort in time a person can picture, not in story points. */
export const EFFORT_LABEL = {
  quick: 'Under an hour',
  moderate: 'Half a day to a day',
  rebuild: 'Needs a rebuild'
}

export function areaLabel (key) {
  return AREAS[key]?.label ?? key
}

export function areaWeightPct (key) {
  const w = AREAS[key]?.weight
  return w == null ? null : Math.round(w * 100)
}

/** What each area means, for the bar legend. The owner has never heard the word "viewport". */
export const AREA_MEANING = {
  performance:   'How long someone waits before they see anything.',
  mobile:        'What the site does on a phone, which is where most people will open it.',
  // Deliberately says "the barriers we check for". A score out of 100 beside the word
  // "accessibility" reads as a percentage of a standard to anyone who has been sent a procurement
  // questionnaire, and this tool checks eight specific things — it is not a conformance audit and
  // must never be mistaken for one.
  accessibility: 'The barriers we check for — a screen reader, a keyboard, a bad screen. Not a conformance audit.',
  seo:           'Whether search engines can tell what the business does and where it is.',
  trust:         'The signals that tell a visitor the site is current and safe to use.'
}

/**
 * Page 1 when there is no score.
 *
 * Three different things put us here and they are not the same thing, so they must not read the
 * same way. A site that is genuinely down is the owner's problem and an urgent one. A site that
 * turned our checker away is not a fault at all. A check that fell over on our end is OUR problem,
 * and writing it up as theirs is how this tool told a real business its working site was down.
 *
 * The rule for the last two: the failure goes on us, in the first sentence, in plain words.
 */
const NO_SCORE = {
  unreachable: m => ({
    accent: true,
    headline: 'We could not reach this site.',
    body: `Every request we made to ${m?.url ?? 'the address'} failed (${m?.error || 'no response'}). That is not a slow site or a bad score — as far as the outside world is concerned, there is nothing there.`,
    consequence: 'Anyone who types the address in, clicks it from a search result, or taps it on a business card gets an error page. So does Google.',
    next: 'Before anything else, someone needs to check whether the domain is still registered and whether the hosting is still being paid for. Nothing else on a website matters until this is answered.',
    noScore: 'We have deliberately not given this site a score. There was nothing to measure, and a number here would be invented.',
    attemptLabel: 'Result',
    appendix: 'Not measured — the site did not respond, so every field here would be a zero we invented.'
  }),

  blocked: m => ({
    accent: false,
    headline: 'This site turned our checker away.',
    body: 'Your website has protection that refuses automated visitors, and it refused ours along with the rest. That is often a deliberate and sensible setting.',
    consequence: 'This says nothing about how your site behaves for a real customer. Ordinary visitors are not affected by it, and none of what follows should be read as a criticism of the site.',
    next: 'This one has to be checked by hand rather than by the tool. It is a few minutes of someone opening the site on a phone and a laptop and going through the same list.',
    noScore: 'There is no score here because we were not able to measure anything. Scoring a site we could not read would be guesswork wearing a number.',
    attemptLabel: 'Response',
    appendix: 'Not measured — the site declined to be read by an automated visitor.'
  }),

  'not-checked': m => ({
    accent: false,
    headline: 'Our check did not finish.',
    body: `Something went wrong at our end while reading this site (${m?.error || 'checker failed'}). The site itself answers an ordinary request normally.`,
    consequence: 'Nothing on this page is a finding about your website. We are telling you the check failed rather than quietly sending you a report built on a failure.',
    next: 'We will run it again. Until then nobody should draw any conclusion about this site from this document, in either direction.',
    noScore: 'There is no score because our own check failed, not because anything is wrong with the site. A number here would be our error presented as your problem.',
    attemptLabel: 'Our error',
    appendix: 'Not measured — our checker did not complete. This is a gap in our data, not a finding about the site.'
  })
}

/** @param {string} band @param {object} measurement */
export function noScoreCopy (band, measurement) {
  const make = NO_SCORE[band] || NO_SCORE.unreachable
  return make(measurement)
}

/** Human byte and millisecond formatting. Used in evidence, so it must never say "NaN". */
export function bytes (n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function ms (n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—'
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`
}

export function count (n) {
  return typeof n === 'number' && isFinite(n) ? String(n) : '—'
}

export function yesNo (v) {
  return v === true ? 'Yes' : v === false ? 'No' : '—'
}

export function shortDate (iso) {
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
}
