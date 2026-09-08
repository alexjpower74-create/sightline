// Page weight, measured from what Chrome actually pulled down.
//
// The tempting shortcut is to fetch the HTML and add up the `src` attributes. That number is
// always wrong and usually wrong by an order of magnitude: it misses everything a script injects,
// counts things that never load, and cannot see a 4MB hero that a stylesheet asks for. These are
// the browser's own transfer events, so the total is the bytes the owner's customer paid for on
// their phone plan.

/** Attaches Network.* listeners to a page and accumulates transfer sizes. */
export function recordNetwork (page) {
  /** requestId -> { url, type, status, mimeType, headers, bytes } */
  const byId = new Map()
  const redirects = []          // document-level redirect hops, in order
  const insecure = new Set()    // subresource URLs requested over plain http
  const failures = []
  let documentRequestId = null

  page.on('Network.requestWillBeSent', p => {
    // The first Document request is the main frame's; anything Document-shaped after it is an
    // iframe. A redirect re-fires requestWillBeSent under the SAME requestId, which is exactly
    // how the hops below get stitched into one chain.
    if (p.type === 'Document' && documentRequestId === null) documentRequestId = p.requestId
    if (p.redirectResponse && p.requestId === documentRequestId) {
      redirects.push({ from: p.redirectResponse.url, to: p.request.url, status: p.redirectResponse.status })
    }
    if (typeof p.request?.url === 'string' && p.request.url.startsWith('http://')) insecure.add(p.request.url)
    byId.set(p.requestId, { url: p.request.url, type: p.type || 'Other', status: 0, mimeType: '', headers: {}, bytes: 0, finished: false })
  })

  page.on('Network.responseReceived', p => {
    const rec = byId.get(p.requestId) || { url: p.response.url, type: p.type, bytes: 0, finished: false }
    rec.url = p.response.url
    rec.type = p.type || rec.type || 'Other'
    rec.status = p.response.status
    rec.mimeType = p.response.mimeType || ''
    rec.headers = lowerKeys(p.response.headers || {})
    rec.fromCache = !!p.response.fromDiskCache
    // encodedDataLength here is headers-only; loadingFinished carries the real total.
    rec.bytes = Math.max(rec.bytes, p.response.encodedDataLength || 0)
    byId.set(p.requestId, rec)
  })

  page.on('Network.loadingFinished', p => {
    const rec = byId.get(p.requestId)
    if (!rec) return
    rec.bytes = Math.max(rec.bytes, p.encodedDataLength || 0)
    rec.finished = true
  })

  page.on('Network.loadingFailed', p => {
    const rec = byId.get(p.requestId)
    failures.push({ url: rec?.url || null, type: p.type, error: p.errorText, blocked: p.blockedReason || null, requestId: p.requestId })
    if (p.blockedReason === 'mixed-content' && rec?.url) insecure.add(rec.url)
  })

  return {
    /** The main document's response, or null if it never came back. */
    document () {
      if (documentRequestId !== null) {
        const d = byId.get(documentRequestId)
        if (d && d.status) return d
      }
      for (const rec of byId.values()) if (rec.type === 'Document' && rec.status) return rec
      return null
    },

    documentFailure () {
      if (documentRequestId !== null) {
        const f = failures.find(f => f.requestId === documentRequestId)
        if (f) return f
      }
      return failures.find(f => f.type === 'Document') || null
    },

    redirects: () => redirects.slice(),

    /** Subresources requested over http from an https page — the padlock-breaking kind. */
    mixedContent (finalUrl) {
      if (!String(finalUrl).startsWith('https://')) return []
      const out = []
      for (const url of insecure) {
        if (redirects.some(r => r.from === url)) continue   // an http->https hop is the fix, not the fault
        out.push(url)
        if (out.length >= 20) break
      }
      return out
    },

    weight () {
      let totalBytes = 0, imageBytes = 0, scriptBytes = 0, requests = 0
      let largestImage = null
      for (const rec of byId.values()) {
        if (!rec.status && !rec.bytes) continue    // never got off the ground; not weight
        requests++
        totalBytes += rec.bytes
        const isImage = rec.type === 'Image' || /^image\//.test(rec.mimeType)
        const isScript = rec.type === 'Script' || /javascript|ecmascript/.test(rec.mimeType)
        if (isImage) {
          imageBytes += rec.bytes
          if (!largestImage || rec.bytes > largestImage.bytes) largestImage = { url: rec.url, bytes: rec.bytes }
        } else if (isScript) {
          scriptBytes += rec.bytes
        }
      }
      if (largestImage && largestImage.bytes === 0) largestImage = null
      return { totalBytes, requests, imageBytes, scriptBytes, largestImage }
    },

    all: () => [...byId.values()]
  }
}

function lowerKeys (o) {
  const out = {}
  for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = v
  return out
}
