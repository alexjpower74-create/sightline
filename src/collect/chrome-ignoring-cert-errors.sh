#!/bin/sh
# Used only by src/collect/https.test.js and checker-error.test.js, via the harness's RIG_CHROME hook, so that a locally
# generated certificate is reachable. Never used by collect() itself.
# Finds Chrome the same way the rig harness does: RIG_REAL_CHROME wins, then the first known path that exists.
if [ -n "$RIG_REAL_CHROME" ]; then chrome="$RIG_REAL_CHROME"; else
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
    [ -x "$c" ] && chrome="$c" && break
  done
fi
[ -n "$chrome" ] || { echo "chrome-ignoring-cert-errors.sh: no Chrome found; set RIG_REAL_CHROME" >&2; exit 127; }
exec "$chrome" --ignore-certificate-errors "$@"
