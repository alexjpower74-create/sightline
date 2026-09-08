# Build reports

Written by the agents that built each slice, as they worked. Preserved here because they lived in
`.rig/`, which is gitignored and goes away with the worktrees — and they are the most detailed
account of how this was built that exists.

- **[build-report-c1.md](build-report-c1.md)** — the collector. Includes the second-opinion
  reasoning (why `fetch` cannot confirm a browser's transport failure), why `blocked` was refused
  for a live site, the browser leak and the correction to its own first account of it, and the
  volatility analysis that is now summarised in `src/contract.js`.
- **[build-report-c2.md](build-report-c2.md)** — the report renderer. Includes the size budget, the
  `sips` centre-crop that quietly threw away the top of every page while all checks stayed green,
  and the tautological layout assertion ("image height equals frame height" is equally true when
  the frame is sized by the image).

Both contain the same recurring finding from opposite ends: the defects that would have shipped
were invisible to the suites that covered them, and surfaced at a hand-off, a second opinion, or a
negative control.
