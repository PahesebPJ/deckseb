import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PlanWatcher } from '../src/core/plan-watcher.ts'
import type { PlanWatcherEvent } from '../src/types/deck.ts'

describe('plan-watcher', () => {
  it('detects creation and update of implementation_plan.md in simulated antigravity brain structure', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-brain-test-'))
    const brainDir = path.join(tmpHome, '.gemini', 'antigravity-cli', 'brain')
    const convId = 'conv-456-def'
    const convDir = path.join(brainDir, convId)
    await fs.mkdir(convDir, { recursive: true })

    const events: PlanWatcherEvent[] = []
    const watcher = new PlanWatcher({
      homeDir: tmpHome,
      includeAntigravityBrain: true,
      pollIntervalMs: 50,
      projectSlug: 'test-project',
    })

    const unsubscribe = watcher.onPlan((event) => {
      events.push(event)
    })

    try {
      await watcher.start()

      // 1. Create implementation_plan.md
      const planFile = path.join(convDir, 'implementation_plan.md')
      const initialContent = `# Implementation Plan: Core Watcher

## Proposed Changes
Implement PlanWatcher with reactive fs monitoring and polling.

\`\`\`mermaid
flowchart TD
  Watcher[PlanWatcher] --> Detector[PlanDetector]
  Watcher --> UI[UI Server]
\`\`\`

## Verification Plan
Run automated unit tests.
`
      await fs.writeFile(planFile, initialContent, 'utf8')

      // Trigger scan and verify creation
      const scannedAfterCreate = await watcher.scanNow()
      assert.equal(scannedAfterCreate.length, 1)

      const createdEvent = events.find((e) => e.type === 'plan:created')
      assert.ok(createdEvent, 'Expected plan:created event')
      assert.equal(createdEvent.artifact.title, 'Implementation Plan: Core Watcher')
      assert.equal(createdEvent.artifact.sessionId, convId)
      assert.equal(createdEvent.artifact.projectSlug, 'test-project')
      assert.equal(createdEvent.artifact.segment, 'plans')
      assert.equal(createdEvent.artifact.mermaidBlocks.length, 1)
      assert.match(createdEvent.artifact.mermaidBlocks[0]!, /flowchart TD/)

      // 2. Update implementation_plan.md with new mermaid diagram and title
      const updatedContent = `# Implementation Plan: Core Watcher (Revised)

## Proposed Changes
Add robust error handling.

\`\`\`mermaid
flowchart LR
  FS[File System] --> Poller[Interval Poller]
  Poller --> Event[plan:updated]
\`\`\`

## Verification Plan
Ensure 100% test coverage.
`
      await fs.writeFile(planFile, updatedContent, 'utf8')

      // Trigger scan and verify update
      const scannedAfterUpdate = await watcher.scanNow()
      assert.equal(scannedAfterUpdate.length, 1)

      const updatedEvent = events.find((e) => e.type === 'plan:updated')
      assert.ok(updatedEvent, 'Expected plan:updated event')
      assert.equal(updatedEvent.artifact.title, 'Implementation Plan: Core Watcher (Revised)')
      assert.equal(updatedEvent.artifact.mermaidBlocks.length, 1)
      assert.match(updatedEvent.artifact.mermaidBlocks[0]!, /flowchart LR/)

      // 3. Test unsubscribe
      unsubscribe()
      const eventsBeforeUnsub = events.length
      await fs.writeFile(planFile, updatedContent + '\n<!-- extra comment -->\n', 'utf8')
      await watcher.scanNow()
      assert.equal(events.length, eventsBeforeUnsub, 'No new events after unsubscribe')
    } finally {
      watcher.stop()
      await fs.rm(tmpHome, { recursive: true, force: true })
    }
  })

  it('manually watches and tracks a specific file with watchFile()', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-file-test-'))
    const filePath = path.join(tmpDir, 'custom-spec.md')
    const watcher = new PlanWatcher({
      includeAntigravityBrain: false,
      pollIntervalMs: 50,
      projectSlug: 'spec-project',
    })

    const events: PlanWatcherEvent[] = []
    watcher.onPlan((ev) => events.push(ev))

    try {
      await fs.writeFile(
        filePath,
        '# Custom Architecture Spec\n\n```mermaid\ngraph TD\nA-->B\n```\n',
        'utf8'
      )

      const artifact = await watcher.watchFile(filePath)
      assert.ok(artifact)
      assert.equal(artifact.title, 'Custom Architecture Spec')
      assert.equal(artifact.mermaidBlocks.length, 1)

      assert.equal(events.length, 1)
      assert.equal(events[0]?.type, 'plan:created')

      // Update file content
      await fs.writeFile(
        filePath,
        '# Custom Architecture Spec\n\nUpdated text.\n```mermaid\ngraph TD\nA-->B-->C\n```\n',
        'utf8'
      )

      await watcher.scanNow()
      const updateEv = events.find((e) => e.type === 'plan:updated')
      assert.ok(updateEv)
      assert.match(updateEv.artifact.mermaidBlocks[0]!, /A-->B-->C/)
    } finally {
      watcher.stop()
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('emits plan:deleted when a tracked plan file is removed', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-del-test-'))
    const planFile = path.join(tmpDir, 'plan-temp.md')
    const watcher = new PlanWatcher({
      includeAntigravityBrain: false,
      watchDirs: [tmpDir],
      pollIntervalMs: 50,
    })

    const events: PlanWatcherEvent[] = []
    watcher.onPlan((ev) => events.push(ev))

    try {
      await fs.writeFile(planFile, '# Temporary Plan\n\n## Proposed Changes\nTemporary.', 'utf8')
      await watcher.scanNow()

      assert.ok(events.some((e) => e.type === 'plan:created'))

      // Remove the file
      await fs.unlink(planFile)
      await watcher.scanNow()

      const delEv = events.find((e) => e.type === 'plan:deleted')
      assert.ok(delEv, 'Expected plan:deleted event')
      assert.equal(delEv.filePath, planFile)
    } finally {
      watcher.stop()
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('reports all configured watched paths in getWatchedPaths()', () => {
    const watcher = new PlanWatcher({
      homeDir: '/mock/home',
      includeAntigravityBrain: true,
      watchDirs: ['/mock/custom-plans'],
      watchFiles: ['/mock/custom-file.md'],
    })

    const paths = watcher.getWatchedPaths()
    assert.ok(paths.includes(path.join('/mock/home', '.gemini', 'antigravity-cli', 'brain')))
    assert.ok(paths.some((p) => p.includes('plans')))
    assert.ok(paths.some((p) => p.includes('custom-plans')))
    assert.ok(paths.some((p) => p.includes('custom-file.md')))
  })
})
