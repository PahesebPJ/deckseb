/**
 * deckseb architectural domain and IPC contracts.
 * deckseb acts as an optional passive observer leaf node (`ui.deck`) in hubseb topology.
 */

// --- Host & Persona Types ---

export type AgentHostId =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'herdr'
  | 'shell'

export const SUPPORTED_AGENT_HOSTS: readonly AgentHostId[] = [
  'antigravity',
  'claude',
  'codex',
  'opencode',
  'herdr',
  'shell',
] as const

export const CREW_ROLES = [
  'researcher',
  'analyst',
  'architect',
  'developer',
  'qa-automation',
  'devops',
  'sre',
  'security',
  'code-reviewer',
  'documenter',
] as const

export type CrewRole = (typeof CREW_ROLES)[number]

export type ReasoningTier = 'fast' | 'balanced' | 'deep'

export type ConcurrencyMode = 'parallel' | 'queue' | 'mixed'

export type ThemeMode = 'light' | 'dark'

// --- Terminal & Process Models ---

export type TerminalStatus = 'running' | 'idle' | 'blocked' | 'exited'

export interface TerminalSession {
  id: string
  title: string
  hostId: AgentHostId
  cwd: string
  pid?: number | null
  status: TerminalStatus
  createdAt: string
}

// --- Artifact Models ---

export type ArtifactSegment =
  | 'plans'
  | 'diagrams'
  | 'specs'
  | 'reviews'
  | 'post-mortems'

export const ARTIFACT_SEGMENTS: readonly ArtifactSegment[] = [
  'plans',
  'diagrams',
  'specs',
  'reviews',
  'post-mortems',
] as const

export type MemosebCategory =
  | 'architecture'
  | 'convention'
  | 'bugfix'
  | 'decision'
  | 'domain'

export const MEMOSEB_CATEGORIES: readonly MemosebCategory[] = [
  'architecture',
  'convention',
  'bugfix',
  'decision',
  'domain',
] as const

export interface DetectedArtifact {
  id: string
  sessionId: string
  projectSlug: string
  segment: ArtifactSegment
  title: string
  filePath: string
  content: string
  mermaidBlocks: string[]
  detectedAt: string
  syncedToMemoseb: boolean
  memosebCategory?: MemosebCategory
}

// --- Subagent Activity & Monitoring ---

export type SubagentStatus = 'working' | 'completed' | 'failed' | 'idle'

export interface CrewSubagentActivity {
  id: string
  sessionId: string
  role: CrewRole
  personaName: string
  badge: string
  taskRole: string
  status: SubagentStatus
  worktree?: string
  modelTier: ReasoningTier
  modelTag: string
  startedAt: string
  updatedAt: string
}

// --- Memoseb Integration ---

export type MemoAction = 'context' | 'recall' | 'remember' | 'analyze'

export interface MemoActivityEvent {
  id: string
  timestamp: string
  action: MemoAction
  projectId: string
  summary: string
  tokenCount: number
  category?: string
}

export interface VaultStats {
  projectCount: number
  memoryCount: number
  totalTokens: number
}

// --- Context Quota & Token Window ---

export type QuotaWarningLevel = 'healthy' | 'warning' | 'critical'

export interface SessionContextQuota {
  sessionId: string
  modelName: string
  usedTokens: number
  maxTokens: number
  remainingPercent: number
  inputTokens: number
  outputTokens: number
  quotaUsedPercent: number
  quotaWindowLabel: string
  warningLevel: QuotaWarningLevel
}

// --- Ecosystem Topology & Passive Snapshot ---

export interface SebEcosystemSnapshot {
  optionalMode: true
  hubsebDetected: boolean
  crewsebDetected: boolean
  memosebDetected: boolean
  herdrDetected: boolean
  availableHosts: AgentHostId[]
  concurrencyMode: ConcurrencyMode
  maxLocalParallel: number
  preset: string
  personas: Record<CrewRole, string>
  activeSubagents: CrewSubagentActivity[]
  memoEvents: MemoActivityEvent[]
  vaultStats: VaultStats
}

// --- Transcript Stream Parsing (e.g. transcript.jsonl) ---

export interface TranscriptToolCall {
  name: string
  args: Record<string, unknown>
}

export interface TranscriptEntry {
  step_index?: number
  type?: string
  input_tokens?: number
  output_tokens?: number
  tool_calls?: TranscriptToolCall[]
  timestamp?: string
  raw?: string
}

// --- Tauri v2 IPC Command & Event Specification ---

export interface TauriDeckCommands {
  // Terminal commands
  'deck:terminal_create': {
    request: {
      hostId: AgentHostId
      cwd?: string
      title?: string
      command?: string
      args?: string[]
    }
    response: TerminalSession
  }
  'deck:terminal_write': {
    request: {
      sessionId: string
      data: string
    }
    response: void
  }
  'deck:terminal_resize': {
    request: {
      sessionId: string
      cols: number
      rows: number
    }
    response: void
  }
  'deck:terminal_close': {
    request: {
      sessionId: string
    }
    response: void
  }
  'deck:terminal_list': {
    request: void
    response: TerminalSession[]
  }

  // Ecosystem & Hubseb discovery
  'deck:ecosystem_snapshot': {
    request: {
      forceRefresh?: boolean
    } | void
    response: SebEcosystemSnapshot
  }

  // Context quota
  'deck:session_quota': {
    request: {
      sessionId: string
    }
    response: SessionContextQuota
  }

  // Artifact management & Memoseb synchronization
  'deck:artifacts_list': {
    request: {
      sessionId?: string
      projectSlug?: string
      segment?: ArtifactSegment
    } | void
    response: DetectedArtifact[]
  }
  'deck:sync_artifact_memoseb': {
    request: {
      artifactId: string
      category: MemosebCategory
      title?: string
      tags?: string[]
    }
    response: {
      success: boolean
      memoryId?: string
      error?: string
    }
  }

  // Memoseb telemetry
  'deck:memo_events_list': {
    request: {
      limit?: number
      projectId?: string
    } | void
    response: MemoActivityEvent[]
  }

  // UI preferences
  'deck:get_theme': {
    request: void
    response: ThemeMode
  }
  'deck:set_theme': {
    request: {
      mode: ThemeMode
    }
    response: ThemeMode
  }
}

export interface TauriDeckEvents {
  'deck:terminal-data': {
    sessionId: string
    data: string
  }
  'deck:terminal-exit': {
    sessionId: string
    exitCode: number
  }
  'deck:ecosystem-updated': SebEcosystemSnapshot
  'deck:artifact-detected': DetectedArtifact
  'deck:subagent-updated': CrewSubagentActivity
  'deck:quota-updated': SessionContextQuota
  'deck:memo-event': MemoActivityEvent
}

export type DeckCommandName = keyof TauriDeckCommands
export type DeckEventName = keyof TauriDeckEvents

export const DECK_IPC_COMMANDS: readonly DeckCommandName[] = [
  'deck:terminal_create',
  'deck:terminal_write',
  'deck:terminal_resize',
  'deck:terminal_close',
  'deck:terminal_list',
  'deck:ecosystem_snapshot',
  'deck:session_quota',
  'deck:artifacts_list',
  'deck:sync_artifact_memoseb',
  'deck:memo_events_list',
  'deck:get_theme',
  'deck:set_theme',
] as const

export const DECK_IPC_EVENTS: readonly DeckEventName[] = [
  'deck:terminal-data',
  'deck:terminal-exit',
  'deck:ecosystem-updated',
  'deck:artifact-detected',
  'deck:subagent-updated',
  'deck:quota-updated',
  'deck:memo-event',
] as const
