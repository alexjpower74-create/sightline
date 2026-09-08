// A local https site, for the handful of things that only exist over TLS: the padlock, an
// http-to-https redirect, and mixed content.
//
// The certificate is generated fresh into a temp directory on every run. Committing a key to the
// repository would be both a bad habit and a test that starts failing the day it expires.

import { createServer } from 'node:https'
import { createServer as createTlsServer } from 'node:tls'
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

/**
 * A server that negotiates HTTP/2 and then talks nonsense, while serving perfectly good HTTP/1.1
 * to anything that asks for it.
 *
 * This is the shape of the a live site failure: Chrome prefers h2, cannot make sense of what
 * comes back, and gives up with ERR_HTTP2_PROTOCOL_ERROR — while curl, which asks for HTTP/1.1,
 * gets a 200 in a second and a bit. The site is fine. The browser is not.
 */
export async function startBrokenHttp2Server ({ http1Works = true } = {}, cert = makeCert()) {
  const cfg = { http1Works }
  const body = '<!doctype html><html lang="en"><head><title>Young\'s Refrigeration</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Industrial refrigeration</h1><p>Serving central Newfoundland since 1978.</p></main></body></html>'

  const server = createTlsServer({ key: cert.key, cert: cert.cert, ALPNProtocols: ['h2', 'http/1.1'] }, socket => {
    if (socket.alpnProtocol === 'h2') {
      socket.write('GARBAGE that is not an HTTP/2 frame\r\n\r\n')
      return socket.end()
    }
    if (!cfg.http1Works) return socket.destroy()
    socket.once('data', () => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      socket.end()
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return {
    cfg,
    origin: `https://127.0.0.1:${server.address().port}`,
    async close () { server.close(); cert.dispose?.() }
  }
}
