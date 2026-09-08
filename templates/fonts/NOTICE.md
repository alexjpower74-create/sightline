# Bundled faces

All five are SIL Open Font License 1.1, which permits redistribution inside a document.
They are here rather than on a CDN because the PDF is printed and emailed: a report that
needs the network to look right is a report that will one day look wrong in front of a client.

| File | Family | Upstream |
|---|---|---|
| `PublicSans-400.ttf` | Public Sans | github.com/uswds/public-sans |
| `PublicSans-600.ttf` | Public Sans | github.com/uswds/public-sans |
| `PublicSans-700.ttf` | Public Sans | github.com/uswds/public-sans |
| `SourceSerif4-600.ttf` | Source Serif 4 | github.com/adobe-fonts/source-serif |
| `IBMPlexMono-400.ttf` | IBM Plex Mono | github.com/IBM/plex |

TTF, not woff2, on purpose: woff2 does not reliably decode in headless Chrome's print path,
and the failure mode is a silent fallback to Times in a document you already sent.
