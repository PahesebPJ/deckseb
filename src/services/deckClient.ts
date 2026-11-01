/**
 * deckClient.ts
 * Decoupled IPC client for deckseb (Tauri v2 + in-memory interactive simulation fallback)
 */

import {
  type AgentHostId,
  type ArtifactSegment,
  type CrewRole,
  type CrewSubagentActivity,
  type DeckCommandName,
  type DeckEventName,
  type DetectedArtifact,
  type MemoActivityEvent,
  type MemosebCategory,
  type SebEcosystemSnapshot,
  type SessionContextQuota,
  SUPPORTED_AGENT_HOSTS,
  type TauriDeckCommands,
  type TauriDeckEvents,
  type TerminalSession,
  type ThemeMode,
} from '../types/deck.ts'

type EventCallback<T = any> = (payload: T) => void

const PERSONA_MAP: Record<CrewRole, { name: string; badge: string; tier: 'fast' | 'balanced' | 'deep'; model: string }> = {
  researcher: { name: 'Theo', badge: '🔭 [Theo · researcher]', tier: 'balanced', model: 'gemini-3.8-flash' },
  analyst: { name: 'Axel', badge: '📊 [Axel · analyst]', tier: 'balanced', model: 'gemini-3.8-flash' },
  architect: { name: 'Juno', badge: '🧭 [Juno · architect]', tier: 'deep', model: 'gemini-pro' },
  developer: { name: 'Orion', badge: '🛠️ [Orion · developer]', tier: 'deep', model: 'gemini-pro' },
  'qa-automation': { name: 'Atlas', badge: '🧪 [Atlas · qa-automation]', tier: 'balanced', model: 'gemini-3.8-flash' },
  devops: { name: 'Vera', badge: '🚀 [Vera · devops]', tier: 'balanced', model: 'gemini-3.8-flash' },
  sre: { name: 'Sloan', badge: '🛡️ [Sloan · sre]', tier: 'balanced', model: 'gemini-3.8-flash' },
  security: { name: 'Kael', badge: '🔐 [Kael · security]', tier: 'deep', model: 'gemini-pro' },
  'code-reviewer': { name: 'Lyra', badge: '🔍 [Lyra · code-reviewer]', tier: 'deep', model: 'gemini-pro' },
  documenter: { name: 'Nova', badge: '📝 [Nova · documenter]', tier: 'balanced', model: 'gemini-3.8-flash' },
}

class DeckClientService {
  private listeners: Map<DeckEventName, Set<EventCallback>> = new Map()
  private isTauri: boolean = false
  private terminalSessions: Map<string, TerminalSession> = new Map()
  private terminalOutputs: Map<string, string[]> = new Map()
  private artifacts: DetectedArtifact[] = []
  private memoEvents: MemoActivityEvent[] = []
  private activeSubagents: CrewSubagentActivity[] = []
  private quotas: Map<string, SessionContextQuota> = new Map()
  private currentTheme: ThemeMode = 'dark'
  private vaultStats = {
    projectCount: 4,
    memoryCount: 42,
    totalTokens: 38400,
  }

  constructor() {
    this.detectEnvironment()
    this.initDefaultMockData()
  }

  private detectEnvironment(): void {
    if (typeof window !== 'undefined') {
      const win = window as any
      this.isTauri = Boolean(win.__TAURI_INTERNALS__ || (win.__TAURI__ && win.__TAURI__.core))
      const savedTheme = localStorage.getItem('deckseb_theme') as ThemeMode
      if (savedTheme === 'light' || savedTheme === 'dark') {
        this.currentTheme = savedTheme
      }
    }
  }

  public isRunningInTauri(): boolean {
    return this.isTauri
  }

  // --- Event Pub/Sub ---

  public on<E extends DeckEventName>(event: E, callback: (payload: TauriDeckEvents[E]) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback as EventCallback)

    return () => {
      this.off(event, callback)
    }
  }

  public off<E extends DeckEventName>(event: E, callback: (payload: TauriDeckEvents[E]) => void): void {
    const set = this.listeners.get(event)
    if (set) {
      set.delete(callback as EventCallback)
    }
  }

  public emit<E extends DeckEventName>(event: E, payload: TauriDeckEvents[E]): void {
    const set = this.listeners.get(event)
    if (set) {
      for (const cb of set) {
        try {
          cb(payload)
        } catch (err) {
          console.error(`Error in event listener for ${event}:`, err)
        }
      }
    }
  }

  // --- Initial Mock Data for Interactive Mode ---

  private initDefaultMockData(): void {
    // 1. Initial Terminal Sessions
    const defaultHost: AgentHostId = 'antigravity'
    const s1: TerminalSession = {
      id: 'session-agy-01',
      title: 'antigravity · deckseb',
      hostId: 'antigravity',
      cwd: '/home/alan/Documents/projects/deckseb',
      pid: 4812,
      status: 'running',
      createdAt: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
    }
    const s2: TerminalSession = {
      id: 'session-claude-02',
      title: 'claude · crewseb',
      hostId: 'claude',
      cwd: '/home/alan/Documents/projects/crewseb',
      pid: 5120,
      status: 'idle',
      createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    }
    this.terminalSessions.set(s1.id, s1)
    this.terminalSessions.set(s2.id, s2)

    this.terminalOutputs.set(s1.id, [
      '\x1b[1;34m[deckseb]\x1b[0m Tactical Terminal Deck initialized on \x1b[1mantigravity (Gemini CLI)\x1b[0m',
      '\x1b[32m✔ hubseb ecosystem connected:\x1b[0m crewseb (10 roles), memoseb (FTS5 vault), herdr',
      '\x1b[90mTip: Type /plan, /compact, crewseb models list, or memoseb context\x1b[0m',
      '\x1b[36magy:~/Documents/projects/deckseb$\x1b[0m git status',
      'On branch feature/initial-desktop-ui',
      'nothing to commit, working tree clean',
      '',
    ])

    this.terminalOutputs.set(s2.id, [
      '\x1b[1;35m[claude-code]\x1b[0m Claude Code 3.7 Sonnet session active in /projects/crewseb',
      'Ready for autonomous task execution.',
      '',
    ])

    // 2. Initial Quota
    this.quotas.set(s1.id, {
      sessionId: s1.id,
      modelName: 'gemini-3.8-flash',
      usedTokens: 142000,
      maxTokens: 200000,
      remainingPercent: 29,
      inputTokens: 118000,
      outputTokens: 24000,
      quotaUsedPercent: 71,
      quotaWindowLabel: 'Window: 1M tokens/min • 71% utilized',
      warningLevel: 'warning',
    })

    this.quotas.set(s2.id, {
      sessionId: s2.id,
      modelName: 'claude-3-7-sonnet',
      usedTokens: 48000,
      maxTokens: 200000,
      remainingPercent: 76,
      inputTokens: 42000,
      outputTokens: 6000,
      quotaUsedPercent: 24,
      quotaWindowLabel: 'Window: 400k tokens/min • 24% utilized',
      warningLevel: 'healthy',
    })

    // 3. Initial Subagents Activity
    const nowIso = new Date().toISOString()
    this.activeSubagents = [
      {
        id: 'sub-orion-01',
        sessionId: s1.id,
        role: 'developer',
        personaName: PERSONA_MAP.developer.name,
        badge: PERSONA_MAP.developer.badge,
        taskRole: 'Implement macOS Sequoia UI components and *seb monitors',
        status: 'working',
        worktree: '.worktrees/ui-frontend',
        modelTier: 'deep',
        modelTag: 'gemini-pro',
        startedAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
        updatedAt: nowIso,
      },
      {
        id: 'sub-juno-02',
        sessionId: s1.id,
        role: 'architect',
        personaName: PERSONA_MAP.architect.name,
        badge: PERSONA_MAP.architect.badge,
        taskRole: 'Define decoupled IPC contracts and architecture boundaries',
        status: 'completed',
        worktree: '.worktrees/core-backend',
        modelTier: 'deep',
        modelTag: 'gemini-pro',
        startedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        updatedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
      },
      {
        id: 'sub-theo-03',
        sessionId: s2.id,
        role: 'researcher',
        personaName: PERSONA_MAP.researcher.name,
        badge: PERSONA_MAP.researcher.badge,
        taskRole: 'Evaluate Tauri v2 IPC latency and multi-tab rendering performance',
        status: 'completed',
        worktree: '.worktrees/research',
        modelTier: 'balanced',
        modelTag: 'gemini-3.8-flash',
        startedAt: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
        updatedAt: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
      },
      {
        id: 'sub-atlas-04',
        sessionId: s1.id,
        role: 'qa-automation',
        personaName: PERSONA_MAP['qa-automation'].name,
        badge: PERSONA_MAP['qa-automation'].badge,
        taskRole: 'Prepare automated headless UI integration tests',
        status: 'idle',
        worktree: '.worktrees/qa',
        modelTier: 'balanced',
        modelTag: 'gemini-3.8-flash',
        startedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
        updatedAt: nowIso,
      },
    ]

    // 4. Initial Artifacts
    this.artifacts = [
      {
        id: 'art-plan-01',
        sessionId: s1.id,
        projectSlug: 'deckseb',
        segment: 'plans',
        title: 'Plan de Implementación: Interfaz Nativa macOS Sequoia & Monitores *seb',
        filePath: 'plans/001-macos-sequoia-ui.md',
        content: `# Plan: UI macOS Sequoia para deckseb

Arquitectura de componentes desacoplados para la terminal táctica.

### Objetivos:
1. Shell translúcido con tema Claro/Oscuro.
2. Terminal multipestaña agnóstica para 6 orquestadores.
3. Drawer lateral reactivo a planes de agentes con diagramas Mermaid.
4. Barra de telemetría de contexto y cuotas.`,
        mermaidBlocks: [
          `flowchart TD
  Host["Agent Hosts (AGY / Claude / Codex)"] --> IPC["Tauri v2 IPC (deck:*)"]
  IPC --> Deck["deckseb Webview"]
  Deck --> Term["Terminal Viewport"]
  Deck --> Drawer["Auto-Open Plan Drawer"]
  Deck --> Monitors["Crew & Memo Monitores"]`,
        ],
        detectedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
        syncedToMemoseb: true,
        memosebCategory: 'architecture',
      },
      {
        id: 'art-diag-02',
        sessionId: s1.id,
        projectSlug: 'deckseb',
        segment: 'diagrams',
        title: 'Topología de Nodos Hubseb y Deckseb como Passive Observer',
        filePath: 'diagrams/002-hubseb-topology.md',
        content: `# Topología de Nodos

Hubseb opera como el bus central de mensajería y metadatos. Deckseb consume eventos sin imponer sobrecostos en el orquestador principal.`,
        mermaidBlocks: [
          `graph LR
  Hub["hubseb (Root / Bus)"] --- Crew["crewseb (10 roles)"]
  Hub --- Memo["memoseb (Vault DB)"]
  Hub --- Deck["deckseb (Passive Observer)"]`,
        ],
        detectedAt: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
        syncedToMemoseb: false,
      },
    ]

    // 5. Initial Memo Events
    this.memoEvents = [
      {
        id: 'memo-ev-01',
        timestamp: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
        action: 'remember',
        projectId: 'deckseb',
        summary: 'Guardada decisión: deckClient provee fallback en memoria completo para web y pruebas',
        tokenCount: 184,
        category: 'decision',
      },
      {
        id: 'memo-ev-02',
        timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
        action: 'context',
        projectId: 'crewseb',
        summary: 'Inyectado briefing de 3 memorias activas (preset cloud-tiered, orquestación nocturna)',
        tokenCount: 1031,
      },
      {
        id: 'memo-ev-03',
        timestamp: new Date(Date.now() - 1000 * 60 * 28).toISOString(),
        action: 'recall',
        projectId: 'global',
        summary: 'Búsqueda híbrida FTS5 + vectorial: multi-host claude codex antigravity',
        tokenCount: 420,
      },
    ]
  }

  // --- Tauri IPC or Simulation Invoker ---

  private async invokeCommand<K extends DeckCommandName>(
    command: K,
    args?: TauriDeckCommands[K]['request']
  ): Promise<TauriDeckCommands[K]['response']> {
    if (this.isTauri) {
      try {
        const win = window as any
        const invokeFn = win.__TAURI_INTERNALS__?.invoke || win.__TAURI__?.core?.invoke
        if (typeof invokeFn === 'function') {
          return await invokeFn(command, args)
        }
      } catch (err) {
        console.warn(`Tauri invoke failed for ${command}, falling back to simulation:`, err)
      }
    }

    return this.simulateCommand(command, args)
  }

  // --- In-Memory Simulation Implementation ---

  private simulateCommand<K extends DeckCommandName>(
    command: K,
    args?: TauriDeckCommands[K]['request']
  ): TauriDeckCommands[K]['response'] {
    switch (command) {
      case 'deck:terminal_create': {
        const req = args as TauriDeckCommands['deck:terminal_create']['request']
        const id = `session-${req.hostId}-${Date.now().toString().slice(-4)}`
        const title = req.title || `${req.hostId} · session`
        const newSession: TerminalSession = {
          id,
          title,
          hostId: req.hostId,
          cwd: req.cwd || '/home/alan/Documents/projects/deckseb',
          pid: Math.floor(1000 + Math.random() * 9000),
          status: 'running',
          createdAt: new Date().toISOString(),
        }
        this.terminalSessions.set(id, newSession)
        this.terminalOutputs.set(id, [
          `\x1b[1;32m[deckseb]\x1b[0m Spawning interactive session for \x1b[1m${req.hostId}\x1b[0m (PID: ${newSession.pid})`,
          `Ready in directory: ${newSession.cwd}`,
          '',
        ])
        this.quotas.set(id, {
          sessionId: id,
          modelName: req.hostId === 'claude' ? 'claude-3-7-sonnet' : 'gemini-3.8-flash',
          usedTokens: 18000,
          maxTokens: 200000,
          remainingPercent: 91,
          inputTokens: 15000,
          outputTokens: 3000,
          quotaUsedPercent: 9,
          quotaWindowLabel: 'Window: 1M tokens/min • 9% utilized',
          warningLevel: 'healthy',
        })
        return newSession as any
      }

      case 'deck:terminal_write': {
        const req = args as TauriDeckCommands['deck:terminal_write']['request']
        this.handleTerminalInput(req.sessionId, req.data)
        return undefined as any
      }

      case 'deck:terminal_resize': {
        return undefined as any
      }

      case 'deck:terminal_close': {
        const req = args as TauriDeckCommands['deck:terminal_close']['request']
        this.terminalSessions.delete(req.sessionId)
        this.terminalOutputs.delete(req.sessionId)
        this.quotas.delete(req.sessionId)
        return undefined as any
      }

      case 'deck:terminal_list': {
        return Array.from(this.terminalSessions.values()) as any
      }

      case 'deck:ecosystem_snapshot': {
        const snapshot: SebEcosystemSnapshot = {
          optionalMode: true,
          hubsebDetected: true,
          crewsebDetected: true,
          memosebDetected: true,
          herdrDetected: true,
          availableHosts: [...SUPPORTED_AGENT_HOSTS],
          concurrencyMode: 'parallel',
          maxLocalParallel: 4,
          preset: 'cloud-tiered',
          personas: {
            researcher: 'Theo',
            analyst: 'Axel',
            architect: 'Juno',
            developer: 'Orion',
            'qa-automation': 'Atlas',
            devops: 'Vera',
            sre: 'Sloan',
            security: 'Kael',
            'code-reviewer': 'Lyra',
            documenter: 'Nova',
          },
          activeSubagents: [...this.activeSubagents],
          memoEvents: [...this.memoEvents],
          vaultStats: { ...this.vaultStats },
        }
        return snapshot as any
      }

      case 'deck:session_quota': {
        const req = args as TauriDeckCommands['deck:session_quota']['request']
        const quota = this.quotas.get(req.sessionId) || {
          sessionId: req.sessionId,
          modelName: 'gemini-3.8-flash',
          usedTokens: 52000,
          maxTokens: 200000,
          remainingPercent: 74,
          inputTokens: 45000,
          outputTokens: 7000,
          quotaUsedPercent: 26,
          quotaWindowLabel: 'Window: 1M tokens/min • 26% utilized',
          warningLevel: 'healthy' as const,
        }
        return quota as any
      }

      case 'deck:artifacts_list': {
        const req = args as TauriDeckCommands['deck:artifacts_list']['request']
        let list = [...this.artifacts]
        if (req && req.segment) {
          list = list.filter((a) => a.segment === req.segment)
        }
        if (req && req.sessionId) {
          list = list.filter((a) => a.sessionId === req.sessionId)
        }
        return list as any
      }

      case 'deck:sync_artifact_memoseb': {
        const req = args as TauriDeckCommands['deck:sync_artifact_memoseb']['request']
        const target = this.artifacts.find((a) => a.id === req.artifactId)
        if (target) {
          target.syncedToMemoseb = true
          target.memosebCategory = req.category
          this.vaultStats.memoryCount += 1
          this.vaultStats.totalTokens += 350

          const event: MemoActivityEvent = {
            id: `memo-ev-${Date.now()}`,
            timestamp: new Date().toISOString(),
            action: 'remember',
            projectId: target.projectSlug,
            summary: `Sincronizado artefacto '${target.title}' en categoría '${req.category}'`,
            tokenCount: 350,
            category: req.category,
          }
          this.memoEvents.unshift(event)
          this.emit('deck:memo-event', event)

          return {
            success: true,
            memoryId: `mem-${Math.random().toString(36).slice(2, 10)}`,
          } as any
        }
        return { success: false, error: 'Artifact not found' } as any
      }

      case 'deck:memo_events_list': {
        const req = args as TauriDeckCommands['deck:memo_events_list']['request']
        const limit = req?.limit || 20
        return this.memoEvents.slice(0, limit) as any
      }

      case 'deck:get_theme': {
        return this.currentTheme as any
      }

      case 'deck:set_theme': {
        const req = args as TauriDeckCommands['deck:set_theme']['request']
        this.currentTheme = req.mode
        if (typeof window !== 'undefined') {
          localStorage.setItem('deckseb_theme', req.mode)
          document.documentElement.setAttribute('data-theme', req.mode)
        }
        return this.currentTheme as any
      }

      default:
        throw new Error(`Unhandled deck command: ${command}`)
    }
  }

  // --- Terminal Interactive Command Parser ---

  private handleTerminalInput(sessionId: string, input: string): void {
    const trimmed = input.trim()
    const output = this.terminalOutputs.get(sessionId) || []
    output.push(`\x1b[36m$ \x1b[0m${input}`)

    if (trimmed === '/compact') {
      const q = this.quotas.get(sessionId)
      if (q) {
        q.usedTokens = Math.floor(q.usedTokens * 0.3)
        q.remainingPercent = Math.min(100, Math.floor(((q.maxTokens - q.usedTokens) / q.maxTokens) * 100))
        q.quotaUsedPercent = 100 - q.remainingPercent
        q.warningLevel = q.remainingPercent < 20 ? 'critical' : q.remainingPercent < 45 ? 'warning' : 'healthy'
        this.emit('deck:quota-updated', { ...q })
      }
      output.push(
        '\x1b[32m✔ Context window compacted successfully.\x1b[0m',
        `\x1b[90mRemaining tokens recovered: ${q ? q.remainingPercent : 80}% available (healthy)\x1b[0m`,
        ''
      )
    } else if (trimmed === '/plan' || trimmed.startsWith('/plan ')) {
      output.push('\x1b[33m⚡ Synthesizing plan with Mermaid architectural diagram...\x1b[0m')
      const planArtifact = this.triggerSimulatedPlan(sessionId)
      output.push(
        `\x1b[32m✔ Implementation Plan generated:\x1b[0m ${planArtifact.title}`,
        `\x1b[34m→ Auto-opening Lateral Plan Drawer (segment: ${planArtifact.segment})\x1b[0m`,
        ''
      )
    } else if (trimmed === 'crewseb models list') {
      output.push(
        '\x1b[1mHost: antigravity | Preset: cloud-tiered | Concurrency: parallel (max-local: 4)\x1b[0m',
        '┌──────────────┬──────────┬──────────────┬──────────────────┬────────────────────────┐',
        '│ Role         │ Persona  │ Tier         │ Model            │ Worktree               │',
        '├──────────────┼──────────┼──────────────┼──────────────────┼────────────────────────┤',
        '│ architect    │ Juno     │ deep         │ gemini-pro       │ .worktrees/core-backend│',
        '│ developer    │ Orion    │ deep         │ gemini-pro       │ .worktrees/ui-frontend │',
        '│ security     │ Kael     │ deep         │ gemini-pro       │ (shared)               │',
        '│ code-reviewer│ Lyra     │ deep         │ gemini-pro       │ (shared)               │',
        '│ researcher   │ Theo     │ balanced     │ gemini-3.8-flash │ .worktrees/research    │',
        '│ analyst      │ Axel     │ balanced     │ gemini-3.8-flash │ (shared)               │',
        '│ qa-automation│ Atlas    │ balanced     │ gemini-3.8-flash │ .worktrees/qa          │',
        '│ devops       │ Vera     │ balanced     │ gemini-3.8-flash │ (shared)               │',
        '│ sre          │ Sloan    │ balanced     │ gemini-3.8-flash │ (shared)               │',
        '│ documenter   │ Nova     │ balanced     │ gemini-3.8-flash │ (shared)               │',
        '└──────────────┴──────────┴──────────────┴──────────────────┴────────────────────────┘',
        ''
      )
    } else if (trimmed === 'memoseb context') {
      const ev: MemoActivityEvent = {
        id: `memo-ev-${Date.now()}`,
        timestamp: new Date().toISOString(),
        action: 'context',
        projectId: 'deckseb',
        summary: 'Loaded 4 architectural memories into session context',
        tokenCount: 980,
      }
      this.memoEvents.unshift(ev)
      this.emit('deck:memo-event', ev)
      output.push(
        '\x1b[1;34m[memoseb]\x1b[0m Context Briefing loaded from \x1b[90m~/.config/hubseb/memoseb/vault.db\x1b[0m',
        '  • [architecture] Patrón de ejecución nocturna desatendida en modo cola (queue)',
        '  • [decision] Configuración recomendada de subagentes crewseb en Antigravity',
        '  • [architecture] Soporte Multi-Orquestador en crewseb (Claude, Codex, Antigravity)',
        '  • [convention] Directivas Globales de Ingeniería y Worktrees aislados',
        '\x1b[32m✔ Total Context Tokens Injected: 980 tokens\x1b[0m',
        ''
      )
    } else if (trimmed === 'clear') {
      output.length = 0
    } else if (trimmed.length > 0) {
      output.push(`Executed: ${trimmed}`, '')
    }

    this.terminalOutputs.set(sessionId, output)
    this.emit('deck:terminal-data', {
      sessionId,
      data: output.join('\n'),
    })
  }

  // --- Public API Methods ---

  public async createTerminal(params: {
    hostId: AgentHostId
    cwd?: string
    title?: string
    command?: string
  }): Promise<TerminalSession> {
    const session = await this.invokeCommand('deck:terminal_create', params)
    return session
  }

  public async writeTerminal(sessionId: string, data: string): Promise<void> {
    await this.invokeCommand('deck:terminal_write', { sessionId, data })
  }

  public async closeTerminal(sessionId: string): Promise<void> {
    await this.invokeCommand('deck:terminal_close', { sessionId })
  }

  public async listTerminals(): Promise<TerminalSession[]> {
    return await this.invokeCommand('deck:terminal_list')
  }

  public getTerminalHistory(sessionId: string): string[] {
    return this.terminalOutputs.get(sessionId) || []
  }

  public async getEcosystemSnapshot(forceRefresh: boolean = false): Promise<SebEcosystemSnapshot> {
    return await this.invokeCommand('deck:ecosystem_snapshot', { forceRefresh })
  }

  public async getSessionQuota(sessionId: string): Promise<SessionContextQuota> {
    return await this.invokeCommand('deck:session_quota', { sessionId })
  }

  public async listArtifacts(filter?: {
    sessionId?: string
    projectSlug?: string
    segment?: ArtifactSegment
  }): Promise<DetectedArtifact[]> {
    return await this.invokeCommand('deck:artifacts_list', filter)
  }

  public async syncArtifactToMemoseb(
    artifactId: string,
    category: MemosebCategory,
    title?: string,
    tags?: string[]
  ): Promise<{ success: boolean; memoryId?: string; error?: string }> {
    return await this.invokeCommand('deck:sync_artifact_memoseb', {
      artifactId,
      category,
      title,
      tags,
    })
  }

  public async listMemoEvents(limit: number = 20): Promise<MemoActivityEvent[]> {
    return await this.invokeCommand('deck:memo_events_list', { limit })
  }

  public async getTheme(): Promise<ThemeMode> {
    return await this.invokeCommand('deck:get_theme')
  }

  public async setTheme(mode: ThemeMode): Promise<ThemeMode> {
    return await this.invokeCommand('deck:set_theme', { mode })
  }

  // --- Trigger Simulated Plan & Mermaid ---

  public triggerSimulatedPlan(sessionId?: string, title?: string): DetectedArtifact {
    const sId = sessionId || Array.from(this.terminalSessions.keys())[0] || 'session-agy-01'
    const planNumber = this.artifacts.length + 1
    const artifactTitle = title || `Plan Táctico #${planNumber}: Despliegue Paralelo Multi-Worktree`

    const newArtifact: DetectedArtifact = {
      id: `art-plan-${Date.now()}`,
      sessionId: sId,
      projectSlug: 'deckseb',
      segment: 'plans',
      title: artifactTitle,
      filePath: `plans/00${planNumber}-deployment-plan.md`,
      content: `# ${artifactTitle}

Plan generado automáticamente por el especialista de orquestación.

### Matriz de Despacho Paralelo:
- **Paso 1:** Juno (🧭 [Juno · architect]) define la arquitectura del núcleo en \`.worktrees/core-backend\`.
- **Paso 2:** Orion (🛠️ [Orion · developer]) implementa los componentes visuales en \`.worktrees/ui-frontend\`.
- **Paso 3:** Atlas (🧪 [Atlas · qa-automation]) ejecuta la suite de pruebas automatizadas.
- **Paso 4:** Lyra (🔍 [Lyra · code-reviewer]) realiza la auditoría de calidad y diffs.

### Sincronización Memoseb:
Los aprendizajes y convenciones son indexados directamente en la base de datos de memoria contextual.`,
      mermaidBlocks: [
        `flowchart TD
  User["Usuario / Orquestador"] --> Juno["🧭 Juno (architect)"]
  Juno --> Orion["🛠️ Orion (developer)"]
  Orion --> Atlas["🧪 Atlas (qa-automation)"]
  Atlas --> Lyra["🔍 Lyra (code-reviewer)"]
  Lyra --> Merged["Merge to Develop"]`,
      ],
      detectedAt: new Date().toISOString(),
      syncedToMemoseb: false,
      memosebCategory: 'architecture',
    }

    this.artifacts.unshift(newArtifact)
    // Dispatch event to trigger autoOpenOnPlan in UI!
    this.emit('deck:artifact-detected', newArtifact)
    return newArtifact
  }
}

export const deckClient = new DeckClientService()
