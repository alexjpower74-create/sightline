# Sightline

Audits a small business website the way its owner experiences it, and turns the findings into a
document you can hand them.

Not a Lighthouse dump. Page one is written for the owner — a score, one sentence saying what is
costing them most, and the three problems that matter, in plain English with no jargon. Page two
onward is written for whoever has to fix it: every finding, the measured evidence, and how long it
takes.

```console
$ sightline list prospects/central-nl.json --by "Alexander Power"

BUSINESS                            TOWN                   SCORE  CRIT  QUICK  LEAD WITH
Hilltop Plumbing          Gander                    50     2      5  Your site was built before phones mattered…
Petroleum & Environmental Services  Glenwood                  71     2      2  Your home page is 8.8 MB. That is roughly…
G & R Contracting                   Sandringham               73     2      1  On a phone your page is wider than the screen…
Young's Industrial Refrigeration    Lethbridge               n/c     0      1  We could not complete an automated check…

  n/c — our checker could not read the site. That is a limitation on our end, not a fault of theirs.
```

Worst and most fixable first. `QUICK` counts findings under an hour's work, because a prospect with
five quick wins is an easier first conversation than one who needs a rebuild.

## Install

```console
git clone <this repo> && cd sightline && npm link
```

Node 22+. Needs Chrome. macOS for the image compression (`sips`); everywhere else the size check
goes red rather than passing quietly.

## Use

```console
sightline serve                                                # open it in a browser
sightline audit <url> [--name "Business"] [--by "Your Name"]   # one site
sightline list <businesses.json> [--by "Your Name"]            # many, ranked
sightline score <measurement.json>                             # re-score without re-visiting
sightline explain <measurement.json>                           # show the arithmetic
```

Reports save to `~/Documents/Sightline`, in a dated folder per run. An HTML report and a PDF per
business, full-resolution captures in `screenshots/`.

`serve` is the one to show someone: paste an address, watch it work, and the report opens in the
page with the PDF a click away. It binds to 127.0.0.1, serves nothing outside the reports folder,
and keeps no state beyond the run. The command line is still the better tool for a list of fifteen
— but nobody leans forward at a terminal.

## What it measures

Real Chrome, twice — desktop at 1440×900 and a phone at 390×844. Page weight from actual network
events, not from reading the HTML. Sideways overflow measured two ways and cross-checked. Contrast
computed through transparent ancestors. Tap targets, headings, labels, landmarks, titles,
structured data, certificates, broken links, and whether the load event ever fired at all.

Five areas, weighted: **Speed** 25%, **Phones** 25%, **Accessibility** 20%, **Being found** 20%,
**Trust** 10%.

Accessibility carries real weight because in this market it carries contractual weight — nonprofit,
health and provincial-agency work routinely requires WCAG conformance.

## The rules that make it worth trusting

**Never accuse a working site.** This is the one finding a tool like this cannot afford to get
wrong, and it got it wrong on its first real outing: it told a live business their website was down
because Chrome could not negotiate HTTP/2 with their server, while `curl` got a 200 in 1.3 seconds.
Now every transport failure is confirmed with a second, simpler request before anyone is called
down — and not with `fetch`, which negotiates HTTP/2 and so reproduces the very failure it is meant
to check. Four different no-score states, which are not interchangeable:

| | |
|---|---|
| `unreachable` | genuinely down. Their problem. |
| `http-error` | answered, with an error. "Your website is running, but instead of your home page it returns an error." |
| `blocked` | turned our checker away. Often a sensible setting. Not a fault. |
| `not-checked` | **our** failure. "This is a limitation on our end. Nothing here says anything about your website." |

**No invented numbers.** A site we could not read gets no score at all. A number there would say we
looked when we did not.

**Nothing scores 100.** A tool that hands out a perfect score is not believed when it hands out 27.

**Penalties decay.** Summing them flat drove a bad site to 4/100, which reads as a scare tactic and
loses the room the moment anyone checks the arithmetic. Within an area the worst problem dominates;
the ones behind it add weight without compounding into nonsense.

**Your weakest link caps you.** A weighted average let one catastrophic area be averaged away by
four healthy ones — a site that did not work on a phone at all scored 72 because its SEO was tidy.
Nobody ranking prospects would agree.

**Show the arithmetic.** `sightline explain` prints every point deducted and why. That is the answer
to "where did 50 come from" — you show the line items rather than defending a black box.

```console
$ sightline explain measurement.json
https://example-construction.ca  ->  27/100 (urgent)
  Speed           26/100  x0.25  = 6.5
      -45  page-far-too-heavy  (14.8 MB over 118 requests; largest image 4.6 MB)
      -35  slow-load  (11.4 seconds to finish loading)
  Phones          11/100  x0.25  = 2.8
      -85  no-viewport-meta  (the page is served to phones at desktop width)
```

**Say what to fix, not just what is wrong.** "The widest thing on it is a table, at 900 pixels on a
390 pixel screen" is an instruction. "Your page overflows by 510px" is a complaint.

**Know which findings survive the week.** An audit is one visit. `timing`, page weight, broken
links and overflow can all differ between two runs of the same site — one fixture site tripped
"never finishes loading" on one run and "19.5 seconds to load" on the next. Whether a site has a
viewport tag, HTTPS, a page title, alt text or a 2014 copyright notice does not move. The findings
that sell are almost all in the second group, and the ones that move are the speed numbers, where
the report already says "when we checked". `src/contract.js` classifies every field.

**Every finding is checkable.** Nothing is asserted that a developer cannot verify in a minute. Two
findings from the first live run were checked by hand against the sites in question before this was
shown to anyone.

## How it is built

Three agents on file-ownership slices, coordinated with [rig](../rig): a collector, a scorer, and a
renderer, with one contract file between them owned by one agent. 100+ checks across the build, all
with negative controls — every green assertion is run again against a deliberately broken version
of the thing it watches, and if it still passes it is reported VOID and the run fails.

That mechanism earned its keep. Six of fourteen scoring checks were VOID on their first run. Six of
fourteen renderer checks were VOID on theirs. Two collector defects lived in the success case that
no failure-path test could see. And the harness itself was found to be reporting a browser error
page as a successful navigation — in the project about checks that cannot fail.

The defects that mattered most were not found by any suite. They were found by running against
fifteen real businesses and reading the output.
