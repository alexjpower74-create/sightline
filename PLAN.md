# Sightline — build contract

A website audit engine aimed at one job: let a two-person web shop walk into a small business and
show the owner, in their own language, what their current site is costing them.

Its output is not a Lighthouse dump. It is **a page a business owner reads and a page a developer
acts on**, plus a ranked call list so the shop knows who to phone first.

Target user: Example Web Studio. Their clients are NL construction firms, tourism operators,
realtors, clinics and nonprofits. Several are public-sector adjacent, so **accessibility findings
are contract-relevant, not decoration**.

## Rules

- You own the files listed under your id and **nothing else**. Need a change elsewhere? Say so in
  your report. `rig guard --base main` refuses the commit anyway.
- `src/contract.js` is owned by **vera** and is the seam between all three slices. If you need a
  field, ask — do not add one. A quietly-added field is the defect that costs the most to find.
- Work against `fixtures/*.json`. Nobody waits for anybody: the report slice can render a finished
  audit today, and the collector can be checked against the same shapes.
- Verify, then commit, then report. `git commit -- <your paths>`. Never leave a verified step
  uncommitted — a usage pause lands mid-task with no warning.
- **A check that cannot fail measured nothing.** Use `rig`'s harness (`../rig/harness/index.js`):
  `check(name, { assert, breaks })` runs your assertion against the real thing and against a
  deliberately broken one. If it passes both, it is VOID and the run fails. Say what would make
  each check red, then make it red once.
- Real input only. If you drive a page, use the harness's `wheel`/`tap`/`click`, never `scrollTo`
  and never a synthetic Event. Hit-test with `isHittable`, never `getBoundingClientRect`.
- Never grade the shared tree. `rig qa --ref <sha>` gives you a worktree pinned to a commit.

## Agents

### c1 — Collector
Owns:
- src/collect/**

Task:
Visit a site and fill in a `Measurement` exactly as `src/contract.js` defines it. Use the rig's CDP
client (`../rig/harness/cdp.js`) — real Chrome, so you measure what a visitor gets, not what a
fetch of the HTML suggests.

Export `collect(url, opts) -> Measurement`. Requirements:
- Measure at **two viewports**: 1440x900 desktop and 390x844 mobile (`dpr: 3, mobile: true`).
  `mobile.*` fields come from the mobile pass; `timing`/`weight` from desktop.
- `weight` comes from real network events (`Network.enable`, `Network.responseReceived` +
  `Network.loadingFinished`), not from guessing at the HTML.
- `mobile.horizontalOverflowPx` = how far the page scrolls sideways at 390px. This is the single
  most visceral finding for an owner holding a phone; get it right.
- `mobile.tapTargetsUnder44` counts links and buttons whose box is under 44 CSS px. Use the
  harness's `meetsTouchTarget` idea, and count only elements that are actually visible.
- `a11y.lowContrastNodes`: computed colour vs background, WCAG AA (4.5:1 normal, 3:1 large).
  Getting the effective background right through transparent ancestors is the hard part — walk up
  until you hit a non-transparent one, and if you genuinely cannot resolve it, do not count the
  node. **A false accessibility finding in a pitch is worse than a missed one.**
- `freshness.brokenLinks`: HEAD each same-origin link found on the page, cap at 40, 5s timeout.
- Screenshots: write PNGs to `opts.outDir` and put the paths in `screenshots`. Never return a
  screenshot of a backgrounded tab — check `isRendering(page)` first.
- Every site must survive: dead domain, redirect loop, 500, a page that never fires `load`,
  and one that is 40MB. Cap total time per site (`opts.timeoutMs`, default 45s) and return a
  `Measurement` with `ok:false` and a real `error` rather than throwing.
- Tests in `src/collect/*.test.js` — serve local HTML fixtures you write under `src/collect/`,
  never the live internet. A test that depends on someone else's website is not a test.

Report to `docs/build-report-c1.md` — a tracked file. Commit it with your work.

### c2 — Report
Owns:
- src/report/**
- templates/**

Task:
Turn one `Audit` (see `src/contract.js`) into a document a web shop can hand to a business owner.
Export `renderHtml(audit) -> string` and `renderPdf(audit, outPath) -> Promise<string>`.

Requirements:
- **Two audiences, one document.** Page 1 is the owner: the score, the hook sentence, and the three
  findings that cost them money, in plain English with no jargon. Page 2+ is the developer: every
  finding with its evidence and effort estimate.
- **Print aesthetic: white ground, ink only in type, rules and small accents.** This gets printed
  on an office printer. No full-bleed dark panels, no giant colour blocks.
- Screenshots from `measurement.screenshots` go in as evidence — the owner's own site, on a phone,
  overflowing sideways, is the most persuasive thing in the document.
- The score needs a visual, but keep it honest and quiet: no gauge dials, no traffic lights that
  imply more precision than a weighted heuristic has. Sub-scores per area, ranked worst first.
- Must render correctly for `fixtures/unreachable.json` (site is down — say so plainly and do not
  fabricate a score) and for `fixtures/solid.json` (a good site — the document must be able to
  say "this is in decent shape", or nobody will trust it on the bad ones).
- PDF via headless Chrome through `../rig/harness/cdp.js` (`Page.printToPDF`). Embed fonts as
  TTF/base64 — woff2 does not reliably load in headless print. Make sure Chrome actually exits.
- Tests in `src/report/*.test.js`: render each fixture, assert on real structure. Use the harness's
  `check()` with negative controls — a test asserting "the HTML contains a score" that passes when
  you delete the score block is VOID and will fail your run.

Report to `docs/build-report-c2.md` — a tracked file. Commit it with your work.

### vera — Contract, scoring, CLI
Owns:
- src/contract.js
- src/score/**
- src/cli/**
- bin/**
- fixtures/**
- test/**
- PLAN.md
- package.json
- README.md

Task:
Own the seam. Scoring rules and the plain-English finding catalogue, the ranked call list, the CLI
that runs a list of businesses end to end, and the README. Add contract fields when a slice asks.

## Open questions
- Do we ship a redesign concept per audit, or is the audit the whole product? (vera decides after
  the first real run against live NL sites.)
- Screenshot storage: committed to the repo, or generated on demand? Leaning generated.
