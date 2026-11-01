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
  type AgentHostId,
  type ArtifactSegment,
  type DetectedArtifact,
  SUPPORTED_AGENT_HOSTS,
  type SessionContextQuota,
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
import {
  DEFAULT_CREW_PERSONAS,
  SebEcosystemObserver,
} from '../src/core/ecosystem-observer.ts'

describe('integration-ui-bridge e2e', () => {
  describe('terminal bridge across 6 agent hosts and interactive commands', () => {
    it('creates interactive terminal sessions for all 6 supported hosts', async () => {
      const hosts: AgentHostId[] = ['antigravity', 'claude', 'codex', 'opencode', 'herdr', 'shell']
      const createdSessions: string[] = []

      for (const hostId of hosts) {
        const session = await deckClient.createTerminal({
          hostId,
          title: `Session ${hostId} e2e`,
          cwd: '/home/alan/Documents/projects/deckseb',
        })

        assert.ok(session.id, `Session ID should be generated for host ${hostId}`)
        assert.equal(session.hostId, hostId)
        assert.equal(session.status, 'running')
        assert.ok(session.pid && session.pid > 0, `PID should be allocated for host ${hostId}`)
        createdSessions.push(session.id)
      }

      // Verify listTerminals includes all created sessions
      const activeTerminals = await deckClient.listTerminals()
      for (const hostId of hosts) {
        const found = activeTerminals.find((s) => s.hostId === hostId)
        assert.ok(found, `Host ${hostId} should appear in listTerminals()`)
      }

      // Cleanup created sessions
      for (const sessionId of createdSessions) {
        await deckClient.closeTerminal(sessionId)
      }
    })

    it('writes /plan command and dispatches deck:artifact-detected with Mermaid extraction', async () => {
      const session = await deckClient.createTerminal({
        hostId: 'antigravity',
        title: 'Plan dispatch test',
      })

      let emittedArtifact: DetectedArtifact | null = null
      const unsubscribe = deckClient.on('deck:artifact-detected', (art) => {
        emittedArtifact = art
      })

      try {
        await deckClient.writeTerminal(session.id, '/plan')

        assert.ok(emittedArtifact !== null, 'deck:artifact-detected event should be emitted')
        const art = emittedArtifact as DetectedArtifact
        assert.equal(art.sessionId, session.id)
        assert.equal(art.segment, 'plans')
        assert.ok(
          art.mermaidBlocks && art.mermaidBlocks.length > 0,
          'Emitted artifact should contain extracted Mermaid diagrams'
        )
        assert.match(
          art.mermaidBlocks[0]!,
          /flowchart|graph/,
          'Mermaid block should start with valid diagram syntax'
        )

        const history = deckClient.getTerminalHistory(session.id)
        assert.ok(
          history.some((l) => l.includes('Synthesizing plan with Mermaid')),
          'Terminal history should indicate plan synthesis'
        )
        assert.ok(
          history.some((l) => l.includes('Auto-opening Lateral Plan Drawer')),
          'Terminal history should indicate lateral drawer opening'
        )
      } finally {
        unsubscribe()
        await deckClient.closeTerminal(session.id)
      }
    })

    it('writes /compact command and dispatches deck:quota-updated with recovered token capacity', async () => {
      const session = await deckClient.createTerminal({
        hostId: 'claude',
        title: 'Compact dispatch test',
      })

      let quotaPayload: SessionContextQuota | null = null
      const unsubscribe = deckClient.on('deck:quota-updated', (quota) => {
        quotaPayload = quota
      })

      try {
        await deckClient.writeTerminal(session.id, '/compact')

        assert.ok(quotaPayload !== null, 'deck:quota-updated event should be emitted')
        const quota = quotaPayload as SessionContextQuota
        assert.equal(quota.sessionId, session.id)
        assert.ok(
          quota.remainingPercent > 50,
          'Compacted session should recover at least 50% remaining capacity'
        )
        assert.equal(quota.warningLevel, 'healthy')

        const history = deckClient.getTerminalHistory(session.id)
        assert.ok(
          history.some((l) => l.includes('Context window compacted successfully')),
          'Terminal history should confirm compaction'
        )
      } finally {
        unsubscribe()
        await deckClient.closeTerminal(session.id)
      }
    })

    it('writes "crewseb models list" and outputs complete specialist roster', async () => {
      const session = await deckClient.createTerminal({
        hostId: 'antigravity',
        title: 'Crewseb models test',
      })

      try {
        await deckClient.writeTerminal(session.id, 'crewseb models list')
        const history = deckClient.getTerminalHistory(session.id)

        assert.ok(history.some((l) => l.includes('cloud-tiered')))
        assert.ok(history.some((l) => l.includes('architect') && l.includes('Juno')))
        assert.ok(history.some((l) => l.includes('developer') && l.includes('Orion')))
        assert.ok(history.some((l) => l.includes('qa-automation') && l.includes('Atlas')))
        assert.ok(history.some((l) => l.includes('researcher') && l.includes('Theo')))
      } finally {
        await deckClient.closeTerminal(session.id)
      }
    })

    it('writes "memoseb context" and dispatches deck:memo-event', async () => {
      const session = await deckClient.createTerminal({
        hostId: 'shell',
        title: 'Memoseb context test',
      })

      let memoPayload: unknown = null
      const unsubscribe = deckClient.on('deck:memo-event', (ev) => {
        memoPayload = ev
      })

      try {
        await deckClient.writeTerminal(session.id, 'memoseb context')

        assert.ok(memoPayload, 'deck:memo-event should be emitted')
        const ev = memoPayload as { action: string; tokenCount: number }
        assert.equal(ev.action, 'context')
        assert.equal(ev.tokenCount, 980)

        const history = deckClient.getTerminalHistory(session.id)
        assert.ok(
          history.some((l) => l.includes('Total Context Tokens Injected')),
          'Terminal output should reflect injected tokens'
        )
      } finally {
        unsubscribe()
        await deckClient.closeTerminal(session.id)
      }
    })
  })

  describe('automatic plan detection and segmented artifact vault', () => {
    it('detects Mermaid blocks and persists artifacts into the 5 segmented directories', async () => {
      const tmpVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-seg-vault-'))

      try {
        const vault = new SegmentedArtifactVault({ vaultRoot: tmpVaultDir })
        const projectSlug = 'deckseb-e2e'

        const segmentsData: Array<{
          segment: ArtifactSegment
          filePath: string
          content: string
          expectedTitle: string
        }> = [
          {
            segment: 'plans',
            filePath: 'plans/001-native-desktop-plan.md',
            content: `# Native Desktop Implementation Plan

Roadmap and multi-worktree execution strategy.

\`\`\`mermaid
flowchart TD
  A[Design] --> B[Core Engine]
  B --> C[Tauri Webview]
\`\`\`
`,
            expectedTitle: 'Native Desktop Implementation Plan',
          },
          {
            segment: 'diagrams',
            filePath: 'diagrams/002-topology-overview.mmd',
            content: `# Topology Diagram

\`\`\`mermaid
graph LR
  Hub[hubseb] --- Deck[deckseb]
  Hub --- Crew[crewseb]
\`\`\`
`,
            expectedTitle: 'Topology Diagram',
          },
          {
            segment: 'specs',
            filePath: 'specs/003-terminal-bridge.feature',
            content: `# Terminal Bridge Specification

Scenario: Spawning multi-host PTY sessions
  Given an agent host identifier
  When the user opens a new tab
  Then an isolated PTY process is started

\`\`\`mermaid
sequenceDiagram
  UI->>Bridge: createTerminal(hostId)
  Bridge-->>UI: session { id, pid }
\`\`\`
`,
            expectedTitle: 'Terminal Bridge Specification',
          },
          {
            segment: 'reviews',
            filePath: 'reviews/004-security-audit.md',
            content: `# Security Audit and Code Review Report

Findings for sandboxed worktrees and PTY isolation.

\`\`\`mermaid
graph TD
  Caller --> Guard[Permission Guard]
  Guard --> SafeExecution
\`\`\`
`,
            expectedTitle: 'Security Audit and Code Review Report',
          },
          {
            segment: 'post-mortems',
            filePath: 'post-mortems/005-ipc-latency-rca.md',
            content: `# Root Cause Analysis: IPC Latency Regression

Incident review and memory barrier analysis.

\`\`\`mermaid
flowchart TD
  EventFlood --> Backlog
  Backlog --> BufferSaturation
\`\`\`
`,
            expectedTitle: 'Root Cause Analysis: IPC Latency Regression',
          },
        ]

        for (const item of segmentsData) {
          // 1. Detect plan in stream
          const detected = detectPlanInStream(
            'sess-e2e-01',
            projectSlug,
            item.content,
            item.filePath
          )

          assert.ok(detected, `Artifact for segment ${item.segment} should be detected`)
          assert.equal(detected.segment, item.segment)
          assert.equal(detected.title, item.expectedTitle)
          assert.ok(
            detected.mermaidBlocks.length > 0,
            `Mermaid blocks should be extracted for segment ${item.segment}`
          )

          // 2. Persist in SegmentedArtifactVault
          const saved = await vault.saveArtifact(detected)
          assert.ok(
            fsSync.existsSync(saved.filePath),
            `Persisted markdown file should exist at ${saved.filePath}`
          )

          // Verify file is placed in correct segmented folder
          const expectedFolder = path.join(tmpVaultDir, projectSlug, item.segment)
          assert.ok(
            saved.filePath.startsWith(expectedFolder),
            `File path ${saved.filePath} should reside inside ${expectedFolder}`
          )

          // Verify Mermaid extraction in diagrams/<slug>-diagram-1.mmd
          const slug = slugifyTitle(detected.title)
          const diagramFile = path.join(
            tmpVaultDir,
            projectSlug,
            'diagrams',
            `${slug}-diagram-1.mmd`
          )
          assert.ok(
            fsSync.existsSync(diagramFile),
            `Extracted mermaid file should exist at ${diagramFile}`
          )
          const diagramCode = await fs.readFile(diagramFile, 'utf8')
          assert.match(diagramCode, /flowchart|graph|sequenceDiagram/)
        }

        // 3. Verify manifest contents and listing by segment
        const allArtifacts = await vault.listArtifacts({ projectSlug })
        assert.equal(allArtifacts.length, 5)

        for (const item of segmentsData) {
          const filtered = await vault.listArtifacts({
            projectSlug,
            segment: item.segment,
          })
          assert.equal(filtered.length, 1)
          assert.equal(filtered[0]?.segment, item.segment)
        }
      } finally {
        await fs.rm(tmpVaultDir, { recursive: true, force: true })
      }
    })
  })

  describe('100% optional mode and clean ecosystem repository audit', () => {
    it('gracefully degrades with optionalMode: true when hubseb, crewseb, or memoseb are absent', async () => {
      const emptySandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-empty-sandbox-'))

      try {
        const observer = new SebEcosystemObserver({
          topologyPath: path.join(emptySandbox, 'topology.json'),
          crewModelsPath: path.join(emptySandbox, 'crewseb-models.json'),
          crewPersonasPath: path.join(emptySandbox, 'crewseb-personas.json'),
          memosebDbPath: path.join(emptySandbox, 'vault.db'),
          homeDir: emptySandbox,
        })

        const snapshot = observer.getSnapshot()

        assert.equal(snapshot.optionalMode, true)
        assert.equal(snapshot.hubsebDetected, false)
        assert.equal(snapshot.crewsebDetected, false)
        assert.equal(snapshot.memosebDetected, false)
        assert.equal(snapshot.herdrDetected, false)

        // Fallbacks remain intact
        assert.equal(snapshot.preset, 'default')
        assert.deepEqual(snapshot.availableHosts, ['shell'])
        assert.equal(snapshot.personas.architect, 'Juno')
        assert.equal(snapshot.personas['qa-automation'], 'Elio')
        assert.equal(snapshot.vaultStats.projectCount, 0)
        assert.equal(snapshot.vaultStats.memoryCount, 0)
        assert.equal(snapshot.vaultStats.totalTokens, 0)

        // Client service snapshot also indicates optionalMode
        const clientSnap = await deckClient.getEcosystemSnapshot()
        assert.equal(clientSnap.optionalMode, true)

        // Vault gracefully reports degradation when syncing without memoseb
        const vault = new SegmentedArtifactVault({ vaultRoot: emptySandbox })
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
          { memosebBin: path.join(emptySandbox, 'missing-memoseb') }
        )
        assert.equal(syncResult.success, false)
        assert.ok(
          syncResult.error?.includes('not found'),
          'Should report graceful failure when memoseb binary is absent'
        )
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
        // Execute comprehensive deckClient operations
        const testSession = await deckClient.createTerminal({
          hostId: 'antigravity',
          title: 'Zero mutation validation terminal',
        })
        await deckClient.writeTerminal(testSession.id, '/plan')
        await deckClient.writeTerminal(testSession.id, '/compact')
        await deckClient.writeTerminal(testSession.id, 'crewseb models list')
        await deckClient.writeTerminal(testSession.id, 'memoseb context')
        await deckClient.getEcosystemSnapshot()
        await deckClient.closeTerminal(testSession.id)

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
