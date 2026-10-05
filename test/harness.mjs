// Behavioural regression suite for _worker.js.
//
// Zero dependencies, stubs globalThis.fetch and exercises the Worker's fetch
// handler directly. Run it from the repository root:
//
//     node test/harness.mjs [path/to/_worker.js]
//
// Exits non-zero if any case fails.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modPath = path.resolve(process.cwd(), process.argv[2] ?? path.join(repoRoot, '_worker.js'))

// ---- stub fetch ------------------------------------------------------------
const calls = []
let nextResponse = null
function defaultFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url
  calls.push({ url, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), init })
  if (typeof nextResponse === 'function') return nextResponse(url, init)
  if (nextResponse) return nextResponse.clone()
  return new Response('upstream-ok', { status: 200 })
}
globalThis.fetch = defaultFetch
const respond = (r) => { nextResponse = r }
const reset = () => { calls.length = 0; nextResponse = null }

const worker = (await import(modPath)).default
const run = (path, { env = {}, headers = {}, method = 'GET', body } = {}) => {
  const init = { method, headers }
  if (body !== undefined) init.body = body
  return worker.fetch(new Request('https://demo.example' + path, init), env, {})
}

const results = []
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name, e.message]) }
}

// 1. homepage
await test('GET / returns HTML homepage', async () => {
  reset()
  const r = await run('/')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/html/)
  assert.match(await r.text(), /GitHub 文件加速/)
  assert.equal(calls.length, 0, 'homepage must not hit upstream')
})

// 2. favicon
await test('GET /favicon.ico returns cached png', async () => {
  reset()
  const r = await run('/favicon.ico')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.match(r.headers.get('cache-control') ?? '', /max-age=86400/)
  const buf = new Uint8Array(await r.arrayBuffer())
  assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'png magic')
})

// 3. ?q= redirect
await test('?q= redirects to prefixed path', async () => {
  reset()
  const r = await run('/?q=https://github.com/a/b/archive/main.zip')
  assert.equal(r.status, 301)
  assert.equal(r.headers.get('location'), 'https://demo.example/https://github.com/a/b/archive/main.zip')
})

// 4. releases proxy
await test('release url is proxied (manual redirect)', async () => {
  reset()
  const r = await run('/https://github.com/a/b/releases/download/v1/x.zip')
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://github.com/a/b/releases/download/v1/x.zip')
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.equal(r.headers.get('access-control-expose-headers'), '*')
  assert.equal(r.headers.get('content-security-policy'), null)
})

// 5. no-protocol input
await test('protocol-less url gets https:// prefix', async () => {
  reset()
  await run('/github.com/a/b/archive/main.zip')
  assert.equal(calls[0].url, 'https://github.com/a/b/archive/main.zip')
})

// 6. blob -> raw
await test('blob path rewritten to raw', async () => {
  reset()
  await run('/https://github.com/a/b/blob/main/src/index.js')
  assert.equal(calls[0].url, 'https://github.com/a/b/raw/main/src/index.js')
})

// 7. info/refs (git smart http)
await test('info/refs (exp3) proxied', async () => {
  reset()
  await run('/https://github.com/a/b/info/refs?service=git-upload-pack')
  assert.equal(calls[0].url, 'https://github.com/a/b/info/refs?service=git-upload-pack')
})

// 8. raw + gist
await test('raw.githubusercontent proxied', async () => {
  reset()
  await run('/https://raw.githubusercontent.com/a/b/main/f.txt')
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/a/b/main/f.txt')
})
await test('gist proxied', async () => {
  reset()
  await run('/https://gist.githubusercontent.com/u/123/raw/x.py')
  assert.equal(calls[0].url, 'https://gist.githubusercontent.com/u/123/raw/x.py')
})

// 9. tags
await test('tags path proxied (exp6)', async () => {
  reset()
  await run('/https://github.com/a/b/tags')
  assert.equal(calls[0].url, 'https://github.com/a/b/tags')
})

// 10. crawler UA cloaking
await test('blocked UA gets nginx camouflage page', async () => {
  reset()
  const r = await run('/', { headers: { 'User-Agent': 'Mozilla/5.0 Netcraft' } })
  assert.equal(r.status, 200)
  assert.match(await r.text(), /Welcome to nginx!/)
  assert.equal(calls.length, 0)
})

// 11. env.UA extends blocklist
await test('env.UA extends crawler blocklist', async () => {
  reset()
  const r = await run('/', { headers: { 'User-Agent': 'MyBadBot/1.0' }, env: { UA: 'MyBadBot' } })
  assert.match(await r.text(), /Welcome to nginx!/)
})

// 12. CORS preflight
await test('OPTIONS preflight returns 204 + CORS', async () => {
  reset()
  const r = await run('/https://github.com/a/b/archive/main.zip', {
    method: 'OPTIONS',
    headers: { 'access-control-request-headers': 'x-custom' },
  })
  assert.equal(r.status, 204)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.match(r.headers.get('access-control-allow-methods') ?? '', /GET/)
  assert.ok(r.headers.get('access-control-allow-headers'), 'must allow request headers')
})

// 13. URL302 camouflage
await test('URL302 env redirects homepage', async () => {
  reset()
  const r = await run('/', { env: { URL302: 'https://example.org/' } })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://example.org/')
})

// 14. URL=nginx
await test('URL=nginx serves camouflage page', async () => {
  reset()
  const r = await run('/', { env: { URL: 'nginx' } })
  assert.match(await r.text(), /Welcome to nginx!/)
})

// 15. URL passthrough
await test('URL env proxies homepage to custom origin', async () => {
  reset()
  respond(new Response('masked', { status: 200 }))
  const r = await run('/', { env: { URL: 'https://mask.example/home' } })
  assert.equal(r.status, 200)
  assert.equal(calls[0].url, 'https://mask.example/home')
})

// 16. upstream 3xx rewritten through the proxy
await test('github 302 location rewritten to prefixed path', async () => {
  reset()
  respond(new Response(null, { status: 302, headers: { location: 'https://github.com/a/b/releases/download/v1/x.zip' } }))
  const r = await run('/https://github.com/a/b/archive/main.zip')
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/https://github.com/a/b/releases/download/v1/x.zip')
})

// 17. relative upstream location must not crash  <--- known bug
await test('relative upstream location does not crash', async () => {
  reset()
  respond(new Response(null, { status: 302, headers: { location: '/login?return_to=%2Ffoo' } }))
  const r = await run('/https://github.com/a/b/archive/main.zip')
  assert.ok(r.status < 500, 'expected non-5xx, got ' + r.status)
})

// 18. redirect loop must terminate <--- known bug
await test('redirect loop terminates with a response', async () => {
  reset()
  let n = 0
  respond(() => (n++ < 60
    ? new Response(null, { status: 302, headers: { location: 'https://evil.example/' + n } })
    : new Response('too many', { status: 508 })))
  const r = await run('/https://github.com/a/b/archive/main.zip')
  assert.ok(r, 'no response returned')
  assert.ok(n <= 20, 'unbounded redirect recursion: ' + n + ' hops')
})

// 19. unknown path falls back to homepage
await test('unknown path falls back to homepage', async () => {
  reset()
  const r = await run('/some/random/path')
  assert.equal(r.status, 200)
  assert.match(await r.text(), /GitHub 文件加速/)
})

// 20. no upstream header leakage of client IP forwarding headers
await test('hop-by-hop / client IP headers stripped before upstream', async () => {
  reset()
  await run('/https://github.com/a/b/archive/main.zip', {
    headers: {
      'user-agent': 'curl/8',
      'x-forwarded-for': '1.2.3.4',
      'cf-connecting-ip': '1.2.3.4',
      'cookie': 'session=abc',
      connection: 'keep-alive',
      te: 'trailers',
    },
  })
  const h = calls[0].init.headers
  assert.equal(h.get('x-forwarded-for'), null, 'x-forwarded-for must be stripped')
  assert.equal(h.get('cf-connecting-ip'), null, 'cf-connecting-ip must be stripped')
  assert.equal(h.get('te'), null, 'hop-by-hop te must be stripped')
})

// 21. URL host-spoofing is rejected (SSRF-ish guard)
await test('non-github host is not proxied', async () => {
  reset()
  const r = await run('/https://evil.example/secret.txt')
  assert.equal(calls.length, 0, 'must not fetch arbitrary host: ' + calls.map(c => c.url))
  assert.equal(r.status, 200)
  assert.match(await r.text(), /GitHub 文件加速/)
})

// 22. env.UA must not accumulate across requests (isolate state leak)
await test('env.UA does not grow module state across requests', async () => {
  reset()
  // Count String#includes calls that the crawler check performs.
  const orig = String.prototype.includes
  let counted = 0
  String.prototype.includes = function (...a) {
    if (String(this) === 'mycrawler/1.0') counted++
    return orig.apply(this, a)
  }
  try {
    const env = { UA: 'crawlerA' }
    const hdrs = { 'User-Agent': 'MyCrawler/1.0' }
    for (let i = 0; i < 400; i++) await run('/', { env, headers: hdrs })
    const after400 = counted
    for (let i = 0; i < 400; i++) await run('/', { env, headers: hdrs })
    const after800 = counted
    const per1 = after400 / 400
    const per2 = (after800 - after400) / 400
    assert.ok(
      per2 <= per1 * 1.2 + 1,
      `UA blocklist grows per request: first 400 avg=${per1.toFixed(1)} includes/req, next 400 avg=${per2.toFixed(1)} includes/req`
    )
  } finally {
    String.prototype.includes = orig
  }
})

// 23. duplicate / redundant URL parsing
await test('request URL parsed at most twice per request', async () => {
  reset()
  const req = new Request('https://demo.example/https://github.com/a/b/archive/main.zip')
  const orig = globalThis.URL
  let n = 0
  globalThis.URL = class extends orig { constructor(...a) { super(...a); n++ } }
  try {
    await worker.fetch(req, {}, {})
    assert.ok(n <= 2, 'URL parsed ' + n + ' times per request')
  } finally {
    globalThis.URL = orig
  }
})

// 24. favicon cache returns a valid PNG on every request
await test('favicon decoding is cached but stays valid on repeat calls', async () => {
  reset()
  for (let i = 0; i < 3; i++) {
    const r = await run('/favicon.ico')
    const buf = new Uint8Array(await r.arrayBuffer())
    assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `png magic (call ${i})`)
    assert.ok(buf.length > 1000, `png size (call ${i}): ${buf.length}`)
  }
})

// 25. ?q= must not hijack a proxied url that carries its own query string
await test('?q= does not hijack proxied urls carrying a query string', async () => {
  reset()
  const r = await run('/https://github.com/a/b/releases/download/v1/x.zip?q=https://evil.example/')
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://github.com/a/b/releases/download/v1/x.zip?q=https://evil.example/')
})

// 26. POST (git-upload-pack) body is forwarded
await test('POST body is forwarded upstream', async () => {
  reset()
  const payload = '006egit-upload-pack a/b' + String.fromCharCode(0) + 'host=x' + String.fromCharCode(0)
  const r = await run('/https://github.com/a/b/git-upload-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request' },
    body: payload,
  })
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://github.com/a/b/git-upload-pack')
  assert.equal(calls[0].method, 'POST')
  assert.ok(
    calls[0].init.body && typeof calls[0].init.body.getReader === 'function',
    'request body must be passed through'
  )
})

// 27. upstream network failure surfaces as 502, not a rejected promise
await test('upstream network failure returns 502', async () => {
  reset()
  globalThis.fetch = async () => { throw new Error('ECONNRESET') }
  try {
    const r = await run('/https://github.com/a/b/archive/main.zip')
    assert.equal(r.status, 502)
  } finally {
    globalThis.fetch = defaultFetch
  }
})

// 28. credentials are not forwarded across an origin change
await test('cross-origin redirect drops authorization/cookie', async () => {
  reset()
  let seen = null
  respond(() => {
    if (!seen) { seen = 'first'; return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }) }
    return new Response('ok', { status: 200 })
  })
  await run('/https://github.com/a/b/archive/main.zip', {
    headers: { authorization: 'token SECRET', cookie: 'sid=1' },
  })
  const cross = calls.find(c => c.url.startsWith('https://evil.example'))
  assert.ok(cross, 'expected a follow-up fetch to the cross-origin location')
  const h = cross.init.headers
  assert.equal(h.get('authorization'), null, 'authorization leaked cross-origin')
  assert.equal(h.get('cookie'), null, 'cookie leaked cross-origin')
})

// 29. same-origin redirect keeps credentials (private repo clone must keep working)
await test('same-origin redirect keeps authorization', async () => {
  reset()
  let seen = null
  respond(() => {
    if (!seen) { seen = 'first'; return new Response(null, { status: 302, headers: { location: 'https://github.com/login' } }) }
    return new Response('ok', { status: 200 })
  })
  await run('/https://github.com/a/b/archive/main.zip', { headers: { authorization: 'token SECRET' } })
  const same = calls.find(c => c.url === 'https://github.com/login')
  assert.ok(same, 'expected a follow-up same-origin fetch, got ' + JSON.stringify(calls.map(c => c.url)))
  assert.equal(same.init.headers.get('authorization'), 'token SECRET', 'same-origin authorization must be kept')
})

// 30. template literal must not eat the backslashes of the inline regex / css
await test('homepage keeps regex escaping and valid CSS in the template literal', async () => {
  reset()
  const html = await (await run('/')).text()
  assert.ok(html.includes('github\\.com\\/'), 'pattern backslashes were eaten by the template literal')
  assert.ok(!html.includes('!重要;'), 'CSS uses !重要 instead of !important')
  const m = html.match(/pattern="([^"]+)"/)
  assert.ok(m, 'input pattern attribute missing')
  assert.doesNotThrow(() => new RegExp(m[1]), 'served pattern is not a valid regex: ' + m[1])
})

// ---- report ----------------------------------------------------------------
let failed = 0
for (const [st, name, msg] of results) {
  if (st === 'FAIL') failed++
  console.log(`${st}  ${name}${msg ? '\n      -> ' + msg : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
