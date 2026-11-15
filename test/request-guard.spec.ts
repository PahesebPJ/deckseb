import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  MAX_BODY_BYTES,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
  resolvePlanFile,
} from '../src/cli/request-guard.ts'
import { startUiServer, type UiServerInstance } from '../src/cli/ui-server.ts'

describe('request-guard primitives', () => {
  it('accepts only loopback Host headers on the bound port', () => {
    assert.ok(isAllowedHost('127.0.0.1:4321', 4321))
    assert.ok(isAllowedHost('localhost:4321', 4321))
    assert.ok(isAllowedHost('LOCALHOST:4321', 4321))
    assert.ok(isAllowedHost('[::1]:4321', 4321))
    assert.ok(!isAllowedHost('127.0.0.1:9999', 4321), 'wrong port')
    assert.ok(!isAllowedHost('attacker.example:4321', 4321), 'DNS rebinding name')
    assert.ok(!isAllowedHost('127.0.0.1.attacker.example:4321', 4321))
    assert.ok(!isAllowedHost(undefined, 4321))
  })

  it('accepts Origin-less clients and same-origin pages only', () => {
    assert.ok(isAllowedOrigin(undefined, 4321), 'Node fetch from the CLI sends no Origin')
    assert.ok(isAllowedOrigin('http://127.0.0.1:4321', 4321))
    assert.ok(isAllowedOrigin('http://localhost:4321', 4321))
    assert.ok(!isAllowedOrigin('https://evil.example', 4321))
    assert.ok(!isAllowedOrigin('null', 4321), 'sandboxed iframes and file:// pages')
    assert.ok(!isAllowedOrigin('http://127.0.0.1:1234', 4321), 'another local app')
  })

  it('treats an explicit non-loopback bind host as an allowed name', () => {
    assert.ok(isAllowedHost('deck.lan:4321', 4321, 'deck.lan'))
    assert.ok(!isAllowedHost('0.0.0.0:4321', 4321, '0.0.0.0'), 'wildcard binds add nothing')
  })

  it('requires an application/json media type', () => {
    assert.ok(isJsonContentType('application/json'))
    assert.ok(isJsonContentType('Application/JSON; charset=utf-8'))
    assert.ok(!isJsonContentType('text/plain'))
    assert.ok(!isJsonContentType('application/x-www-form-urlencoded'))
    assert.ok(!isJsonContentType(undefined))
  })

  describe('resolvePlanFile', () => {
    let dir: string
    before(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-guard-'))
      await fs.writeFile(path.join(dir, 'plan.md'), '# Plan\n')
      await fs.writeFile(path.join(dir, 'id_rsa'), 'secret')
      await fs.mkdir(path.join(dir, 'folder.md'))
      await fs.writeFile(path.join(dir, 'huge.md'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'))
    })
    after(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('resolves regular Markdown files', async () => {
      const res = await resolvePlanFile(path.join(dir, 'plan.md'))
      assert.deepEqual(res, { ok: true, path: await fs.realpath(path.join(dir, 'plan.md')) })
    })

    it('refuses non-Markdown, directories, missing and oversized files', async () => {
      assert.equal((await resolvePlanFile(path.join(dir, 'id_rsa'))).ok, false)
      assert.equal((await resolvePlanFile(path.join(dir, 'folder.md'))).ok, false)
      assert.equal((await resolvePlanFile(path.join(dir, 'nope.md'))).ok, false)
      assert.equal((await resolvePlanFile(path.join(dir, 'huge.md'))).ok, false)
      assert.equal((await resolvePlanFile(42)).ok, false)
      assert.equal((await resolvePlanFile('')).ok, false)
    })

    it('refuses a .md symlink that points at a secret', { skip: process.platform === 'win32' }, async () => {
      const link = path.join(dir, 'innocent.md')
      await fs.symlink(path.join(dir, 'id_rsa'), link)
      const res = await resolvePlanFile(link)
      assert.equal(res.ok, false)
      assert.equal(res.ok === false && res.status, 403)
    })
  })
})

function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    // A regression that lets a request through to SSE would otherwise hang the suite.
    req.setTimeout(5_000, () => req.destroy(new Error('request timed out')))
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('ui-server hardening against cross-origin abuse', () => {
  let server: UiServerInstance
  let dir: string
  let secret: string
  let plan: string

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-hardening-'))
    secret = path.join(dir, 'id_rsa')
    plan = path.join(dir, 'plan.md')
    await fs.writeFile(secret, 'TOP-SECRET-KEY-MATERIAL')
    await fs.writeFile(plan, '# Plan de implementación\n\n## Pasos\n\n1. Uno\n')
    server = await startUiServer({ port: 0, vaultRoot: path.join(dir, 'vault'), disableAutoPoll: true })
  })

  after(async () => {
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const host = (): string => `127.0.0.1:${server.port}`
  const jsonPost = (body: unknown, headers: Record<string, string> = {}) =>
    rawRequest(server.port, {
      method: 'POST',
      path: '/api/plans',
      headers: { Host: host(), 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  it('never emits permissive CORS headers', async () => {
    const res = await rawRequest(server.port, { path: '/api/plans', headers: { Host: host() } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['x-frame-options'], 'DENY')
  })

  it('rejects a cross-origin simple POST that tries to read a local file', async () => {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/plans',
      headers: { Host: host(), Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ filePath: secret }),
    })
    assert.equal(res.status, 403)
    assert.doesNotMatch(res.body, /TOP-SECRET/)
  })

  it('rejects DNS-rebinding requests with a foreign Host', async () => {
    const res = await rawRequest(server.port, { path: '/api/plans', headers: { Host: `attacker.example:${server.port}` } })
    assert.equal(res.status, 403)
    assert.doesNotMatch(res.body, /"plans"/)
  })

  it('rejects preflights instead of approving them', async () => {
    const res = await rawRequest(server.port, {
      method: 'OPTIONS',
      path: '/api/plans',
      headers: { Host: host(), 'Access-Control-Request-Method': 'POST' },
    })
    assert.equal(res.status, 405)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })

  it('requires JSON bodies on POST', async () => {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/plans',
      headers: { Host: host(), 'Content-Type': 'text/plain' },
      body: JSON.stringify({ content: '# Plan' }),
    })
    assert.equal(res.status, 415)
  })

  it('refuses to read non-Markdown files even for same-origin clients', async () => {
    const res = await jsonPost({ filePath: secret })
    assert.equal(res.status, 403)
    assert.doesNotMatch(res.body, /TOP-SECRET/)
  })

  it('rejects bodies over the size limit', async () => {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/plans',
      headers: { Host: host(), 'Content-Type': 'application/json' },
      body: Buffer.alloc(MAX_BODY_BYTES + 1024, 'a'),
    }).catch((err: NodeJS.ErrnoException) => ({ status: err.code === 'ECONNRESET' || err.code === 'EPIPE' ? 413 : 0, headers: {}, body: '' }))
    assert.equal(res.status, 413)
  })

  it('still lets the CLI open a Markdown plan (Origin-less JSON POST)', async () => {
    const res = await jsonPost({ filePath: plan })
    assert.equal(res.status, 200)
    const json = JSON.parse(res.body) as { detected: { filePath: string; content: string } }
    assert.equal(json.detected.filePath, await fs.realpath(plan))
    assert.match(json.detected.content, /Plan de implementación/)
  })

  it('accepts same-origin requests from the viewer page', async () => {
    const res = await jsonPost({ content: '# Plan\n\n- a\n' }, { Origin: `http://${host()}` })
    assert.equal(res.status, 200)
  })
})
