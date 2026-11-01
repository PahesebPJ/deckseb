import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startUiServer, type UiServerInstance } from '../src/cli/ui-server.ts'

describe('ui-server HTTP API & macOS view', () => {
  let serverInstance: UiServerInstance
  let baseUrl: string

  before(async () => {
    // Port 0 lets the OS pick an available ephemeral port
    serverInstance = await startUiServer({ port: 0, openBrowser: false })
    baseUrl = serverInstance.url
  })

  after(async () => {
    if (serverInstance) {
      await serverInstance.close()
    }
  })

  it('serves the macOS Sequoia Mission Control HTML on GET /', async () => {
    const res = await fetch(`${baseUrl}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()
    assert.match(html, /deckseb v0\.1\.0 — Mission Control/)
    assert.match(html, /traffic-lights/)
    assert.match(html, /terminal-container/)
    assert.match(html, /mac-inspector/)
  })

  it('serves the macos.css stylesheet on GET /styles/macos.css', async () => {
    const res = await fetch(`${baseUrl}/styles/macos.css`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/css/)
    const css = await res.text()
    assert.ok(css.length > 100)
  })

  it('returns ecosystem snapshot on GET /api/snapshot', async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.optionalMode, true)
    assert.ok(Array.isArray(data.availableHosts))
    assert.ok(typeof data.hubsebDetected === 'boolean')
  })

  it('returns segmented artifacts on GET /api/artifacts', async () => {
    const res = await fetch(`${baseUrl}/api/artifacts`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data))
  })

  it('detects plans in text payload on POST /api/detect', async () => {
    const planMarkdown = `# Plan de Arquitectura\n\n\`\`\`mermaid\ngraph TD;\nA-->B;\n\`\`\``
    const res = await fetch(`${baseUrl}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: planMarkdown }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.detected)
    assert.equal(data.detected.title, 'Plan de Arquitectura')
    assert.equal(data.detected.segment, 'plans')
    assert.equal(data.detected.mermaidBlocks.length, 1)
  })

  it('handles memoseb sync endpoint on POST /api/sync-memoseb', async () => {
    const res = await fetch(`${baseUrl}/api/sync-memoseb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Prueba de Memoria HTTP',
        content: 'Contenido de prueba',
        category: 'architecture',
      }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(typeof data.success === 'boolean')
  })

  it('returns 404 on unknown paths', async () => {
    const res = await fetch(`${baseUrl}/api/unknown-endpoint`)
    assert.equal(res.status, 404)
    const data = await res.json()
    assert.equal(data.error, 'Not found')
  })
})
