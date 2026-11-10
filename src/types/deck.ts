/**
 * deckseb minimal architectural domain and IPC contracts.
 * deckseb acts as an instant, passive plan viewer leaf node (`ui.deck`) in hubseb topology.
 */

export type ThemeMode = 'light' | 'dark'

// --- Artifact & Plan Models ---

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

// --- Plan Watcher Models ---

export type PlanWatcherEventType = 'plan:created' | 'plan:updated' | 'plan:deleted'

export interface PlanWatcherEvent {
  type: PlanWatcherEventType
  artifact: DetectedArtifact
  filePath: string
  timestamp: string
}

export type PlanWatcherCallback = (event: PlanWatcherEvent) => void

export interface PlanWatcherOptions {
  watchDirs?: string[]
  watchFiles?: string[]
  projectSlug?: string
  pollIntervalMs?: number
  includeAntigravityBrain?: boolean
  homeDir?: string
}

// --- Tauri v2 IPC Command & Event Specification ---

export interface TauriDeckCommands {
  'deck:artifacts_list': {
    request: {
      sessionId?: string
      projectSlug?: string
      segment?: ArtifactSegment
    } | void
    response: DetectedArtifact[]
  }
  'deck:plan_submit': {
    request: {
      id?: string
      title?: string
      content: string
      filePath?: string
      projectSlug?: string
    }
    response: DetectedArtifact | null
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
  'deck:artifact-detected': DetectedArtifact
}

export type DeckCommandName = keyof TauriDeckCommands
export type DeckEventName = keyof TauriDeckEvents

export const DECK_IPC_COMMANDS: readonly DeckCommandName[] = [
  'deck:artifacts_list',
  'deck:plan_submit',
  'deck:sync_artifact_memoseb',
  'deck:get_theme',
  'deck:set_theme',
] as const

export const DECK_IPC_EVENTS: readonly DeckEventName[] = [
  'deck:artifact-detected',
] as const
