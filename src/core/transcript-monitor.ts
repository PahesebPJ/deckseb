import { randomUUID } from 'node:crypto'
import {
  CREW_ROLES,
  type CrewRole,
  type CrewSubagentActivity,
  type MemoAction,
  type MemoActivityEvent,
  type QuotaWarningLevel,
  type ReasoningTier,
  type SessionContextQuota,
  type SubagentStatus,
  type TranscriptEntry,
  type TranscriptToolCall,
} from '../types/deck.ts'

export const CREW_BADGES: Record<CrewRole, string> = {
  researcher: '🔍',
  analyst: '📊',
  architect: '📐',
  developer: '🛠️',
  'qa-automation': '🧪',
  devops: '🚀',
  sre: '🛡️',
  security: '🔒',
  'code-reviewer': '🔎',
  documenter: '📝',
}

export const DEFAULT_ROLE_TIERS: Record<
  CrewRole,
  { tier: ReasoningTier; model: string }
> = {
  architect: { tier: 'deep', model: 'pro' },
  security: { tier: 'deep', model: 'pro' },
  developer: { tier: 'deep', model: 'pro' },
  'code-reviewer': { tier: 'deep', model: 'pro' },
  analyst: { tier: 'balanced', model: 'flash' },
  researcher: { tier: 'balanced', model: 'flash' },
  'qa-automation': { tier: 'balanced', model: 'flash' },
  devops: { tier: 'balanced', model: 'flash' },
  sre: { tier: 'balanced', model: 'flash' },
  documenter: { tier: 'balanced', model: 'flash' },
}

/**
 * Parses a single line of a transcript log (JSON or JSONL) into a TranscriptEntry.
 */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  if (!line || typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  try {
    const rawObj = JSON.parse(trimmed) as Record<string, unknown>
    const toolCalls: TranscriptToolCall[] = []

    // Format 1: explicit tool_calls array
    if (Array.isArray(rawObj['tool_calls'])) {
      for (const tc of rawObj['tool_calls']) {
        if (typeof tc === 'object' && tc !== null) {
          const rec = tc as Record<string, unknown>
          const name = String(rec['name'] ?? rec['function'] ?? '')
          const args =
            typeof rec['args'] === 'object' && rec['args'] !== null
              ? (rec['args'] as Record<string, unknown>)
              : typeof rec['arguments'] === 'object' && rec['arguments'] !== null
              ? (rec['arguments'] as Record<string, unknown>)
              : {}
          if (name) toolCalls.push({ name, args })
        }
      }
    }

    // Format 2: Claude / OpenAI messages with content blocks
    const message = rawObj['message'] as Record<string, unknown> | undefined
    if (message && Array.isArray(message['content'])) {
      for (const block of message['content']) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>)['type'] === 'tool_use'
        ) {
          const b = block as Record<string, unknown>
          const name = String(b['name'] ?? '')
          const args =
            typeof b['input'] === 'object' && b['input'] !== null
              ? (b['input'] as Record<string, unknown>)
              : {}
          if (name) toolCalls.push({ name, args })
        }
      }
    }

    // Format 3: direct tool_call property
    if (typeof rawObj['tool_call'] === 'object' && rawObj['tool_call'] !== null) {
      const tc = rawObj['tool_call'] as Record<string, unknown>
      const name = String(tc['name'] ?? '')
      const args =
        typeof tc['args'] === 'object' && tc['args'] !== null
          ? (tc['args'] as Record<string, unknown>)
          : {}
      if (name) toolCalls.push({ name, args })
    }

    // Tokens parsing (Anthropic/OpenAI usage or root properties)
    const usage = (rawObj['usage'] ?? {}) as Record<string, unknown>
    const inputTokens = Number(
      rawObj['input_tokens'] ?? usage['input_tokens'] ?? usage['prompt_tokens'] ?? 0
    )
    const outputTokens = Number(
      rawObj['output_tokens'] ??
        usage['output_tokens'] ??
        usage['completion_tokens'] ??
        0
    )

    return {
      step_index: typeof rawObj['step_index'] === 'number' ? rawObj['step_index'] : undefined,
      type: typeof rawObj['type'] === 'string' ? rawObj['type'] : undefined,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      timestamp:
        typeof rawObj['timestamp'] === 'string'
          ? rawObj['timestamp']
          : typeof rawObj['ts'] === 'string'
          ? rawObj['ts']
          : undefined,
      raw: trimmed,
    }
  } catch {
    return null
  }
}

/**
 * Extracts all crewseb subagent activities from transcript lines.
 */
export function extractSubagentsFromTranscript(
  sessionId: string,
  lines: string[],
  personas: Record<CrewRole, string>,
  presetTiers?: Partial<Record<CrewRole, { tier: ReasoningTier; model: string }>>
): CrewSubagentActivity[] {
  const activities: CrewSubagentActivity[] = []
  const subagentMap = new Map<string, CrewSubagentActivity>()

  for (const line of lines) {
    const entry = parseTranscriptLine(line)
    if (!entry) continue

    const timestamp = entry.timestamp ?? new Date().toISOString()

    // Check for invoke_subagent tool calls
    if (entry.tool_calls) {
      for (const call of entry.tool_calls) {
        if (
          call.name === 'invoke_subagent' ||
          call.name === 'subagent' ||
          call.name === 'crewseb'
        ) {
          const typeName = String(
            call.args['TypeName'] ??
              call.args['typename'] ??
              call.args['role'] ??
              call.args['specialist'] ??
              ''
          ).toLowerCase() as CrewRole

          if (CREW_ROLES.includes(typeName)) {
            const taskRole = String(
              call.args['Role'] ??
                call.args['task'] ??
                call.args['description'] ??
                call.args['objective'] ??
                typeName
            )
            const personaName = personas[typeName] ?? typeName
            const badge = CREW_BADGES[typeName] ?? '🤖'
            const tierInfo =
              presetTiers?.[typeName] ??
              DEFAULT_ROLE_TIERS[typeName] ??
              { tier: 'balanced', model: 'flash' }
            const worktree =
              typeof call.args['Workspace'] === 'string'
                ? call.args['Workspace']
                : typeof call.args['worktree'] === 'string'
                ? call.args['worktree']
                : undefined

            const actId = `${sessionId}-${typeName}-${activities.length + 1}`
            const activity: CrewSubagentActivity = {
              id: actId,
              sessionId,
              role: typeName,
              personaName,
              badge,
              taskRole,
              status: 'working',
              worktree,
              modelTier: tierInfo.tier,
              modelTag: tierInfo.model,
              startedAt: timestamp,
              updatedAt: timestamp,
            }
            subagentMap.set(typeName, activity)
            activities.push(activity)
          }
        }
      }
    }

    // Check for tool response / completion lines
    if (entry.type === 'tool_result' || entry.type === 'subagent_result') {
      for (const [role, act] of subagentMap.entries()) {
        if (act.status === 'working') {
          act.status = 'completed'
          act.updatedAt = timestamp
        }
      }
    }
  }

  return activities
}

/**
 * Extracts Memoseb activity events from transcript lines (CLI and MCP tools).
 */
export function extractMemoEventsFromTranscript(
  projectId: string,
  lines: string[]
): MemoActivityEvent[] {
  const events: MemoActivityEvent[] = []

  for (const line of lines) {
    const entry = parseTranscriptLine(line)
    const timestamp = entry?.timestamp ?? new Date().toISOString()

    // 1. Check MCP tool calls
    if (entry?.tool_calls) {
      for (const call of entry.tool_calls) {
        let action: MemoAction | null = null
        let summary = ''
        let category: string | undefined

        switch (call.name) {
          case 'memory_briefing':
            action = 'context'
            summary = 'Briefing requested'
            break
          case 'memory_recall':
            action = 'recall'
            summary = String(call.args['query'] ?? 'Recall query')
            break
          case 'memory_store':
            action = 'remember'
            summary = String(call.args['title'] ?? call.args['content'] ?? 'Stored memory')
            category = typeof call.args['category'] === 'string' ? call.args['category'] : undefined
            break
          case 'memory_analyze':
            action = 'analyze'
            summary = 'Project analysis triggered'
            break
        }

        if (action) {
          events.push({
            id: randomUUID(),
            timestamp,
            action,
            projectId,
            summary,
            tokenCount: (entry.input_tokens || 0) + (entry.output_tokens || 0),
            category,
          })
        }
      }
    }

    // 2. Check bash / CLI executions
    const raw = entry?.raw ?? line
    if (raw.includes('memoseb ')) {
      let action: MemoAction | null = null
      let summary = ''
      let category: string | undefined

      if (raw.includes('memoseb context')) {
        action = 'context'
        summary = 'CLI context briefing'
      } else if (raw.includes('memoseb recall')) {
        action = 'recall'
        const match = raw.match(/recall\s+["']?([^"'\n]+)/i)
        summary = match?.[1] ? match[1].trim() : 'CLI recall'
      } else if (raw.includes('memoseb remember')) {
        action = 'remember'
        const match = raw.match(/remember\s+["']?([^"'\n]+)/i)
        summary = match?.[1] ? match[1].trim() : 'CLI remember'
        const catMatch = raw.match(/--category\s+([a-zA-Z0-9_-]+)/i)
        if (catMatch?.[1]) category = catMatch[1]
      } else if (raw.includes('memoseb analyze')) {
        action = 'analyze'
        summary = 'CLI project analysis'
      }

      if (action) {
        events.push({
          id: randomUUID(),
          timestamp,
          action,
          projectId,
          summary,
          tokenCount: 0,
          category,
        })
      }
    }
  }

  return events
}

/**
 * Computes context quota and warning levels for an active session.
 */
export function computeSessionContextQuota(
  sessionId: string,
  lines: string[],
  options?: {
    modelName?: string
    maxTokens?: number
    quotaBudgetTokens?: number
  }
): SessionContextQuota {
  const modelName = options?.modelName ?? 'gemini-3.8-pro'
  const maxTokens = options?.maxTokens ?? 200_000

  let inputTokens = 0
  let outputTokens = 0

  for (const line of lines) {
    const entry = parseTranscriptLine(line)
    if (entry) {
      if (entry.input_tokens || entry.output_tokens) {
        inputTokens += entry.input_tokens ?? 0
        outputTokens += entry.output_tokens ?? 0
      } else if (entry.raw) {
        // Fallback estimate for unmetered turns (~4 chars per token)
        const estimated = Math.ceil(entry.raw.length / 4)
        inputTokens += estimated
      }
    } else if (line.trim().length > 0) {
      const estimated = Math.ceil(line.trim().length / 4)
      inputTokens += estimated
    }
  }

  const usedTokens = inputTokens + outputTokens
  const remainingTokens = Math.max(0, maxTokens - usedTokens)
  const remainingPercent = Math.max(
    0,
    Math.min(100, Math.round((remainingTokens / maxTokens) * 100))
  )
  const quotaUsedPercent = Math.min(
    100,
    Math.round((usedTokens / maxTokens) * 100)
  )

  let warningLevel: QuotaWarningLevel = 'healthy'
  if (remainingPercent < 25) {
    warningLevel = 'critical'
  } else if (remainingPercent <= 50) {
    warningLevel = 'warning'
  }

  const usedK = (usedTokens / 1000).toFixed(1)
  const maxK = (maxTokens / 1000).toFixed(0)
  const quotaWindowLabel = `${usedK}k / ${maxK}k (${remainingPercent}% left)`

  return {
    sessionId,
    modelName,
    usedTokens,
    maxTokens,
    remainingPercent,
    inputTokens,
    outputTokens,
    quotaUsedPercent,
    quotaWindowLabel,
    warningLevel,
  }
}
