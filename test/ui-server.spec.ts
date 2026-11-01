import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startUiServer, type UiServerInstance } from '../src/cli/ui-server.ts'

describe('ui-server HTTP API & Sixzone Bento view', () => {
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

  it('serves the Sixzone Bento Mission Control HTML on GET /', async () => {
    const res = await fetch(`${baseUrl}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()
    assert.match(html, /deckseb v0\.1\.0 — Mission Control/)
    assert.match(html, /bento-shell/)
    assert.match(html, /traffic-lights/)
    assert.match(html, /id="leftSidebar"/)
    assert.match(html, /terminal-container/)
    assert.match(html, /mac-inspector/)
  })

  it('serves the macos.css stylesheet on GET /styles/macos.css', async () => {
    const res = await fetch(`${baseUrl}/styles/macos.css`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/css/)
    const css = await res.text()
    assert.ok(css.length > 100)
    assert.match(css, /--bento-bg-root/)
    assert.match(css, /--bento-surface/)
  })

  it('lists active sessions including initial session on GET /api/terminal/sessions', async () => {
    const res = await fetch(`${baseUrl}/api/terminal/sessions`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.sessions))
    assert.ok(data.sessions.length >= 1)
    const initial = data.sessions[0]
    assert.ok(initial.id)
    assert.equal(initial.hostId, 'shell')
    assert.equal(typeof initial.pid, 'number')
    assert.ok(initial.pid > 0)
    assert.equal(initial.status, 'running')
    assert.ok(Array.isArray(initial.lines))
  })

  it('creates a real terminal session with numeric pid on POST /api/terminal/create', async () => {
    const res = await fetch(`${baseUrl}/api/terminal/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: 'antigravity', title: 'antigravity · test' }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.session)
    assert.equal(data.session.hostId, 'antigravity')
    assert.equal(typeof data.session.pid, 'number')
    assert.ok(data.session.pid > 0)
    assert.equal(data.session.status, 'running')
    assert.ok(Array.isArray(data.session.lines))
  })

  it('executes real command echo SIXZONE_REAL_EXEC_OK on POST /api/terminal/input', async () => {
    // 1. Create a dedicated session
    const createRes = await fetch(`${baseUrl}/api/terminal/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: 'shell', title: 'Exec Test Session' }),
    })
    const createData = await createRes.json()
    const sessionId = createData.session.id

    // 2. Execute real echo command
    const res = await fetch(`${baseUrl}/api/terminal/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        command: 'echo "SIXZONE_REAL_EXEC_OK"',
      }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.match(data.stdout, /SIXZONE_REAL_EXEC_OK/)
    const hasLine = data.lines.some((l: string) => l.includes('SIXZONE_REAL_EXEC_OK'))
    assert.ok(hasLine, 'session output lines should contain SIXZONE_REAL_EXEC_OK')
  })

  it('handles /plan command and returns detectedArtifact on POST /api/terminal/input', async () => {
    const listRes = await fetch(`${baseUrl}/api/terminal/sessions`)
    const listData = await listRes.json()
    const sessionId = listData.sessions[0].id

    const res = await fetch(`${baseUrl}/api/terminal/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, command: '/plan' }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.ok(data.detectedArtifact)
    assert.ok(data.detectedArtifact.title)
    assert.ok(Array.isArray(data.detectedArtifact.mermaidBlocks))
  })

  it('handles /compact command and updates token quota on POST /api/terminal/input', async () => {
    const listRes = await fetch(`${baseUrl}/api/terminal/sessions`)
    const listData = await listRes.json()
    const sessionId = listData.sessions[0].id

    const res = await fetch(`${baseUrl}/api/terminal/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, command: '/compact' }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.ok(data.tokenUsage)
    assert.ok(data.tokenUsage.remainingPercent > 0)
  })

  it('closes and kills a session on POST /api/terminal/kill', async () => {
    // 1. Create a session to kill
    const createRes = await fetch(`${baseUrl}/api/terminal/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: 'codex', title: 'Session To Kill' }),
    })
    const createData = await createRes.json()
    const sessionId = createData.session.id

    // 2. Kill it
    const killRes = await fetch(`${baseUrl}/api/terminal/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    assert.equal(killRes.status, 200)
    const killData = await killRes.json()
    assert.equal(killData.success, true)
    assert.equal(killData.sessionId, sessionId)

    // 3. Verify it is no longer listed in active sessions
    const listRes = await fetch(`${baseUrl}/api/terminal/sessions`)
    const listData = await listRes.json()
    assert.ok(!listData.sessions.some((s: any) => s.id === sessionId))
  })

  it('fetches memoseb live context on GET /api/memoseb/memories', async () => {
    const res = await fetch(`${baseUrl}/api/memoseb/memories`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.memories))
    assert.ok(typeof data.rawText === 'string')
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
    const planMarkdown = `# Plan de Arquitectura Sixzone\n\n\`\`\`mermaid\ngraph TD;\nA-->B;\n\`\`\``
    const res = await fetch(`${baseUrl}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: planMarkdown }),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.detected)
    assert.equal(data.detected.title, 'Plan de Arquitectura Sixzone')
    assert.equal(data.detected.segment, 'plans')
    assert.equal(data.detected.mermaidBlocks.length, 1)
  })

  it('handles memoseb sync endpoint on POST /api/sync-memoseb', async () => {
    const res = await fetch(`${baseUrl}/api/sync-memoseb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Prueba de Memoria Sixzone',
        content: 'Contenido de prueba Sixzone',
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
