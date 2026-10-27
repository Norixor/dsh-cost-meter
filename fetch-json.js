/**
 * One bounded JSON GET shared by the price catalog and the balance queries: a timeout over the whole exchange (headers and
 * body), a cap on the body size, no redirects (a redirect could carry an API key to another host) and a stable failure code
 * instead of a thrown error. The caller decides what the JSON means.
 *
 * Failure codes: network, timeout, http (with `status`), too-large, bad-format (not JSON).
 */

/** The body as text, or null once it grows past `limit` (a declared length is checked first, a streamed body while it arrives). */
async function readLimited(res, limit) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN)
  if (Number.isFinite(declared) && declared > limit) return null
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text()
    return Buffer.byteLength(text) > limit ? null : text
  }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      try { await reader.cancel() } catch { /* the stream is dropped either way */ }
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const isAbort = (err) => Boolean(err) && err.name === 'AbortError'

/**
 * `options`: `fetchImpl` (defaults to the global fetch, looked up per call so tests can stub it), `headers`, `timeoutMs`,
 * `maxBytes`. Resolves to `{ ok: true, json }` or `{ ok: false, code, status? }`; never rejects.
 */
export async function fetchJson(url, options) {
  const { fetchImpl, headers, timeoutMs, maxBytes } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res
    try {
      res = await (fetchImpl || globalThis.fetch)(url, { signal: controller.signal, redirect: 'error', headers: Object.assign({ accept: 'application/json' }, headers) })
    } catch (err) { return { ok: false, code: isAbort(err) ? 'timeout' : 'network' } }
    if (!res.ok) return { ok: false, code: 'http', status: res.status }
    let text
    try { text = await readLimited(res, maxBytes) } catch (err) { return { ok: false, code: isAbort(err) ? 'timeout' : 'network' } }
    if (text === null) return { ok: false, code: 'too-large' }
    try { return { ok: true, json: JSON.parse(text) } } catch { return { ok: false, code: 'bad-format' } }
  } finally {
    clearTimeout(timer)
  }
}
