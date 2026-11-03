import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync, { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { PACKAGE_ROOT } from '../src/version.ts'
import { deckClient } from '../src/services/deckClient.ts'
import {
  type ArtifactSegment,
  type DetectedArtifact,
  ARTIFACT_SEGMENTS,
  type ThemeMode,
} from '../src/types/deck.ts'
import {
  classifyArtifactSegment,
  defaultCategoryForSegment,
  detectPlanInStream,
  extractMermaidBlocks,
  slugifyTitle,
} from '../src/core/plan-detector.ts'
import { SegmentedArtifactVault } from '../src/core/segmented-vault.ts'
import { PlanWatcher } from '../src/core/plan-watcher.ts'
import { startUiServer, type UiServerInstance } from '../src/cli/ui-server.ts'
import {
  isDecksebRegistered,
  registerDecksebNode,
  unregisterDecksebNode,
} from '../src/cli/setup.ts'

/**
 * Deterministic SSE reader for Server-Sent Events streams.
 */
class SseEventCollector {
  private buffer = ''
  private queue: any[] = []
  private waitingResolve: ((val: any) => void) | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
    this.startPump()
  }

  private async startPump() {
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await this.reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        const chunks = this.buffer.split('\n\n')
        this.buffer = chunks.pop() ?? ''
        for (const chunk of chunks) {
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6).trim())
                if (this.waitingResolve) {
                  const resolve = this.waitingResolve
                  this.waitingResolve = null
                  resolve(parsed)
                } else {
                  this.queue.push(parsed)
                }
              } catch {
                // Ignore non-json chunk fragments
              }
            }
          }
        }
      }
    } catch {
      // Stream closed or aborted
    }
  }

  async waitForNext(timeoutMs = 5000): Promise<any> {
    if (this.queue.length > 0) {
      return this.queue.shift()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waitingResolve = null
        reject(new Error(`Timeout waiting for SSE event after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waitingResolve = (val) => {
        clearTimeout(timer)
        resolve(val)
      }
    })
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {})
  }
}

describe('integration-ui-bridge e2e', () => {
  describe('deckClient minimal plan viewer operations and event dispatch', () => {
    it('submits plan, extracts Mermaid diagrams, and emits deck:artifact-detected event', async () => {
      let emittedArtifact: DetectedArtifact | null = null
      const unsubscribe = deckClient.on('deck:artifact-detected', (art) => {
        emittedArtifact = art
      })

      try {
        const planMarkdown = `# Plan de Modernización de Núcleo Editorial

Plan táctico para la visualización pasiva de planes en deckseb.

\`\`\`mermaid
flowchart TD
  In["Recepción de Plan"] --> Parse["Extracción Mermaid"]
  Parse --> SVG["Renderizado SVG"]
  SVG --> View["Visor Editorial"]
\`\`\`

### Matriz de Despacho:
| Especialista | Rol | Estado |
| :--- | :--- | :--- |
| Orion | developer | listo |
| Elio | qa-automation | validando |
`

        const submitted = await deckClient.submitPlan({
          title: 'Plan de Modernización de Núcleo Editorial',
          content: planMarkdown,
          filePath: 'plans/001-modernization.md',
          projectSlug: 'deckseb-e2e',
        })

        assert.ok(submitted, 'submitPlan should return a valid DetectedArtifact')
        assert.equal(submitted.title, 'Plan de Modernización de Núcleo Editorial')
        assert.equal(submitted.segment, 'plans')
        assert.equal(submitted.projectSlug, 'deckseb-e2e')
        assert.equal(submitted.mermaidBlocks.length, 1)
        assert.match(submitted.mermaidBlocks[0]!, /flowchart TD/)

        // Confirm event listener was dispatched
        assert.ok(emittedArtifact !== null, 'deck:artifact-detected should be emitted')
        const art = emittedArtifact as DetectedArtifact
        assert.equal(art.id, submitted.id)
        assert.equal(art.title, submitted.title)

        // Verify artifact presence in listArtifacts
        const artifacts = await deckClient.listArtifacts({
          projectSlug: 'deckseb-e2e',
          segment: 'plans',
        })
        const found = artifacts.find((a) => a.id === submitted.id)
        assert.ok(found, 'Submitted plan should be listed in listArtifacts')
      } finally {
        unsubscribe()
      }
    })

    it('triggers simulated plan with multi-agent roster and Mermaid flow', async () => {
      let eventPayload: DetectedArtifact | null = null
      const unsubscribe = deckClient.on('deck:artifact-detected', (art) => {
        eventPayload = art
      })

      try {
        const simulated = deckClient.triggerSimulatedPlan('Simulated Multi-Agent Tactical Plan')

        assert.ok(simulated, 'triggerSimulatedPlan should return an artifact')
        assert.equal(simulated.title, 'Simulated Multi-Agent Tactical Plan')
        assert.equal(simulated.segment, 'plans')
        assert.ok(simulated.mermaidBlocks.length > 0, 'Should contain generated Mermaid blocks')
        assert.match(simulated.mermaidBlocks[0]!, /flowchart TD/)

        // Verify specialist personas mentioned in content
        assert.match(simulated.content, /Juno/)
        assert.match(simulated.content, /Orion/)
        assert.match(simulated.content, /Atlas/)
        assert.match(simulated.content, /Lyra/)

        // Verify event was fired
        assert.ok(eventPayload !== null, 'Event must be emitted on simulated plan')
        const payload = eventPayload as DetectedArtifact
        assert.equal(payload.id, simulated.id)
      } finally {
        unsubscribe()
      }
    })

    it('lists artifacts and filters by segment and projectSlug', async () => {
      const reviewPlan = await deckClient.submitPlan({
        title: 'Security Review & Quality Audit',
        content: '# Security Review\nAudit completed successfully with zero regressions.',
        filePath: 'reviews/sec-audit.md',
        projectSlug: 'filter-test-project',
      })

      assert.ok(reviewPlan)
      assert.equal(reviewPlan.segment, 'reviews')

      // Query by segment 'reviews'
      const reviewList = await deckClient.listArtifacts({
        projectSlug: 'filter-test-project',
        segment: 'reviews',
      })
      assert.ok(reviewList.some((a) => a.id === reviewPlan.id))

      // Query by segment 'plans' should not contain the review
      const plansList = await deckClient.listArtifacts({
        projectSlug: 'filter-test-project',
        segment: 'plans',
      })
      assert.ok(!plansList.some((a) => a.id === reviewPlan.id))
    })

    it('syncs artifact to memoseb in simulation mode', async () => {
      const plan = await deckClient.submitPlan({
        title: 'Architecture Sync Target',
        content: '# Architecture Sync Target\nDecoupled sync to memoseb.',
        filePath: 'plans/sync-target.md',
        projectSlug: 'sync-proj',
      })
      assert.ok(plan)

      const syncResult = await deckClient.syncArtifactToMemoseb(
        plan.id,
        'architecture',
        plan.title,
        ['e2e', 'deckClient']
      )

      assert.equal(syncResult.success, true)
      assert.ok(syncResult.memoryId, 'Should receive generated memoryId')

      const updatedList = await deckClient.listArtifacts({ projectSlug: 'sync-proj' })
      const syncedArt = updatedList.find((a) => a.id === plan.id)
      assert.equal(syncedArt?.syncedToMemoseb, true)
      assert.equal(syncedArt?.memosebCategory, 'architecture')
    })
  })

  describe('end-to-end reactive flow: PlanWatcher -> SegmentedVault -> UiServer -> SSE', () => {
    it('detects brain implementation_plan.md, persists in segmented vault, and broadcasts via SSE and HTTP', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-e2e-reactive-'))
      const brainDir = path.join(tmpDir, '.gemini', 'antigravity-cli', 'brain')
      const convId = 'session-reactive-e2e-789'
      const convDir = path.join(brainDir, convId)
      await fs.mkdir(convDir, { recursive: true })
      const vaultRoot = path.join(tmpDir, '.seb-vault')

      let serverInstance: UiServerInstance | null = null
      let sseCollector: SseEventCollector | null = null
      let watcher: PlanWatcher | null = null
      const abortController = new AbortController()

      try {
        // 1. Start UI Server attached to isolated vaultRoot
        serverInstance = await startUiServer({
          port: 0,
          host: '127.0.0.1',
          openBrowser: false,
          openWindow: false,
          vaultRoot,
          homeDir: tmpDir,
          disableAutoPoll: true,
        })
        const baseUrl = serverInstance.url

        // 2. Connect to SSE endpoint (/api/events)
        const sseRes = await fetch(`${baseUrl}/api/events`, {
          signal: abortController.signal,
        })
        assert.equal(sseRes.status, 200)
        assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/)
        sseCollector = new SseEventCollector(sseRes.body!)

        // First message must be 'init'
        const initMessage = await sseCollector.waitForNext(3000)
        assert.equal(initMessage.type, 'init')
        assert.ok(Array.isArray(initMessage.plans))

        // 3. Setup reactive PlanWatcher monitoring the simulated brain directory
        watcher = new PlanWatcher({
          homeDir: tmpDir,
          includeAntigravityBrain: true,
          pollIntervalMs: 50,
          projectSlug: 'reactive-proj',
        })

        // Hook watcher plan events directly into the UI server publisher
        watcher.onPlan(async (event) => {
          await serverInstance!.publishPlan(
            event.artifact,
            event.type === 'plan:updated' ? 'plan:updated' : 'plan:created'
          )
        })

        await watcher.start()

        // 4. Model creates implementation_plan.md with embedded Mermaid diagram
        const planFilePath = path.join(convDir, 'implementation_plan.md')
        const initialPlanMarkdown = `# Reactive Implementation Plan: Autonomous Bridge

## Proposed Changes
Implement reactive event propagation from model brain directly to editorial webview.

\`\`\`mermaid
flowchart TD
  Agent["Antigravity Model"] --> Brain["implementation_plan.md"]
  Brain --> Watcher["PlanWatcher"]
  Watcher --> Vault["SegmentedArtifactVault (.seb-vault)"]
  Vault --> UI["startUiServer"]
  UI --> SSE["GET /api/events"]
\`\`\`

## Verification Plan
Automated end-to-end integration tests.
`
        await fs.writeFile(planFilePath, initialPlanMarkdown, 'utf8')

        // Trigger immediate scan
        const scannedArtifacts = await watcher.scanNow()
        assert.equal(scannedArtifacts.length, 1)
        assert.equal(scannedArtifacts[0]!.title, 'Reactive Implementation Plan: Autonomous Bridge')
        assert.equal(scannedArtifacts[0]!.mermaidBlocks.length, 1)

        // 5. Verify real-time receipt via SSE
        const sseCreated = await sseCollector.waitForNext(4000)
        assert.equal(sseCreated.type, 'plan:created')
        assert.equal(
          sseCreated.artifact.title,
          'Reactive Implementation Plan: Autonomous Bridge'
        )
        assert.equal(sseCreated.artifact.segment, 'plans')
        assert.equal(sseCreated.artifact.mermaidBlocks.length, 1)
        assert.match(sseCreated.artifact.mermaidBlocks[0], /flowchart TD/)

        // 6. Verify filesystem persistence in SegmentedArtifactVault
        const slug = slugifyTitle('Reactive Implementation Plan: Autonomous Bridge')
        const expectedVaultPlanPath = path.join(
          vaultRoot,
          'reactive-proj',
          'plans',
          `${slug}.md`
        )
        assert.ok(
          fsSync.existsSync(expectedVaultPlanPath),
          `Vault plan file should exist at ${expectedVaultPlanPath}`
        )
        const savedMarkdown = await fs.readFile(expectedVaultPlanPath, 'utf8')
        assert.match(savedMarkdown, /Autonomous Bridge/)

        // Verify Mermaid extraction in diagrams/
        const expectedDiagramPath = path.join(
          vaultRoot,
          'reactive-proj',
          'diagrams',
          `${slug}-diagram-1.mmd`
        )
        assert.ok(
          fsSync.existsSync(expectedDiagramPath),
          `Vault diagram file should exist at ${expectedDiagramPath}`
        )
        const savedDiagram = await fs.readFile(expectedDiagramPath, 'utf8')
        assert.match(savedDiagram, /flowchart TD/)
        assert.match(savedDiagram, /Antigravity Model/)

        // 7. Verify HTTP GET /api/plans query reflects the new plan and active state
        const plansRes = await fetch(`${baseUrl}/api/plans`)
        assert.equal(plansRes.status, 200)
        const plansData = await plansRes.json()
        assert.ok(Array.isArray(plansData.plans))
        assert.ok(plansData.plans.length >= 1)
        assert.equal(
          plansData.activePlan?.title,
          'Reactive Implementation Plan: Autonomous Bridge'
        )

        // 8. Model updates implementation_plan.md -> verify plan:updated SSE event
        const updatedPlanMarkdown = `# Reactive Implementation Plan: Autonomous Bridge (V2)

## Proposed Changes
Refactored pipeline with low-latency event delivery.

\`\`\`mermaid
flowchart LR
  FS["File System"] --> Poller["PlanWatcher"]
  Poller --> SSE["SSE Broadcaster"]
\`\`\`
`
        await fs.writeFile(planFilePath, updatedPlanMarkdown, 'utf8')
        await watcher.scanNow()

        const sseUpdated = await sseCollector.waitForNext(4000)
        assert.equal(sseUpdated.type, 'plan:updated')
        assert.equal(
          sseUpdated.artifact.title,
          'Reactive Implementation Plan: Autonomous Bridge (V2)'
        )
        assert.match(sseUpdated.artifact.mermaidBlocks[0], /flowchart LR/)
      } finally {
        if (sseCollector) {
          await sseCollector.close()
        }
        abortController.abort()
        if (watcher) {
          watcher.stop()
        }
        if (serverInstance) {
          await serverInstance.close()
        }
        await fs.rm(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe('100% optional mode and clean ecosystem repository audit', () => {
    it('gracefully degrades when hubseb, crewseb, or memoseb are absent', async () => {
      const emptySandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-empty-sandbox-'))

      try {
        const topologyPath = path.join(emptySandbox, 'topology.json')

        // 1. isDecksebRegistered on missing topology
        const isRegistered = await isDecksebRegistered({ topologyPath })
        assert.equal(isRegistered, false)

        // 2. registerDecksebNode succeeds standalone without requiring hubseb daemon
        const regResult = await registerDecksebNode({ topologyPath })
        assert.equal(regResult.success, true)
        assert.equal(regResult.node.id, 'deckseb')
        assert.deepEqual(regResult.node.provides, ['ui.deck', 'artifacts.organizer'])

        // 3. unregisterDecksebNode cleans up without failure
        const unregResult = await unregisterDecksebNode({ topologyPath })
        assert.equal(unregResult.success, true)
        assert.equal(unregResult.removed, true)

        // 4. Vault gracefully reports degradation when syncing without memoseb binary
        const vault = new SegmentedArtifactVault({
          vaultRoot: emptySandbox,
          memosebBin: path.join(emptySandbox, 'non-existent-memoseb'),
        })

        const sampleArt: DetectedArtifact = {
          id: 'art-opt-01',
          sessionId: 'sess-01',
          projectSlug: 'demo',
          segment: 'plans',
          title: 'Demo Plan',
          filePath: 'plans/demo-plan.md',
          content: '# Demo Plan\n',
          mermaidBlocks: [],
          detectedAt: new Date().toISOString(),
          syncedToMemoseb: false,
          memosebCategory: 'architecture',
        }
        await vault.saveArtifact(sampleArt)

        const syncResult = await vault.syncArtifactToMemoseb(
          sampleArt.id,
          'architecture',
          { memosebBin: path.join(emptySandbox, 'non-existent-memoseb') }
        )
        assert.equal(syncResult.success, false)
        assert.match(
          syncResult.error ?? '',
          /not found/,
          'Should report graceful failure when memoseb binary is absent'
        )

        // 5. Client reports running in simulation mode outside Tauri
        assert.equal(deckClient.isRunningInTauri(), false)
      } finally {
        await fs.rm(emptySandbox, { recursive: true, force: true })
      }
    })

    it('verifies deckseb operations produce zero mutations on adjacent repositories', async () => {
      const candidatePaths = [
        path.resolve(PACKAGE_ROOT, '..', 'hubseb'),
        path.resolve(PACKAGE_ROOT, '..', 'crewseb'),
        path.resolve(PACKAGE_ROOT, '..', 'memoseb'),
      ]
      const existingRepos = candidatePaths.filter((p) => existsSync(path.join(p, '.git')))

      const getGitStatus = (repoDir: string) => {
        try {
          return execSync(`git -C "${repoDir}" status --short`, { encoding: 'utf8' }).trim()
        } catch {
          return ''
        }
      }

      // Record baseline status for any existing repos
      const baselines = new Map<string, string>()
      for (const repo of existingRepos) {
        baselines.set(repo, getGitStatus(repo))
      }

      // In CI environments where adjacent repos are not cloned, create an isolated dummy git repo
      let ciSandbox: string | null = null
      if (existingRepos.length === 0) {
        ciSandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-ci-adjacent-'))
        execSync(`git init -b main "${ciSandbox}"`)
        execSync(`git -C "${ciSandbox}" config user.name "DeckSeb CI"`)
        execSync(`git -C "${ciSandbox}" config user.email "deckseb-ci@paheseb.local"`)
        await fs.writeFile(path.join(ciSandbox, 'README.md'), '# Dummy adjacent repo\n')
        execSync(`git -C "${ciSandbox}" add README.md && git -C "${ciSandbox}" commit -m "initial"`)
        baselines.set(ciSandbox, getGitStatus(ciSandbox))
      }

      try {
        // Execute minimal deckClient operations
        await deckClient.submitPlan({
          title: 'Zero Mutation Verification Plan',
          content: '# Zero Mutation\nValidating non-intrusive deck operations.',
          filePath: 'plans/zero-mutation.md',
          projectSlug: 'deckseb-clean',
        })
        await deckClient.listArtifacts()
        deckClient.triggerSimulatedPlan('Simulated Plan in Isolation')
        await deckClient.setTheme('light')
        await deckClient.setTheme('dark')
        await deckClient.getTheme()

        // Verify status after operations: delta must be exactly zero across all tracked repos
        for (const [repoDir, baseline] of baselines.entries()) {
          const afterStatus = getGitStatus(repoDir)
          assert.equal(
            afterStatus,
            baseline,
            `deckseb operations must introduce zero mutations in ${path.basename(repoDir)}`
          )
        }
      } finally {
        if (ciSandbox) {
          await fs.rm(ciSandbox, { recursive: true, force: true })
        }
      }
    })
  })

  describe('macOS Sequoia light and dark theme switching and persistence', () => {
    it('persists and emits theme transitions between light and dark', async () => {
      // Setup mock DOM and storage environment
      const localStorageMap = new Map<string, string>()
      const domAttributes = new Map<string, string>()

      const originalWindow = (globalThis as Record<string, unknown>).window
      const originalLocalStorage = (globalThis as Record<string, unknown>).localStorage
      const originalDocument = (globalThis as Record<string, unknown>).document

      try {
        ;(globalThis as Record<string, unknown>).window = {
          __TAURI_INTERNALS__: undefined,
        }
        ;(globalThis as Record<string, unknown>).localStorage = {
          getItem: (key: string) => localStorageMap.get(key) ?? null,
          setItem: (key: string, val: string) => localStorageMap.set(key, val),
          removeItem: (key: string) => localStorageMap.delete(key),
          clear: () => localStorageMap.clear(),
        }
        ;(globalThis as Record<string, unknown>).document = {
          documentElement: {
            setAttribute: (name: string, val: string) => domAttributes.set(name, val),
            getAttribute: (name: string) => domAttributes.get(name) ?? null,
          },
        }

        // Switch to light theme
        const setLightResult = await deckClient.setTheme('light')
        assert.equal(setLightResult, 'light')

        const currentThemeLight = await deckClient.getTheme()
        assert.equal(currentThemeLight, 'light')
        assert.equal(
          localStorageMap.get('deckseb_theme'),
          'light',
          'Theme should be persisted in localStorage as "light"'
        )
        assert.equal(
          domAttributes.get('data-theme'),
          'light',
          'HTML documentElement should have data-theme="light"'
        )

        // Switch back to dark theme
        const setDarkResult = await deckClient.setTheme('dark')
        assert.equal(setDarkResult, 'dark')

        const currentThemeDark = await deckClient.getTheme()
        assert.equal(currentThemeDark, 'dark')
        assert.equal(
          localStorageMap.get('deckseb_theme'),
          'dark',
          'Theme should be persisted in localStorage as "dark"'
        )
        assert.equal(
          domAttributes.get('data-theme'),
          'dark',
          'HTML documentElement should have data-theme="dark"'
        )
      } finally {
        // Restore globals
        if (originalWindow !== undefined) {
          ;(globalThis as Record<string, unknown>).window = originalWindow
        } else {
          delete (globalThis as Record<string, unknown>).window
        }

        if (originalLocalStorage !== undefined) {
          ;(globalThis as Record<string, unknown>).localStorage = originalLocalStorage
        } else {
          delete (globalThis as Record<string, unknown>).localStorage
        }

        if (originalDocument !== undefined) {
          ;(globalThis as Record<string, unknown>).document = originalDocument
        } else {
          delete (globalThis as Record<string, unknown>).document
        }
      }
    })
  })
})
