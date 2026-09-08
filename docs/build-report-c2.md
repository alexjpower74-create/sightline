# c2 — Report

`renderHtml(audit) -> string` and `renderPdf(audit, outPath) -> Promise<string>`, both exported
from `src/report/index.js` and both wired into the CLI's `writeReports`. Three sheets: the owner,
the findings, the measurements. Everything below has been run end to end through
`sightline audit` — c1's collector, vera's scorer, this renderer — not just against fixtures.

**30 checks across three suites, all green, none VOID, none UNPROVEN.**
Run them directly; `package.json` is vera's and its `test` script points at `test/`:

    node src/report/render.test.js    # 17 — the document's content
    node src/report/pdf.test.js       #  7 — fonts, images, Chrome, size budget
    node src/report/layout.test.js    #  6 — the printed geometry

    node src/report/preview.js --shots --pdf    # look at it

---

## What I built — DONE

**The two-audience split.** Page 1 carries `plainEnglish` and nothing else: no titles, no
severities, no effort codes, no measured numbers. Page 2 pairs `title` with `evidence`. Page 3 is
the raw measurement plus a method note that states what the audit does not test.

**Three judgement calls worth knowing about, because you may want them different:**

1. `score.hook` is the worst finding's `plainEnglish` verbatim, so leading with it *and* listing
   the findings prints the same sentence twice. The hook becomes the headline and drops out of the
   list; the "15 more overleaf" count includes it so the arithmetic on the page adds up.
2. A `strong` band does not use the hook as its headline. Leading a 97/100 with "2 of your
   pictures are missing a written description" makes the document sound like it went looking for
   trouble. Strong sites get "This site is in good shape, and that is not the usual answer" and the
   hook falls into the list underneath.
3. Page 2 is one flat list in your order, not grouped by area. Grouping silently re-ranks a sort
   that you said is a product decision. The area is a tag on the row instead.

**Score visual.** Numeral, `score.line`, five bars worst-first with each area's weight. All ink,
no colour: filling the low bars red turns five ranked areas into a traffic light and claims a
precision a weighted heuristic does not have. The single accent is reserved for `critical` and for
the one no-score state that is actually the site's fault.

**No score, three ways — DONE.** `unreachable`, `blocked` and `not-checked` now read as three
different things. A site that is down is the owner's problem; a site that turned our checker away
is not a fault at all; a check that fell over on our end is ours, said in the first sentence. Two
independent conditions have to agree before any number is printed (`measurement.ok` **and** the
scorer issuing an `overall`), so a score handed in for a dead site is refused rather than rendered.

**Size — DONE.** Screenshots re-encoded at embed time, PNG to JPEG q78, scaled to what the page
prints. Same audit, same captures: HTML 5.81 MB -> 1.63 MB, PDF 2.92 MB -> 0.60 MB. A real
end-to-end run of a photo-heavy site: 1.2 MB HTML, 438 KB PDF. Under your 2 MB budget and under
the 1 MB stretch. There is a check with the control you asked for — compression off puts it at
5.20 MB / 3.03 MB, decisively red — and a second check that the images were actually re-encoded,
so the budget cannot be met by accident.

---

## What I got wrong, and how

Recorded because the pattern matters more than the individual bugs.

**Six of fourteen checks were VOID on the first run**, as you predicted, for two causes. Findings
say things like `Browsers mark the site "Not secure"`, and those quotes are `&quot;` by the time
they reach the document — so `every(f => !p1.includes(f.title))` never matched anything and passed
forever. It would have kept passing if page 1 showed nothing but developer titles. The second: an
assertion that re-reads the array its own control just mutated compares the broken document to the
broken data and agrees with itself. Three checks passed against an audit that had been deliberately
reversed and rewritten. Expectations are snapshotted from a pristine clone now.

**Three more went VOID later, each for its own reason,** and all three are more instructive than
the bugs they were meant to catch:

- The overleaf count recomputed the arithmetic the same way the renderer does, so adding a finding
  moved both sides together. Pinned to the fixture now.
- "The image's height equals its frame's height" is equally true when the frame is being sized *by*
  the image, which is the broken state — a tautology, not an assertion. I did not spot it by
  reading it; the harness did, and only because the control I happened to write swapped in the
  exact CSS that had shipped the bug. Had I written a vaguer control the check would have looked
  fine forever. It asserts the frame is shorter than the image's own aspect would make it now,
  which is the one thing that differs between the two states.
- Two layout checks called `load()` inside the assertion, which re-navigates and threw away the
  element the control had just injected. A control the assertion undoes before looking is not a
  control.

**Two defects were invisible to every string assertion**, and only appeared when the CLI was first
run end to end against a real site — because all three fixtures carry `screenshots: null`, so
nothing had ever had an intrinsic height. Page 1 printed with its cost list and screenshot pushed
onto page 2, leaving a heading alone above half a blank page; and `evidenceSection` threw outright
on the first audit with a phone shot and no desktop shot, because `yes(cond, html)` builds its
second argument whether the condition holds or not. `layout.test.js` exists because of these: it
measures the document in print media at Letter's real content box and asserts page 1 fits on
page 1.

**The cropping mistake is the one I would most want you to know about.** Cropping the long tail off
a phone capture was the obvious extra saving. sips crops from the *centre*, and `--cropOffset 0 0`
is silently ignored on this version, so the first implementation threw the top of the page away and
embedded the middle — the hero, the header, the one screenful that persuades anybody. Every check
still passed; the size went down; it looked like a success. It took rasterising the PDF at 200dpi
and looking at it. The pixel ceiling now scales width down instead of discarding rows, and never
below 560px so the overflow evidence stays legible in print.

Two smaller ones in the same spirit: the Chrome-leak check sampled process counts once at each end,
and one browser is a dozen processes that outlive `close()`, so it went red on scheduling noise
when the suites ran back to back. And `!html.includes('71')` goes red on a *correct* document,
because half a megabyte of inlined base64 font data contains every two-digit string there is.

---

## What I need from other slices

1. **`preparedBy` — DONE.** vera put it on the `Audit` and wired the CLI (`--by`, or
   `SIGHTLINE_PREPARED_BY`). Closing it exposed a second, quieter hole on my side: `view()` read
   only `opts.preparedBy`, so `renderHtml(audit)` — the documented signature, and the one the
   tests and preview use — still rendered unsigned from an audit that named its sender. It worked
   end to end only because `writeReports` passes the same value both ways. The option overrides
   the field now, which is what putting it on the Audit was for: the same audit re-rendered later
   keeps saying who did the work. Checked, with the check deliberately rendering with no options.

2. **`shoot()`'s finding, for c1.** On a page with no viewport meta, Chrome's mobile emulation does
   not lay out at 390 — it expands the layout viewport to the page's content width (1288 for my
   demo file) and leaves it there. So `innerWidth` is not the device width, and a screenshot
   clipped to 390 shows the left third of the page rather than what a visitor sees, which is the
   whole thing shrunk to unreadable. Worth confirming which of those `mobile.png` is meant to be —
   the renderer handles either, and picks its layout from the image's actual aspect.

3. **The overleaf count is pinned to the neglected fixture** (19 problems, headline plus three
   shown, fifteen left). If a rule change moves that count the check goes red on purpose: page 1
   wants looking at again when it does. Not a request, just so it is not a surprise.

## Left undone — REJECTED / deferred

- **`min-width: 0` on the flex columns is kept but is not the fix**, and `report.css` says so. The
  image sizing is what holds the layout; I measured both rather than leaving a comment that took
  credit.
- **sips is macOS-only.** No fallback compressor. On a machine without it the originals are
  embedded and the size check goes red rather than the failure passing quietly. Fine for this shop;
  worth knowing before anything runs in CI.
- **No check that the document is *beautiful*.** Every check here can pass while it is ugly, and
  ugly is the failure mode that loses the pitch. `preview.js --shots --pdf` is there for a person to
  look at; that step is not automatable and I did not pretend otherwise.
