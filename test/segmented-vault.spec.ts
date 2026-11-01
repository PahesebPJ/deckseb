import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SegmentedArtifactVault } from '../src/core/segmented-vault.ts'
import type { DetectedArtifact } from '../src/types/deck.ts'

describe('segmented-vault', () => {
  it('saves artifacts in segmented directories and extracts mermaid diagrams', async () => {
    const tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-vault-'))

    try {
      const vault = new SegmentedArtifactVault({ vaultRoot: tmpVault })
      const sampleArtifact: DetectedArtifact = {
        id: 'art-001',
        sessionId: 'sess-abc',
        projectSlug: 'project-omega',
        segment: 'plans',
        title: 'Project Omega Launch Plan',
        filePath: 'plans/project-omega-launch-plan.md',
        content: '# Project Omega Launch Plan\n\n```mermaid\ngraph TD\nA-->B\n```\n',
        mermaidBlocks: ['graph TD\nA-->B'],
        detectedAt: new Date().toISOString(),
        syncedToMemoseb: false,
        memosebCategory: 'architecture',
      }

      const saved = await vault.saveArtifact(sampleArtifact)
      assert.ok(saved.filePath.includes('project-omega/plans/project-omega-launch-plan.md'))

      // Verify file written to disk
      const content = await fs.readFile(saved.filePath, 'utf8')
      assert.match(content, /Project Omega Launch Plan/)

      // Verify mermaid diagram extracted
      const mmdFile = path.join(
        tmpVault,
        'project-omega',
        'diagrams',
        'project-omega-launch-plan-diagram-1.mmd'
      )
      const mmdContent = await fs.readFile(mmdFile, 'utf8')
      assert.equal(mmdContent, 'graph TD\nA-->B')

      // Verify manifest.json
      const list = await vault.listArtifacts({ projectSlug: 'project-omega' })
      assert.equal(list.length, 1)
      assert.equal(list[0]?.id, 'art-001')
      assert.equal(list[0]?.segment, 'plans')

      // Filter by segment
      const filteredPlans = await vault.listArtifacts({ segment: 'plans' })
      assert.equal(filteredPlans.length, 1)
      const filteredReviews = await vault.listArtifacts({ segment: 'reviews' })
      assert.equal(filteredReviews.length, 0)
    } finally {
      await fs.rm(tmpVault, { recursive: true, force: true })
    }
  })

  it('gracefully degrades when syncing to non-existent memoseb', async () => {
    const tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-vault-'))
    try {
      const vault = new SegmentedArtifactVault({
        vaultRoot: tmpVault,
        memosebBin: '/path/does/not/exist/memoseb',
      })
      const sampleArtifact: DetectedArtifact = {
        id: 'art-002',
        sessionId: 'sess-xyz',
        projectSlug: 'mock-proj',
        segment: 'specs',
        title: 'User Spec',
        filePath: 'specs/user-spec.md',
        content: '# Spec\nGiven something',
        mermaidBlocks: [],
        detectedAt: new Date().toISOString(),
        syncedToMemoseb: false,
      }
      await vault.saveArtifact(sampleArtifact)

      const result = await vault.syncArtifactToMemoseb('art-002', 'domain', {
        memosebBin: '/non/existent/bin',
      })
      assert.equal(result.success, false)
      assert.match(result.error ?? '', /not found/)
    } finally {
      await fs.rm(tmpVault, { recursive: true, force: true })
    }
  })
})
