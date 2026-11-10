import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { startUiServer, type UiServerInstance } from '../src/cli/ui-server.ts'

describe('ui-server HTTP API & Minimalist Plan Viewer', () => {
  let serverInstance: UiServerInstance
  let baseUrl: string
  let tempDir: string

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-test-'))
    // Port 0 lets the OS pick an available ephemeral port
    serverInstance = await startUiServer({
      port: 0,
      openBrowser: false,
      openWindow: false,
      vaultRoot: path.join(tempDir, 'vault'),
    })
    baseUrl = serverInstance.url
  })

  after(async () => {
    if (serverInstance) {
      await serverInstance.close()
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('serves the Minimalist Plan Viewer HTML on GET /', async () => {
    const res = await fetch(`${baseUrl}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()

    assert.match(html, /deckseb — Visor Editorial de Planes/)
    assert.match(html, /class="plan-shell"/)
    assert.match(html, /class="traffic-lights"/)
    assert.match(html, /class="plan-workspace"/)
    assert.match(html, /id="planSidebar"/)
    assert.match(html, /id="planSearchInput"/)
    assert.match(html, /id="planList"/)
    assert.match(html, /id="planCountBadge"/)
    assert.doesNotMatch(html, /id="liveIndicator"/)
    assert.doesNotMatch(html, /id="planSelector"/)
    assert.doesNotMatch(html, /En vivo/)

    assert.match(html, /id="themeToggleBtn"/)
    assert.match(html, /id="emptyState"/)
    assert.match(html, /id="planView"/)
    assert.match(html, /id="planTitle"/)
    assert.match(html, /id="planPath"/)
    assert.match(html, /id="planTimestamp"/)
    assert.match(html, /id="planContent"/)

    // Confirm pure JS GFM and Mermaid renderer elements exist in script
    assert.match(html, /renderMarkdown/)
    assert.match(html, /renderMermaidSvg/)
    assert.match(html, /gh-alert/)
    assert.match(html, /plan-table/)
  })

  it('serves the macos.css stylesheet on GET /styles/macos.css', async () => {
    const res = await fetch(`${baseUrl}/styles/macos.css`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/css/)
    const css = await res.text()
    assert.ok(css.length > 200)
    assert.match(css, /\[data-theme="dark"\]/)
    assert.match(css, /#090d12/)
    assert.match(css, /#0f151d/)
    assert.match(css, /\[data-theme="light"\]/)
    assert.match(css, /#f8fafc/)
    assert.match(css, /#ffffff/)
    assert.match(css, /\.plan-reader/)
    assert.match(css, /\.plan-article/)
    assert.match(css, /\.plan-table/)
    assert.match(css, /\.gh-alert/)
    assert.match(css, /\.mermaid-card/)
  })

  it('returns empty plans state initially on GET /api/plans', async () => {
    const res = await fetch(`${baseUrl}/api/plans`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.plans))
  })

  it('returns plans array on GET /api/artifacts', async () => {
    const res = await fetch(`${baseUrl}/api/artifacts`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data))
  })

  it('publishes and detects a plan on POST /api/plans', async () => {
    const planMarkdown = `# Plan de Migración Arquitectónica

> [!IMPORTANT]
> Este cambio no debe alterar la compatibilidad con hubseb.

## Matriz de Despacho

| Paso | Especialista | Archivo |
| :--- | :--- | :--- |
| 1 | Orion | src/cli/ui-server.ts |

\`\`\`mermaid
flowchart TD
  A["Diseño"] --> B["Implementación"]
  B --> C["Validación"]
\`\`\`
`

    const res = await fetch(`${baseUrl}/api/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: planMarkdown,
        filePath: 'plans/test-migration.md',
        title: 'Plan de Migración Arquitectónica',
      }),
    })

    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.detected)
    assert.equal(data.detected.title, 'Plan de Migración Arquitectónica')
    assert.equal(data.detected.segment, 'plans')
    assert.equal(data.detected.mermaidBlocks.length, 1)

    // Verify it is now visible in GET /api/plans
    const listRes = await fetch(`${baseUrl}/api/plans`)
    const listData = await listRes.json()
    assert.ok(listData.plans.length >= 1)
    assert.equal(listData.plans[0]?.title, 'Plan de Migración Arquitectónica')
    assert.equal(listData.activePlan?.title, 'Plan de Migración Arquitectónica')
  })

  it('receives Server-Sent Events on GET /api/events', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

    const reader = res.body?.getReader()
    assert.ok(reader)

    // Read initial snapshot chunk
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    assert.match(text, /"type":"init"/)

    controller.abort()
  })

  it('supports initialPlanFile option when launching ui server', async () => {
    const planFile = path.join(tempDir, 'sample-plan.md')
    await fs.writeFile(
      planFile,
      '# Plan Inicial de Prueba\n\nContenido de prueba para el visor.',
      'utf8'
    )

    const server2 = await startUiServer({
      port: 0,
      openBrowser: false,
      openWindow: false,
      initialPlanFile: planFile,
      vaultRoot: path.join(tempDir, 'vault2'),
    })

    try {
      const active = server2.getActivePlan()
      assert.ok(active)
      assert.equal(active?.title, 'Plan Inicial de Prueba')
    } finally {
      await server2.close()
    }
  })

  it('supports silent publishPlan and orders active plans correctly', async () => {
    const watchDir = path.join(tempDir, 'watch-test')
    await fs.mkdir(watchDir, { recursive: true })

    // Create older plan
    const olderPlan = path.join(watchDir, 'older-plan.md')
    await fs.writeFile(
      olderPlan,
      '# Plan Anterior\n\n```mermaid\ngraph TD\n  A --> B\n```',
      'utf8'
    )

    // Wait slightly so mtimes differ
    await new Promise((r) => setTimeout(r, 50))

    // Create newer plan
    const newerPlan = path.join(watchDir, 'newer-plan.md')
    await fs.writeFile(
      newerPlan,
      '# Plan Más Reciente\n\n```mermaid\ngraph TD\n  C --> D\n```',
      'utf8'
    )

    const server3 = await startUiServer({
      port: 0,
      openBrowser: false,
      openWindow: false,
      watchDirs: [watchDir],
      vaultRoot: path.join(tempDir, 'vault3'),
    })

    try {
      // Allow initial scan to run
      await new Promise((r) => setTimeout(r, 200))
      const active = server3.getActivePlan()
      assert.ok(active)
      // The newest plan should be the active plan
      assert.equal(active?.title, 'Plan Más Reciente')
      assert.equal(server3.getPlans()[0]?.title, 'Plan Más Reciente')

      // Test publishPlan with silent = true
      await server3.publishPlan(
        {
          id: 'manual-test-id',
          sessionId: 'test-session',
          projectSlug: 'test',
          segment: 'plans',
          title: 'Plan Manual Silencioso',
          filePath: path.join(watchDir, 'manual.md'),
          content: '# Plan Manual Silencioso',
          mermaidBlocks: [],
          detectedAt: new Date().toISOString(),
          syncedToMemoseb: false,
        },
        'plan:created',
        true
      )
      assert.equal(server3.getActivePlan()?.title, 'Plan Manual Silencioso')
      assert.equal(server3.getPlans()[0]?.title, 'Plan Manual Silencioso')

      // Now update the older plan to verify it moves to index 0 and becomes activePlan
      await server3.publishPlan(
        {
          id: 'manual-test-id-2',
          sessionId: 'test-session',
          projectSlug: 'test',
          segment: 'plans',
          title: 'Plan Anterior',
          filePath: olderPlan,
          content: '# Plan Anterior Actualizado',
          mermaidBlocks: [],
          detectedAt: new Date().toISOString(),
          syncedToMemoseb: false,
        },
        'plan:updated',
        false
      )
      assert.equal(server3.getActivePlan()?.title, 'Plan Anterior')
      assert.equal(server3.getPlans()[0]?.title, 'Plan Anterior')
      assert.equal(server3.getPlans()[0]?.content, '# Plan Anterior Actualizado')
    } finally {
      await server3.close()
    }
  })
})
