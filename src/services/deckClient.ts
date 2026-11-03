/**
 * deckClient.ts
 * Decoupled IPC client for deckseb minimal plan viewer (Tauri v2 + in-memory simulation fallback)
 */

import {
  type ArtifactSegment,
  type DeckCommandName,
  type DeckEventName,
  type DetectedArtifact,
  type MemosebCategory,
  type TauriDeckCommands,
  type TauriDeckEvents,
  type ThemeMode,
} from '../types/deck.ts'

type EventCallback<T = any> = (payload: T) => void

function extractMermaidBlocks(content: string): string[] {
  const blocks: string[] = []
  const regex = /```mermaid\s*([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim())
    }
  }
  return blocks
}

function classifySegment(filePath?: string, content?: string): ArtifactSegment {
  const lowerPath = (filePath || '').toLowerCase()
  const lowerContent = (content || '').toLowerCase()

  if (
    lowerPath.includes('post-mortem') ||
    lowerPath.includes('postmortem') ||
    lowerContent.includes('root cause analysis')
  ) {
    return 'post-mortems'
  }
  if (
    lowerPath.includes('review') ||
    lowerPath.includes('audit') ||
    lowerContent.includes('code review') ||
    lowerContent.includes('security audit')
  ) {
    return 'reviews'
  }
  if (
    lowerPath.includes('spec') ||
    lowerPath.endsWith('.feature') ||
    lowerContent.includes('scenario:')
  ) {
    return 'specs'
  }
  if (lowerPath.endsWith('.mmd') || lowerPath.includes('/diagram')) {
    return 'diagrams'
  }
  return 'plans'
}

function extractTitle(content: string, filePath?: string): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) {
      return trimmed.replace(/^#\s*/, '').trim()
    }
  }
  if (filePath) {
    const parts = filePath.split('/')
    return parts[parts.length - 1] || 'Detected Artifact'
  }
  return 'Detected Artifact'
}

class DeckClientService {
  private listeners: Map<DeckEventName, Set<EventCallback>> = new Map()
  private isTauri: boolean = false
  private artifacts: DetectedArtifact[] = []
  private currentTheme: ThemeMode = 'dark'

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
      document.documentElement.setAttribute('data-theme', this.currentTheme)
    }
  }

  public isRunningInTauri(): boolean {
    return this.isTauri
  }

  // --- Event Pub/Sub ---

  public on<E extends DeckEventName>(
    event: E,
    callback: (payload: TauriDeckEvents[E]) => void
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback as EventCallback)

    return () => {
      this.off(event, callback)
    }
  }

  public off<E extends DeckEventName>(
    event: E,
    callback: (payload: TauriDeckEvents[E]) => void
  ): void {
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

  // --- Initial Mock Data for UI / Simulation Mode ---

  private initDefaultMockData(): void {
    this.artifacts = [
      {
        id: 'art-plan-01',
        sessionId: 'session-agy-01',
        projectSlug: 'deckseb',
        segment: 'plans',
        title: 'Plan de Implementación: Visor Editorial Minimalista de Planes',
        filePath: 'plans/001-minimal-plan-viewer.md',
        content: `# Plan: Visor Editorial Minimalista de Planes

Arquitectura de lectura pura para planes generados por orquestadores y modelos de IA.

### Objetivos Principales:
1. Shell minimalista estilo macOS Sequoia sin terminales PTY ni widgets de telemetría.
2. Renderizado editorial de alta legibilidad con diagramas Mermaid integrados.
3. Detección automática en vivo cuando se generen nuevos planes.
4. Sincronización fluida de conocimiento hacia memoseb.

### Matriz de Despacho:
- **Juno (🧭 [Juno · architect]):** Contratos de tipos minimalistas en \`src/types/deck.ts\`.
- **Orion (🛠️ [Orion · developer]):** Depuración de React y backend nativo Tauri v2.
- **Atlas (🧪 [Atlas · qa-automation]):** Suite de verificación y validación E2E.`,
        mermaidBlocks: [
          `flowchart TD
  Host["Modelo / Orquestador (AGY / Claude / Codex)"] -->|File Watcher / IPC| Deck["deckseb Minimal Viewer"]
  Deck --> Read["Lectura Editorial de Planes"]
  Deck --> Mmd["Renderizado Mermaid"]
  Deck --> Memo["Sincronización memoseb"]`,
        ],
        detectedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
        syncedToMemoseb: true,
        memosebCategory: 'architecture',
      },
      {
        id: 'art-diag-02',
        sessionId: 'session-agy-01',
        projectSlug: 'deckseb',
        segment: 'diagrams',
        title: 'Topología de Nodos Hubseb y Deckseb como Leaf Node',
        filePath: 'diagrams/002-hubseb-topology.md',
        content: `# Topología de Nodos

Hubseb actúa como el orquestador central del ecosistema *seb. Deckseb opera como un nodo hoja pasivo (\`ui.deck\`) enfocado exclusivamente en la inspección visual inmediata de artefactos sin acoplarse al ciclo de ejecución.`,
        mermaidBlocks: [
          `graph LR
  Hub["hubseb (Root / Bus)"] --- Crew["crewseb (10 roles)"]
  Hub --- Memo["memoseb (Vault DB)"]
  Hub --- Deck["deckseb (Passive Plan Viewer)"]`,
        ],
        detectedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        syncedToMemoseb: false,
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
      case 'deck:artifacts_list': {
        const req = args as TauriDeckCommands['deck:artifacts_list']['request']
        let list = [...this.artifacts]
        if (req && req.segment) {
          list = list.filter((a) => a.segment === req.segment)
        }
        if (req && req.sessionId) {
          list = list.filter((a) => a.sessionId === req.sessionId)
        }
        if (req && req.projectSlug) {
          list = list.filter((a) => a.projectSlug === req.projectSlug)
        }
        return list as TauriDeckCommands[K]['response']
      }

      case 'deck:plan_submit': {
        const req = args as TauriDeckCommands['deck:plan_submit']['request']
        if (!req || !req.content) {
          return null as TauriDeckCommands[K]['response']
        }
        const segment = classifySegment(req.filePath, req.content)
        const title = req.title || extractTitle(req.content, req.filePath)
        const newArtifact: DetectedArtifact = {
          id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sessionId: 'session-default',
          projectSlug: req.projectSlug || 'deckseb',
          segment,
          title,
          filePath: req.filePath || `plans/plan-${Date.now()}.md`,
          content: req.content,
          mermaidBlocks: extractMermaidBlocks(req.content),
          detectedAt: new Date().toISOString(),
          syncedToMemoseb: false,
        }
        this.artifacts.unshift(newArtifact)
        this.emit('deck:artifact-detected', newArtifact)
        return newArtifact as TauriDeckCommands[K]['response']
      }

      case 'deck:sync_artifact_memoseb': {
        const req = args as TauriDeckCommands['deck:sync_artifact_memoseb']['request']
        const target = this.artifacts.find((a) => a.id === req.artifactId)
        if (target) {
          target.syncedToMemoseb = true
          target.memosebCategory = req.category
          return {
            success: true,
            memoryId: `mem-${Math.random().toString(36).slice(2, 10)}`,
          } as TauriDeckCommands[K]['response']
        }
        return { success: false, error: 'Artifact not found' } as TauriDeckCommands[K]['response']
      }

      case 'deck:get_theme': {
        return this.currentTheme as TauriDeckCommands[K]['response']
      }

      case 'deck:set_theme': {
        const req = args as TauriDeckCommands['deck:set_theme']['request']
        this.currentTheme = req.mode
        if (typeof window !== 'undefined') {
          localStorage.setItem('deckseb_theme', req.mode)
          document.documentElement.setAttribute('data-theme', req.mode)
        }
        return this.currentTheme as TauriDeckCommands[K]['response']
      }

      default:
        throw new Error(`Unhandled deck command: ${command as string}`)
    }
  }

  // --- Public API Methods ---

  public async listArtifacts(filter?: {
    sessionId?: string
    projectSlug?: string
    segment?: ArtifactSegment
  }): Promise<DetectedArtifact[]> {
    return await this.invokeCommand('deck:artifacts_list', filter)
  }

  public async submitPlan(params: {
    title?: string
    content: string
    filePath?: string
    projectSlug?: string
  }): Promise<DetectedArtifact | null> {
    const result = await this.invokeCommand('deck:plan_submit', params)
    if (result) {
      const exists = this.artifacts.some((a) => a.id === result.id)
      if (!exists) {
        this.artifacts.unshift(result)
      }
      this.emit('deck:artifact-detected', result)
      return result
    }
    return null
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

  public async getTheme(): Promise<ThemeMode> {
    const theme = await this.invokeCommand('deck:get_theme')
    this.currentTheme = theme
    return theme
  }

  public async setTheme(mode: ThemeMode): Promise<ThemeMode> {
    const updated = await this.invokeCommand('deck:set_theme', { mode })
    this.currentTheme = updated
    if (typeof window !== 'undefined') {
      localStorage.setItem('deckseb_theme', updated)
      document.documentElement.setAttribute('data-theme', updated)
    }
    return updated
  }

  public triggerSimulatedPlan(title?: string): DetectedArtifact {
    const planNumber = this.artifacts.length + 1
    const artifactTitle = title || `Plan Táctico #${planNumber}: Despliegue Paralelo Multi-Worktree`

    const newArtifact: DetectedArtifact = {
      id: `art-plan-${Date.now()}`,
      sessionId: 'session-simulated',
      projectSlug: 'deckseb',
      segment: 'plans',
      title: artifactTitle,
      filePath: `plans/00${planNumber}-deployment-plan.md`,
      content: `# ${artifactTitle}

Plan generado para verificación táctica del visor editorial minimalista.

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
    this.emit('deck:artifact-detected', newArtifact)
    return newArtifact
  }
}

export const deckClient = new DeckClientService()
