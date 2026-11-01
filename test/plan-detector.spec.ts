import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyArtifactSegment,
  detectPlanInStream,
  extractMermaidBlocks,
  slugifyTitle,
} from '../src/core/plan-detector.ts'

describe('plan-detector', () => {
  it('extracts mermaid blocks accurately', () => {
    const markdown = `
# System Architecture

Here is the system overview:

\`\`\`mermaid
flowchart TD
  A[Client] --> B[Server]
  B --> C[(Database)]
\`\`\`

Some intermediate explanation.

\`\`\`mermaid
sequenceDiagram
  Alice->>Bob: Hello
\`\`\`
`
    const blocks = extractMermaidBlocks(markdown)
    assert.equal(blocks.length, 2)
    assert.match(blocks[0]!, /flowchart TD/)
    assert.match(blocks[1]!, /sequenceDiagram/)
  })

  it('returns empty array when no mermaid blocks exist', () => {
    const blocks = extractMermaidBlocks('# Just some normal markdown\nwith plain text.')
    assert.deepEqual(blocks, [])
  })

  it('classifies artifact segments by path and content', () => {
    assert.equal(
      classifyArtifactSegment('docs/plans/v1-plan.md', '# Execution Plan'),
      'plans'
    )
    assert.equal(
      classifyArtifactSegment('specs/auth.feature', 'Scenario: User login\nGiven a user\nWhen login\nThen success'),
      'specs'
    )
    assert.equal(
      classifyArtifactSegment('reviews/pr-42.md', '# Code Review\nLooks good to me'),
      'reviews'
    )
    assert.equal(
      classifyArtifactSegment('postmortems/incident-01.md', '# Post-Mortem Incident Report\nRoot cause analysis'),
      'post-mortems'
    )
    assert.equal(
      classifyArtifactSegment('diagrams/architecture.mmd', 'graph TD\nA-->B'),
      'diagrams'
    )
  })

  it('detects plan in stream and builds DetectedArtifact', () => {
    const raw = `
# Implementation Plan: Tauri v2 Core

## Overview
We need to create the core engine.

\`\`\`mermaid
flowchart LR
  TS[Core Engine] --> IPC[Tauri v2 IPC] --> Native[Rust PTY]
\`\`\`

### Matriz de Despacho
| Step | Role | Status |
| 1 | developer | pending |
`
    const artifact = detectPlanInStream('session-123', 'deckseb', raw)
    assert.ok(artifact)
    assert.equal(artifact.title, 'Implementation Plan: Tauri v2 Core')
    assert.equal(artifact.segment, 'plans')
    assert.equal(artifact.sessionId, 'session-123')
    assert.equal(artifact.projectSlug, 'deckseb')
    assert.equal(artifact.mermaidBlocks.length, 1)
    assert.equal(artifact.syncedToMemoseb, false)
    assert.equal(artifact.memosebCategory, 'architecture')
  })

  it('returns null when text does not qualify as plan or diagram', () => {
    const plainOutput = 'npm test\n> deckseb@0.1.0 test\nPASS 4 tests passed\nDone in 0.5s'
    const result = detectPlanInStream('s-1', 'deckseb', plainOutput)
    assert.equal(result, null)
  })

  it('slugifies titles safely', () => {
    assert.equal(
      slugifyTitle('Implementation Plan: Tauri v2 Core!'),
      'implementation-plan-tauri-v2-core'
    )
  })
})
