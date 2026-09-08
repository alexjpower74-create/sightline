// A local https site, for the handful of things that only exist over TLS: the padlock, an
// http-to-https redirect, and mixed content.
//
// The certificate is generated fresh into a temp directory on every run. Committing a key to the
// repository would be both a bad habit and a test that starts failing the day it expires.

import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function makeCert () {
  const dir = mkdtempSync(join(tmpdir(), 'sightline-tls-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '30', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
  } catch (e) {
    throw new Error('could not generate a test certificate — is openssl on the path? ' + e.message)
  }
  return {
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem')),
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  }
}

export async function startTlsServer (handler, cert = makeCert()) {
  const server = createServer({ key: cert.key, cert: cert.cert }, handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const origin = `https://127.0.0.1:${server.address().port}`
  return {
    origin,
    url: p => origin + p,
    async close () { server.closeAllConnections?.(); await new Promise(r => server.close(r)); cert.dispose?.() }
  }
}

/**
 * Chrome will not touch a certificate it does not trust, which is the right thing for it to do and
 * makes a local TLS fixture unreachable. `RIG_CHROME` is the harness's own escape hatch for the
 * browser binary, so we point it at a one-line wrapper that adds the flag. The harness itself is
 * not modified, and nothing about the machine's trust store is touched.
 */
export function chromeWrapperPath () {
  return join(dirname(fileURLToPath(import.meta.url)), 'chrome-ignoring-cert-errors.sh')
}
