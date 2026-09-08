#!/bin/sh
# Used only by src/collect/https.test.js and checker-error.test.js, via the harness's RIG_CHROME hook, so that a locally
# generated certificate is reachable. Never used by collect() itself.
exec "${RIG_REAL_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" --ignore-certificate-errors "$@"
