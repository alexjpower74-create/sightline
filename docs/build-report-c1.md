# Report — c1 · Collector

`collect(url, opts) -> Measurement`, in `src/collect/index.js`. Every field of `Measurement` as
`src/contract.js` defines it is filled in. No field was added, renamed or repurposed.

**54 checks across five suites, 0 failed, 0 void, 0 unproven.** One command:

```
node src/collect/run-checks.js
```

---

## What it does

Two passes through real Chrome. Desktop 1440x900 for `timing` and `weight`; mobile 390x844 at
dpr 3 for everything under `mobile.*`. Real Chrome rather than a fetch of the HTML, because half of
what is wrong with a neglected small-business site only exists after its scripts have run — the
good fixture proves the point, attaching a 2MB image from script after parse.

| File | Does |
|---|---|
| `index.js` | orchestration, the per-site deadline, navigation, error translation |
| `network.js` | `weight`, redirect chain and mixed content, from `Network.*` events |
| `page-scripts.js` | everything evaluated in the page, shipped as functions via `toString` |
| `links.js` | broken links, robots.txt and sitemap.xml, probed from Node |
| `screenshot.js` | PNG capture, gated on `isRendering` |
| `server.js`, `tls.js`, `fixtures/*.html` | the local site every check runs against |

---

## The three decisions worth arguing with

**1. `mobile.horizontalOverflowPx` — two readings, and a clip guard.** Answering vera's question
directly, because this is the heaviest-weighted rule in the catalogue:

- **Measured against** `document.documentElement.clientWidth` at a pinned 390px viewport —
  `scrollWidth - clientWidth` — cross-checked against how far the page *actually* moves under real
  horizontal wheel input. The larger of the two wins.
- **After what settling:** `document.fonts.ready` (capped at 1.2s) plus 300ms, and then **read a
  second time** after the tap-target sweep has scrolled the whole page with real input — roughly
  1.5–3s later, with lazy content loaded. The larger of the two readings is reported.
- **Zero whenever the root clips.** If `overflow-x` is `hidden` or `clip` on `html` or `body`,
  the answer is 0 no matter what the geometry says. Nothing moves, the visitor sees nothing wrong,
  and a number here would be a false accusation on the finding that would embarrass us most.

Each of those three is a check with a control: `bad.html` (900px child, exactly 510), `clipped.html`
(same 900px child inside a clipping root, must be 0 — the control removes `overflow-x: hidden` and
it becomes 510), and `long.html` (a wide block inserted by an `IntersectionObserver` three screens
down — settled reading 0, after-sweep reading 382; the control makes the observer insert nothing).

Why not geometry alone, as suggested: it reports a sideways scroll on `clipped.html`, where nothing
slides. Why not input alone: on `bad.html` Chrome's mobile emulation zooms out to fit rather than
scrolling, and input reads **0** on the very page built to have the finding. Either measure on its
own is wrong on one of the two fixtures. Both together are right on both.

**One honest limitation.** A page with no viewport meta lays out at Chrome's 980px fallback and is
scaled to fit, exactly as a real phone does — so overflow is measured against 980, not 390, and is
usually 0. That is what the visitor experiences (everything tiny, no sideways scroll), and
`mobile.hasViewportMeta` is the field that carries the finding. Worth knowing when you write the
plain-English text: for a no-viewport site the sentence is "it comes up shrunk to fit", not "it
slides sideways".

**2. `a11y.lowContrastNodes` refuses more than it counts.** The effective background is resolved by
walking up and compositing translucent layers until something opaque or the canvas. Where the
answer genuinely cannot be known the node is **dropped, not guessed**: a background image or
gradient, a `filter`, any ancestor with `opacity < 1`, a colour in a space that will not parse
(oklch, lab, display-p3), text clipped to a background. Also skipped: anything visually hidden.

This undercounts, deliberately and in one direction. The common real pattern it misses is grey text
inside an `opacity: .6` container, and any text over a hero image. Given the brief — a false
accessibility finding in a pitch is worse than a missed one, and several of these clients are
public-sector adjacent — that is the right direction to be wrong in. **Since your rule only trips at
>= 5 nodes, be aware the number is a floor, not an estimate.**

The compositing is not decoration: the fixture has dark text on a 92% white veil over a black
panel. Stop the walk at the first ancestor with a colour and you report a failure that is not there.
The check for it turns red when the veil is made transparent.

**3. `mobile.tapTargetsUnder44` is hit-tested, not measured.** Targets are collected, then the page
is swept a screenful at a time with real wheel input, `document.elementFromPoint` at each stop. A
target something covers is not counted at all — the visitor never reaches it. On `covered.html`,
four small links, two of them under a fixed header: rectangles say 3 under 44px, hit-testing says 1.
Anything never reached within 6 screens falls back to geometry plus CSS visibility, which can size
an element but cannot know what covers it; the split is reported in `onNote`.

Off-canvas elements are excluded. The first smoke run scored the **good** fixture at 1 tiny tap
target — its own skip link, parked at `left: -9999px`. Counting an accessibility feature as a
finding against the one site that got it right is the sort of thing that loses a room.

---

## What the negative controls caught

Five checks came back VOID or wrong on their first run. All five were defects in my tests, which is
the point of the mechanism:

1. **Two VOID in the contrast suite.** The helper truncated each sample's text to 12 characters, so
   `startsWith('Bold nineteen')` and `startsWith('Screen reader')` could never match. Two
   assertions were watching nothing and reporting green.
2. **One VOID after that**, from the same suite: the visually-hidden control revealed the hidden
   node was black on white, so revealing it would not have failed AA anyway. The fixture now
   colours it `#f0f0f0` so the control can actually turn the check red.
3. **One VOID in the collector suite**: the reachability control wrote an empty fixture, and the
   check stayed green — correctly, since an empty 200 is still reachable. It withdraws the page now.
4. **One VOID that was precisely the failure you warned me about**: the soft-404 control set a
   global and changed nothing about the server under test. It flips the server's response mode now.

Two real defects in the collector came out of live probing rather than from the suites:
the off-canvas skip link above, and `ERR_CERT_AUTHORITY_INVALID` missing from the error
translation table — so an untrusted or expired certificate, a common and very sellable finding,
reached the report as raw Chrome-speak.

---

## Every site survives

Six failure modes, six `Measurement`s, no exceptions — `resilience.test.js`, controls flip the
failure mode on the running server:

| Case | Result |
|---|---|
| dead server (port taken then closed) | `ok:false`, "the server refused the connection" |
| redirect loop | `ok:false`, "redirects to itself in a loop and never arrives" |
| HTTP 500 | `ok:false`, `error: "HTTP 500 from ..."`, measurements still filled in |
| load event never fires | **`ok:true`** — see below |
| 40MB of DOM | `ok:true`, inside the 45s budget |
| run outlasts `timeoutMs` | `ok:false`, "gave up after 2500ms", partial data kept |
| untrusted certificate | `ok:false`, "not one browsers trust, so visitors see a full-page warning" |

Two judgement calls you should overrule if you disagree:

- **A page whose load event never fires is `ok:true`.** Half the small-business web has one request
  hanging behind an analytics tag; the page is perfectly visible and perfectly measurable, and
  `timing.loadMs` staying at **0** is itself the finding. If your scoring reads `loadMs: 0` as
  "instant", it will score these sites as fast. **0 means never, not zero.** Same for
  `domContentLoadedMs`.
- **A homepage answering 4xx/5xx is `ok:false`,** with the status in `error`. It is down as far as
  its owner's customers are concerned. The risk: a site that 403s headless Chrome for bot
  protection reads as down. The status is in the error string so a human can tell the difference,
  but on a live run against real NL sites this is the one I would expect to bite.

---

---

## Never declare a site down on one tool's word

We told Young's Industrial Refrigeration their website was down. It was not — Chrome could not
negotiate HTTP/2 with their server, returned `ERR_HTTP2_PROTOCOL_ERROR`, and the report went out
saying "anyone who looks you up right now sees an error page instead of your business". `curl` got
a 200 in 1.3 seconds.

Any transport-level failure is now confirmed with a second request before it is written up as the
owner's problem. If a plain request gets through, the failure is ours: `unreachableReason:
'checker-error'`, and `error` carries both sides — `net::ERR_HTTP2_PROTOCOL_ERROR from Chrome; a
plain request returned 200`.

**The second opinion is `node:http`/`node:https`, not `fetch`.** This matters more than it looks.
The first implementation used `fetch`, and against the broken-HTTP/2 fixture it failed with the
identical protocol error Chrome did — Node 26's fetch negotiates HTTP/2 as well. A second opinion
that reproduces the first is not a second opinion. `node:https` speaks HTTP/1.1 and nothing else,
which is the whole point: a different stack, no h2, no renderer. There is a check whose only job is
to pin this, and it asserts that plain `fetch` fails against the same fixture.

The fixture is that failure in miniature: a TLS server that negotiates h2 and then talks nonsense,
while serving perfectly good HTTP/1.1 to anything that asks. Its control makes HTTP/1.1 fail too —
both opinions then agree the site is down, and `checker-error` becomes the wrong answer.

**Wiring this up broke the redirect-loop case, and the suite caught it.** The confirming request
followed five hops, hit the cap, and returned the last 302 as a reachable status — turning a
redirect loop, which is entirely the site's fault, into ours. Only a final non-3xx answer counts as
reachable now. That has its own check.

**Cost:** one extra request per failed site, and up to 5s (`opts.confirmTimeoutMs`) on top of
`timeoutMs`, which now bounds the measurement rather than the whole call. Successful audits are
unaffected — nothing confirms a site that worked.

**The HTTP/1.1 retry is in.** `launch()` now takes `args`, so when the plain request gets through
and the browser did not, the collector retries the whole measurement once with `--disable-http2`.
The reasoning: a plain HTTP/1.1 client just held a conversation with this server, so an HTTP/1.1
conversation works and it is the browser that could not have one — give the browser the same
conversation before settling for a shrug.

Against the broken-h2 fixture it turns a non-answer into a real audit: `ok: true`, title, headings,
viewport, timing, all of it. **youngsice.com should now produce a real measurement.**

`checker-error` is still reached, just later: when the retry cannot rescue it either. There is a
fixture for that too — a server that hangs up on anything asking for HTML and answers a plain
request perfectly well, so neither protocol gets Chrome a page.

Two limits worth stating. The retry needs its own browser, because a borrowed one cannot be
relaunched with different flags, so a caller passing `opts.browser` still gets a second launch on
these sites. And it is skipped when the failure was our own budget timeout — retrying a site that
already exhausted 45 seconds just spends 45 more. Worst case on a failing site is now roughly
`timeoutMs` + 5s confirmation + `retryTimeoutMs` (default `min(timeoutMs, 30s)`); successful
audits are untouched.

---

## A check that passed with the thing it tested switched off

The harness's `goto()` was firing its load event on Chrome's own error page and reporting success —
title `youngsice.com`, which is the hostname, on `chrome-error://chromewebdata/`. Fixed in the rig.
My `navigate()` was never affected: it checks `Page.navigate`'s `errorText` before it waits for
anything, which is why the collector reported that site correctly.

I added a landing check of my own anyway, as defence in depth, and wrote an end-to-end check for
it. **Then I disabled the guard and the check stayed green.** For every failure I could construct
locally, `errorText` is set and the collector throws before the load event is ever considered — so
the check was pinning the outcome, not the guard, and the guard itself had never run.

The evidence, from probing four ways a response can die:

| Response | `errorText` | load fired | landed on |
|---|---|---|---|
| socket destroyed, nothing sent | `net::ERR_EMPTY_RESPONSE` | yes | `chrome-error://` |
| 302 to a dead endpoint | `net::ERR_EMPTY_RESPONSE` | yes | `chrome-error://` |
| headers, partial body, socket dies | none | no | the real URL, partial page |
| chunked, never terminated | none | no | the real URL, partial page |

Chrome only lands on its error page when `errorText` is also set, at least here. So the guard is now
tested **directly**, against a page genuinely sitting on `chrome-error://chromewebdata/`, rather
than through a path that never reaches it. Its other half — that it lets a real page through — is
what every navigation in all five suites depends on; a guard that rejected working sites would take
the whole run down, which is the loudest control there is.

Worth keeping the guard regardless: the mobile pass carries no network recorder, so it has one
fewer signal than the desktop pass, and this is its only protection against measuring an error page
as somebody's phone site.

---

## A leaked browser per timed-out site

Two headless Chromes were still running after a full suite. Not test residue — a defect in
`collect()`.

The per-site deadline races the work. If it fires while `launch()` is still starting Chrome, the
`finally` runs with `browser` still `null`, closes nothing, and the browser that arrives a moment
later is orphaned. Confirmed by restoring the old cleanup and timing out during launch on purpose:
**four processes left behind, per site.** A call list of fifty with a handful of slow sites would
have accumulated them until the machine complained, and it would have looked like Chrome being
Chrome rather than like a bug.

The launch is now held as a promise as well as a value, so the cleanup closes whatever it produced
even if it arrived after we stopped waiting for it.

**Correction — I overstated the second half of this, and reported it to vera before checking it.**

I said the first version of the fix still leaked "one browser with eleven helpers, every run", found
by counting Chrome processes after each suite. That claim does not hold. Those counts were sampled
two seconds after each suite exited, which is inside Chrome's own shutdown latency — SIGTERM, a
300ms grace, SIGKILL, then the OS reaping eleven helper processes. I diagnosed exactly that
measurement error an hour later for a different suite and did not go back and apply it to this one.

What is actually true, tested both ways:

- **The original defect is real.** With the original cleanup — the `finally` closing `browser` and
  nothing else — a deadline during launch orphans the browser. Measured at four processes per site,
  and the leak check fails against it in 406ms.
- **The synchronous assignment is hardening, not a fix for anything observed.** `await freePort()`
  genuinely does suspend before the promise is assigned, so the window is real; but it is
  sub-millisecond and no realistic deadline lands in it. Restoring the race does not reproduce a
  leak. It costs nothing and closes the hole, so it stays — described accurately.

The check is therefore wired to the defect that mattered and blind to the narrow one, which is now
written into the check itself rather than implied by silence. A full run ends with zero Chrome
processes and zero profile directories.

The lesson is the one this project keeps teaching, aimed at me this time: I verified the fix, then
described the verification from memory instead of from the run. **A measurement artifact I had
already diagnosed elsewhere became a confident claim in a commit message and a report because I
never re-ran the thing I was describing.**

The check for it has an unusual control. Leaking a browser is not something the collector can be
made to do from outside, so the control leaks one deliberately and asserts the count then does
*not* return to baseline — it breaks the world the assertion looks at rather than the collector,
which is the thing actually worth proving: that a leak is something this check can see at all.

---

## A concurrency defect, found by making a mess

Two of the https checks failed in a full run and passed when run alone. The cause was me: I ran
that suite by hand while the full run was in flight. Both used Chrome's remote debugging port
**9391**, a fixed number — so the second `launch()` found an endpoint already answering, quietly
attached to the *first* browser, and when the hand-run finished it closed Chrome out from under the
suite that was still using it.

Operator error, but it was pointing at a real defect. `collect()` picked its debugging port as
`9333 + (process.pid % 500)` — fixed per process. **Two `collect()` calls running at once in one
process would have shared a browser and torn it down under each other.** A CLI auditing a list of
sites in parallel is the obvious way to hit that on real work, and it would have looked like a
flake rather than a bug.

Every launch now takes an ephemeral port the OS has just confirmed free (`free-port.js`), in the
collector and in all five suites.

---

## How the two live-probe defects were found, and why the suites missed them

Both were found by **reading the output of a real run, not by a check failing.** That is the whole
lesson: my checks and my code share an author, so they share his assumptions. A check can only fail
in a way I already imagined.

**The skip link.** I ran `collect()` against my own fixtures and printed the whole `Measurement` to
look at it. `good.html` — the deliberately well-built site — came back with
`tapTargetsUnder44: 1, smallestTapTargetPx: 24`. Every check was green, because I had written them
to assert on the *bad* fixture where the count was supposed to be non-zero. Nothing anywhere
asserted that the good site scored zero. The 24px element was its own skip link, parked at
`left: -9999px`: we were about to penalise a site for having an accessibility feature. There is now
a check asserting the good fixture scores 0 under-44 targets, whose control makes the skip link
visible.

**The certificate sentence.** I noticed `https.*` had never been exercised by anything, so I wrote a
throwaway script pointing the collector at a self-signed TLS server just to see what came out. It
came out as `net::ERR_CERT_AUTHORITY_INVALID` — raw Chrome-speak, straight into a document a
business owner reads, because that code was missing from the translation table. No check could have
caught it: I had a table and a check that the table worked, and the defect was a missing row.

The pattern in both: **the suite tested the failure case and never the success case, and the defect
lived in the success case.** Worth generalising — for every check that asserts a fault is found,
there should be one asserting a good site is left alone.

---

## On the certificate flag, for the record

`chrome-ignoring-cert-errors.sh` adds `--ignore-certificate-errors`, and it is reachable **only**
through the harness's `RIG_CHROME` hook. Exactly two files set that variable, both test files
(`https.test.js`, `checker-error.test.js`), both setting it on their own process so a locally
generated certificate is reachable. Verified by grep across the repo: nothing else references the
wrapper, nothing sets `RIG_CHROME` outside those two files, and `collect()` has no code path that
can reach it. Production Chrome launches go through `launch()` with the default binary and full
certificate validation — which is what makes the untrusted-certificate finding possible at all.

The same two files set `NODE_TLS_REJECT_UNAUTHORIZED=0` on their own process, for the same reason
and with the same boundary: the collector's own confirming request validates certificates normally.

---

## On calling this one `blocked` — I think not, and the reason matters

You raised whether youngsice.com is closer to `blocked` than `checker-error`: curl gets a clean 200
over HTTP/2, Chrome gets a protocol error over h2 and an empty response over HTTP/1.1, consistently.
A server that answers curl and refuses Chrome does look like a fingerprinting signature.

I think `checker-error` is right, and not merely as the cautious option.

**The `blocked` copy would be backwards.** It reads "Your site has protection that turns away
automated visitors, and it turned ours away too. That is often a sensible setting." But our
automated visitor is the one that got through — `curl` and my confirming request both get a 200.
The client being refused is the *browser*. Bot protection that turns away scripts and admits
browsers is benign; whatever this is does the opposite.

**And that is the whole problem, because the two possibilities are miles apart.** Either it is a
WAF refusing datacenter or headless signatures — harmless, real visitors are fine — or the server
genuinely cannot talk to Chrome, in which case it is broken for the large majority of their actual
customers and that is a critical finding, not a minor one. From outside we cannot tell which.
Distinguishing them needs a real Chrome from a residential address, which we do not have.

So `blocked` would excuse a possible catastrophe, and `unreachable` would accuse a working site.
`checker-error` — "this needs to be checked by hand" — is the only one of the three that is true in
both worlds. It is not a hedge; it is the accurate answer to a genuinely undetermined question.

**I could have built a discriminator and decided not to.** A differential probe — a browser-shaped
plain request against a minimal one — would detect servers that refuse by request shape, and it is
cheap. But it would not have fired here: this server discriminates somewhere node cannot reach,
below the header layer. It would have reclassified my own `/hostile` fixture, and left
`checker-error` with no locally constructible case at all. A discriminator that misses the case
that motivated it, in exchange for making a well-tested state untestable, is a bad trade.

If you want the distinction, the honest shape is a separate reason — `'browser-refused'` — with
copy that does not claim to know whether real visitors are affected. I did not add it, because I
have exactly one site and no way to confirm what it means.

## Answering the DNS question

**Outbound DNS works from here. `example.com` specifically does not resolve on this machine.**

```
example.com   -> ENOTFOUND
google.com    -> 142.250.65.238
```

Resolver is the LAN router. So the `ERR_NAME_NOT_RESOLVED` you saw is this network's resolver
being odd about `example.com` — not your code and not mine. Other real domains resolve normally.
Worth knowing that `example.com` is useless as a smoke-test target here; pick any real site.


## For vera — things I need or would like

1. **`Measurement.timing.loadMs === 0` means the load event never fired.** Please make sure the
   speed rules do not read that as instant. This is the one that could put a wrong number in front
   of a client.
2. **All four new fields are implemented and checked.** DONE.
   - `mobile.overflowCulprit` — named from whichever of the two overflow readings found it. One
     thing to know: it **skips anything inside a horizontally scrolling wrapper.** A 1400px table
     inside `overflow-x: auto` sticks out further than anything else on the page and contributes
     nothing to the page's own sideways scroll — naming it would send a developer to fix the one
     thing already fixed. There is a fixture for exactly this, where the real offender is a 600px
     banner sitting behind a 1400px scrolling table. Your `describe()` turns `div.banner` into
     "the banner at the top", which reads correctly.
   - `https.certificateProblem` — `net::ERR_CERT_AUTHORITY_INVALID — the security certificate is
     not one browsers trust, so visitors see a full-page warning`. Code first for the developer,
     sentence after. Set alongside `unreachableReason: 'tls'`.
   - `freshness.brokenLinks` — now `{url, status}[]`. Note `status` can be the **string
     `'refused'`** when the connection never got far enough to have a status. The contract allows
     it and `/contact-us.html (refused)` reads correctly; I did not want to invent a 599.
   - `unreachableReason` — `'blocked'` for 403/429, for a 503 behind a challenge, and for a 200
     that is really a waiting room (challenge mechanism in the page **and** a challenge title
     **and** almost no content — all three, so a real page titled "Access Denied" is not caught).
     `'http-error'` for a genuine 404/500. `'checker-error'` per the section above.

3. **One consequence you should know about: when the page we reached is not the site, I now record
   nothing about content.** A blocked or http-error result carries timing, weight, https and
   `Last-Modified` — the transaction — and leaves `seo`, `a11y`, `mobile` and `freshness` at their
   empty values, with no screenshots. This came out of a check failing: the collector was happily
   reporting `seo.title: "Just a moment..."` from a Cloudflare waiting room. Nothing downstream
   reads those fields today because you return early on `!ok`, but a future rule would have found
   a plausible-looking title sitting there and had no way to know it belonged to somebody else.

4. **A HEAD that times out is not counted as broken.** A slow link is a real but different problem,
   and "this link is dead" when it merely took six seconds is the error that loses the room.
5. **`'refused'` is now used** for ERR_CONNECTION_REFUSED / RESET / CLOSED / EMPTY_RESPONSE /
   ADDRESS_UNREACHABLE. `'timeout'` is kept for genuine timeouts only. DONE.

6. **A 500 rendering as "did not respond"** — fixed on your side. DONE.

7. **`http2Broken` — agreed, no.** Your reasoning is right and it is the reasoning I should have
   applied before asking: the field's only motivating site cannot set it, so its first real use
   would be its first test. Withdrawn until a site measures cleanly after the retry, at which
   point the fixture is already written.

8. **The mobile screenshot now captures the layout width, not 390.** A page with no viewport meta
   lays out at Chrome's fallback width and is scaled to fit; clipping that to 390 was cropping it
   to the left third. The PNG is still 780 across in every case, so c2's aspect-ratio switch is
   unaffected — what changes is that a shrunk-to-unreadable site now looks shrunk to unreadable
   instead of looking like a narrow site that happens to be cut off.

9. **`opts.onNote(note)`** is a diagnostics callback — contrast samples with computed ratios,
   overflow culprit and both readings, tap-target hit-test coverage, screenshot dimensions. It
   never touches the `Measurement`. Useful if the CLI grows a `--explain`.
10. **Screenshot dimensions**, so c2 can lay out: desktop is 2880x1800 (the 1440x900 viewport at 2x),
   mobile is 780 wide by up to 3376 (390 CSS px, up to two viewport heights, at 2x). Both are
   captured only after `isRendering(page)`.
11. **A package script.** `node src/collect/run-checks.js` runs all four suites; `npm test` only
   runs `test/`. Yours to add if you want them in one command.

## One visit is a sample, not a fact about a website

Marwood Ltd measured differently on two consecutive nights: `loadMs: 0` (the load event never
fired) on the first run, 19.5 seconds on the second. Same site, same collector, different day. Both
are true statements about what happened when we looked, and neither is a fact about the site.

Every `Measurement` is one visit from one machine on one network. That is worth stating plainly
because the fields differ enormously in how much they mean a week later, and a document that treats
them alike will eventually be argued with by an owner who is right:

**Volatile — true when we checked, and quotable only that way**

- `timing.*` — the field that moved on Marwood Ltd. Varies with their server load, our network, and
  whichever third-party script is slow today.
- `weight.totalBytes` / `requests` — ad and tag networks serve different payloads per visit.
- `freshness.brokenLinks` — a link that answered 503 once is not a dead link. Timeouts are already
  excluded for this reason; transient 5xx are not.
- `mobile.horizontalOverflowPx` — stable for a hard-coded width, but an injected ad or a lazy
  image can add or remove it between visits.
- `unreachableReason` — by definition a statement about one moment.

**Stable — properties of how the site is built, safe to stand behind later**

- `mobile.hasViewportMeta`, `https.enabled`, `seo.title` / `metaDescription` / `h1Count` /
  `canonical` / `ogTags` / `structuredDataTypes`
- `a11y.hasMainLandmark`, `hasSkipLink`, `htmlLangSet`, `imagesMissingAlt` against `imagesTotal`
- `freshness.copyrightYear`, `generator`

The strongest findings for a pitch are almost all in the second list, which is convenient: a stale
copyright year, no viewport meta and no HTTPS are exactly the things an owner cannot dispute and
that will still be true when they check.

**None of my checks can catch this class**, and no check could: it is a property of sampling once,
not a defect. Two ways to reduce it if it ever matters — measure twice and report the median, or
carry a confidence marker on the volatile fields — both need contract fields and a decision from
vera, and neither is worth doing before someone is actually burned by it. Flagging rather than
building.

## Left undone

- **The live run happened and found the one thing that mattered** (see the `checker-error` section).
  14 of 15 sites audited cleanly. The remaining risk I would still watch on the next run: a slow
  site hitting the 45s budget, which now comes back as `checker-error` rather than as a partial
  measurement — gentle, but it is a non-answer where a real measurement might have been available
  with a longer budget.
- **`'blocked'` detection has never been tested against a real Cloudflare challenge**, only against
  a fixture built to look like one. The signals (cf-ray, challenge scripts, challenge markup,
  title) come from what those pages actually contain, but the first real 403 in a run is worth
  eyeballing.
- **`freshness.lastModified`** comes from the document's `Last-Modified` header. Most dynamic sites
  do not send one, so expect null far more often than not. Verified only against my static server.
- **`weight` under-reports on a warm cache.** Every run disables the cache, so this is not live
  today, but if that ever changes, `encodedDataLength` for a cached response is 0.
- **`seo.structuredDataTypes`** parses JSON-LD (through `@graph`, six levels) and microdata
  `itemtype`. RDFa is not read.

---

## Addendum — the classification, tested by accident

_Added by vera on c1's behalf; c1 could not commit to `docs/` before the guard exemption landed._

The second live run tested this classification without meaning to. Fifteen sites, re-run hours
later for an unrelated reason: 12 of 15 came back with identical findings. All three that moved
were timing — two sites dropped `slow-server` because the server answered faster, and one went
from `page-heavy` plus `slow-load` to `load-never-finishes`. Not one field from the stable list
moved. No viewport tag appeared or vanished, no title changed, no alt-text count, no copyright
year.

So the split is measured rather than argued, and it is worth more for having fallen out of a run
nobody performed to check it — had I set out to test my own classification I would have chosen the
sites and the interval, and the result would have been worth less.

The sitemap retry, on the same run, changed nothing: `no-sitemap` fired on 0 of 15 both before and
after, because all fifteen genuinely have sitemaps. The exposure was theoretical on this batch —
insurance, not a repair.
