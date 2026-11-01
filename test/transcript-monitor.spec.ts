import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSessionContextQuota,
  extractMemoEventsFromTranscript,
  extractSubagentsFromTranscript,
  parseTranscriptLine,
} from '../src/core/transcript-monitor.ts'
import { DEFAULT_CREW_PERSONAS } from '../src/core/ecosystem-observer.ts'

describe('transcript-monitor', () => {
  it('parses valid transcript JSON lines with tool calls', () => {
    const rawLine = JSON.stringify({
      step_index: 3,
      type: 'tool_call',
      input_tokens: 450,
      output_tokens: 120,
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: { TypeName: 'developer', Role: 'Build core module' },
        },
      ],
      timestamp: '2026-11-01T02:00:00Z',
    })

    const entry = parseTranscriptLine(rawLine)
    assert.ok(entry)
    assert.equal(entry.step_index, 3)
    assert.equal(entry.input_tokens, 450)
    assert.equal(entry.output_tokens, 120)
    assert.equal(entry.tool_calls?.length, 1)
    assert.equal(entry.tool_calls[0]?.name, 'invoke_subagent')
  })

  it('returns null for empty or invalid transcript lines', () => {
    assert.equal(parseTranscriptLine(''), null)
    assert.equal(parseTranscriptLine('not a json object'), null)
    assert.equal(parseTranscriptLine('{ invalid json:'), null)
  })

  it('extracts crewseb subagents with personas, badges, and tiers', () => {
    const lines = [
      JSON.stringify({
        step_index: 1,
        type: 'tool_call',
        tool_calls: [
          {
            name: 'invoke_subagent',
            args: {
              TypeName: 'developer',
              Role: 'Implement feature',
              Workspace: 'branch',
            },
          },
          {
            name: 'invoke_subagent',
            args: {
              TypeName: 'architect',
              Role: 'Review architecture',
            },
          },
        ],
        timestamp: '2026-11-01T02:10:00Z',
      }),
      JSON.stringify({
        step_index: 2,
        type: 'tool_result',
        timestamp: '2026-11-01T02:12:00Z',
      }),
    ]

    const subagents = extractSubagentsFromTranscript(
      'sess-001',
      lines,
      DEFAULT_CREW_PERSONAS
    )

    assert.equal(subagents.length, 2)

    const dev = subagents.find((s) => s.role === 'developer')
    assert.ok(dev)
    assert.equal(dev.personaName, 'Orion')
    assert.equal(dev.badge, '🛠️')
    assert.equal(dev.modelTier, 'deep')
    assert.equal(dev.worktree, 'branch')
    assert.equal(dev.status, 'completed')

    const arch = subagents.find((s) => s.role === 'architect')
    assert.ok(arch)
    assert.equal(arch.personaName, 'Juno')
    assert.equal(arch.badge, '📐')
    assert.equal(arch.modelTier, 'deep')
  })

  it('extracts memoseb events from MCP calls and CLI executions', () => {
    const lines = [
      JSON.stringify({
        tool_calls: [
          {
            name: 'memory_briefing',
            args: { projectId: 'my-proj' },
          },
          {
            name: 'memory_store',
            args: {
              title: 'Key Decision',
              content: 'Use Tauri v2',
              category: 'architecture',
            },
          },
        ],
      }),
      'Running command: memoseb remember "Important lesson" --category bugfix',
      'Running command: memoseb recall "IPC protocol"',
    ]

    const events = extractMemoEventsFromTranscript('my-proj', lines)
    assert.equal(events.length, 4)

    assert.equal(events[0]?.action, 'context')
    assert.equal(events[1]?.action, 'remember')
    assert.equal(events[1]?.category, 'architecture')

    assert.equal(events[2]?.action, 'remember')
    assert.equal(events[2]?.category, 'bugfix')

    assert.equal(events[3]?.action, 'recall')
    assert.match(events[3]?.summary ?? '', /IPC protocol/)
  })

  it('computes session context quota and warning levels', () => {
    // 1. Healthy test
    const healthyLines = [
      JSON.stringify({ input_tokens: 10_000, output_tokens: 5_000 }),
    ]
    const healthyQuota = computeSessionContextQuota('sess-h', healthyLines, {
      maxTokens: 200_000,
    })
    assert.equal(healthyQuota.usedTokens, 15_000)
    assert.equal(healthyQuota.remainingPercent, 93)
    assert.equal(healthyQuota.warningLevel, 'healthy')

    // 2. Warning test (50% - 25% remaining)
    const warningLines = [
      JSON.stringify({ input_tokens: 80_000, output_tokens: 40_000 }),
    ]
    const warningQuota = computeSessionContextQuota('sess-w', warningLines, {
      maxTokens: 200_000,
    })
    assert.equal(warningQuota.usedTokens, 120_000)
    assert.equal(warningQuota.remainingPercent, 40)
    assert.equal(warningQuota.warningLevel, 'warning')

    // 3. Critical test (< 25% remaining)
    const criticalLines = [
      JSON.stringify({ input_tokens: 120_000, output_tokens: 50_000 }),
    ]
    const criticalQuota = computeSessionContextQuota('sess-c', criticalLines, {
      maxTokens: 200_000,
    })
    assert.equal(criticalQuota.usedTokens, 170_000)
    assert.equal(criticalQuota.remainingPercent, 15)
    assert.equal(criticalQuota.warningLevel, 'critical')
  })
})
