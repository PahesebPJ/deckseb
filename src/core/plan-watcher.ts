import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  DetectedArtifact,
  PlanWatcherCallback,
  PlanWatcherEvent,
  PlanWatcherEventType,
  PlanWatcherOptions,
} from '../types/deck.ts'
import {
  classifyArtifactSegment,
  defaultCategoryForSegment,
  detectPlanInStream,
  extractMermaidBlocks,
} from './plan-detector.ts'

interface TrackedFile {
  mtimeMs: number
  hash: string
  artifact: DetectedArtifact
  isExplicit: boolean
}

/**
 * Recursively discovers markdown and mermaid files in a directory up to maxDepth.
 */
async function findMarkdownFiles(dir: string, maxDepth = 6): Promise<string[]> {
  const results: string[] = []

  async function recurse(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === '.worktrees' ||
          entry.name === 'dist' ||
          entry.name === 'target' ||
          entry.name === '.cache'
        ) {
          continue
        }
        await recurse(fullPath, depth + 1)
      } else if (entry.isFile()) {
        if (/\.(md|markdown|mmd)$/i.test(entry.name)) {
          results.push(fullPath)
        }
      }
    }
  }

  await recurse(dir, 0)
  return results
}

/**
 * PlanWatcher detects, parses, and reactively watches implementation plans
 * in Antigravity CLI brain directories, project vaults, and local workspace paths.
 */
export class PlanWatcher {
  private readonly projectSlug: string
  private readonly pollIntervalMs: number
  private readonly includeAntigravityBrain: boolean
  private readonly homeDir: string
  private readonly configuredWatchDirs: string[]
  private readonly configuredWatchFiles: string[]

  private readonly explicitWatchedFiles = new Set<string>()
  private readonly knownFiles = new Map<string, TrackedFile>()
  private readonly callbacks = new Set<PlanWatcherCallback>()
  private readonly fsWatchers: fsSync.FSWatcher[] = []
  private readonly watchedDirsSet = new Set<string>()

  private timer: NodeJS.Timeout | null = null
  private running = false
  private currentScanPromise: Promise<DetectedArtifact[]> | null = null

  constructor(options?: PlanWatcherOptions) {
    this.projectSlug = options?.projectSlug ?? 'deckseb'
    this.pollIntervalMs = options?.pollIntervalMs ?? 750
    this.includeAntigravityBrain = options?.includeAntigravityBrain !== false
    this.homeDir = options?.homeDir ?? os.homedir()
    this.configuredWatchDirs = options?.watchDirs
      ? [...options.watchDirs]
      : options?.homeDir
        ? []
        : ['./plans', './.seb-vault', './.claude']
    this.configuredWatchFiles = options?.watchFiles ? [...options.watchFiles] : []
  }

  /**
   * Registers an event callback for plan lifecycle events (created, updated, deleted).
   * Returns an unsubscribe function.
   */
  onPlan(callback: PlanWatcherCallback): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  /**
   * Starts the reactive watcher: performs an immediate scan, registers fs.watch
   * where available, and arms the polling loop.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    await this.scanNow()
    this.setupFsWatchers()

    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.scanNow().catch(() => {})
      }, this.pollIntervalMs)
      this.timer.unref()
    }
  }

  /**
   * Stops the watcher, clears timers and closes all filesystem monitors.
   */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const watcher of this.fsWatchers) {
      try {
        watcher.close()
      } catch {
        // ignore close errors
      }
    }
    this.fsWatchers.length = 0
    this.watchedDirsSet.clear()
  }

  /**
   * Performs an immediate scan of all watched targets, emitting plan events
   * and returning the current list of all active detected artifacts.
   */
  async scanNow(): Promise<DetectedArtifact[]> {
    if (this.currentScanPromise) {
      return this.currentScanPromise
    }
    this.currentScanPromise = this.performScan().finally(() => {
      this.currentScanPromise = null
    })
    return this.currentScanPromise
  }

  /**
   * Manually attaches and watches a specific file. Parses the content
   * (falling back to a generic DetectedArtifact if plain markdown),
   * updates tracking state, and emits a created/updated event to subscribers.
   */
  async watchFile(filePath: string): Promise<DetectedArtifact | null> {
    const absPath = path.resolve(process.cwd(), filePath)
    this.explicitWatchedFiles.add(absPath)

    try {
      const stat = await fs.stat(absPath)
      if (!stat.isFile()) return null

      const content = await fs.readFile(absPath, 'utf8')
      const hash = createHash('sha256').update(content).digest('hex')
      const sessionId = this.deriveSessionId(absPath)

      let artifact = detectPlanInStream(sessionId, this.projectSlug, content, absPath)
      if (!artifact) {
        artifact = this.buildFallbackArtifact(absPath, content, sessionId)
      }

      const known = this.knownFiles.get(absPath)
      let eventType: PlanWatcherEventType | null = null

      if (!known) {
        eventType = 'plan:created'
      } else if (known.hash !== hash) {
        eventType = 'plan:updated'
      }

      this.knownFiles.set(absPath, {
        mtimeMs: stat.mtimeMs,
        hash,
        artifact,
        isExplicit: true,
      })

      if (eventType) {
        this.emitEvent({
          type: eventType,
          artifact,
          filePath: absPath,
          timestamp: new Date().toISOString(),
        })
      }

      return artifact
    } catch {
      return null
    }
  }

  /**
   * Returns a deduplicated list of all paths currently watched or configured.
   */
  getWatchedPaths(): string[] {
    const paths = new Set<string>()

    if (this.includeAntigravityBrain) {
      paths.add(path.join(this.homeDir, '.gemini', 'antigravity-cli', 'brain'))
    }

    for (const d of this.configuredWatchDirs) {
      paths.add(path.resolve(process.cwd(), d))
    }

    for (const f of this.configuredWatchFiles) {
      paths.add(path.resolve(process.cwd(), f))
    }

    for (const f of this.explicitWatchedFiles) {
      paths.add(f)
    }

    return Array.from(paths)
  }

  private getExistingWatchDirectories(): string[] {
    const candidateDirs = new Set<string>()

    if (this.includeAntigravityBrain) {
      candidateDirs.add(path.join(this.homeDir, '.gemini', 'antigravity-cli', 'brain'))
    }

    for (const d of this.configuredWatchDirs) {
      candidateDirs.add(path.resolve(process.cwd(), d))
    }

    const existing: string[] = []
    for (const dir of candidateDirs) {
      try {
        const stat = fsSync.statSync(dir)
        if (stat.isDirectory()) {
          existing.push(dir)
        }
      } catch {
        // Directory does not exist yet
      }
    }

    return existing
  }

  private setupFsWatchers(): void {
    const existingDirs = this.getExistingWatchDirectories()
    for (const dir of existingDirs) {
      if (!this.watchedDirsSet.has(dir)) {
        try {
          const watcher = fsSync.watch(dir, { recursive: true }, () => {
            void this.scanNow().catch(() => {})
          })
          watcher.on('error', () => {
            try {
              watcher.close()
            } catch {
              // ignore close errors
            }
          })
          this.fsWatchers.push(watcher)
          this.watchedDirsSet.add(dir)
        } catch {
          // Graceful fallback to interval polling
        }
      }
    }
  }

  private async performScan(): Promise<DetectedArtifact[]> {
    if (this.running) {
      this.setupFsWatchers()
    }

    const candidateFiles = new Set<string>()

    // 1. Gather files from existing directories
    const existingDirs = this.getExistingWatchDirectories()
    for (const dir of existingDirs) {
      const files = await findMarkdownFiles(dir)
      for (const f of files) {
        candidateFiles.add(f)
      }
    }

    // 2. Gather explicitly configured / watched files
    for (const f of this.configuredWatchFiles) {
      const abs = path.resolve(process.cwd(), f)
      if (fsSync.existsSync(abs)) {
        candidateFiles.add(abs)
      }
    }

    for (const f of this.explicitWatchedFiles) {
      if (fsSync.existsSync(f)) {
        candidateFiles.add(f)
      }
    }

    const seenPaths = new Set<string>()

    // 3. Process candidate files
    for (const filePath of candidateFiles) {
      seenPaths.add(filePath)

      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) continue

        const known = this.knownFiles.get(filePath)
        const isExplicit = this.explicitWatchedFiles.has(filePath)

        if (known && known.mtimeMs === stat.mtimeMs) {
          continue
        }

        const content = await fs.readFile(filePath, 'utf8')
        const hash = createHash('sha256').update(content).digest('hex')

        if (known && known.hash === hash) {
          known.mtimeMs = stat.mtimeMs
          continue
        }

        const sessionId = this.deriveSessionId(filePath)
        let artifact = detectPlanInStream(sessionId, this.projectSlug, content, filePath)

        if (!artifact && isExplicit) {
          artifact = this.buildFallbackArtifact(filePath, content, sessionId)
        }

        if (!artifact) {
          // If it was previously tracked but now no longer qualifies
          if (known) {
            this.knownFiles.delete(filePath)
            this.emitEvent({
              type: 'plan:deleted',
              artifact: known.artifact,
              filePath,
              timestamp: new Date().toISOString(),
            })
          }
          continue
        }

        const eventType: PlanWatcherEventType = known ? 'plan:updated' : 'plan:created'
        this.knownFiles.set(filePath, {
          mtimeMs: stat.mtimeMs,
          hash,
          artifact,
          isExplicit,
        })

        this.emitEvent({
          type: eventType,
          artifact,
          filePath,
          timestamp: new Date().toISOString(),
        })
      } catch {
        // Safe error suppression for in-flight file edits
      }
    }

    // 4. Handle deleted files that were previously known
    for (const [trackedPath, known] of this.knownFiles.entries()) {
      if (!seenPaths.has(trackedPath) && !fsSync.existsSync(trackedPath)) {
        this.knownFiles.delete(trackedPath)
        this.emitEvent({
          type: 'plan:deleted',
          artifact: known.artifact,
          filePath: trackedPath,
          timestamp: new Date().toISOString(),
        })
      }
    }

    return Array.from(this.knownFiles.values()).map((k) => k.artifact)
  }

  private deriveSessionId(filePath: string): string {
    const brainMatch = filePath.match(/[/\\]\.gemini[/\\]antigravity-cli[/\\]brain[/\\]([^/\\]+)/i)
    if (brainMatch?.[1]) {
      return brainMatch[1]
    }

    const vaultMatch = filePath.match(/[/\\]\.seb-vault[/\\]([^/\\]+)/i)
    if (vaultMatch?.[1]) {
      return vaultMatch[1]
    }

    return this.projectSlug || 'default-session'
  }

  private buildFallbackArtifact(
    filePath: string,
    content: string,
    sessionId: string
  ): DetectedArtifact {
    let title = ''
    const h1Match = content.match(/^#\s+(.+)$/m)
    if (h1Match?.[1]) {
      title = h1Match[1].trim()
    } else {
      const h2Match = content.match(/^##\s+(.+)$/m)
      if (h2Match?.[1]) {
        title = h2Match[1].trim()
      } else {
        const base = path.basename(filePath, path.extname(filePath))
        title = base
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
      }
    }

    const segment = classifyArtifactSegment(filePath, content)
    const mermaidBlocks = extractMermaidBlocks(content)

    return {
      id: randomUUID(),
      sessionId,
      projectSlug: this.projectSlug,
      segment,
      title,
      filePath,
      content,
      mermaidBlocks,
      detectedAt: new Date().toISOString(),
      syncedToMemoseb: false,
      memosebCategory: defaultCategoryForSegment(segment),
    }
  }

  private emitEvent(event: PlanWatcherEvent): void {
    for (const callback of this.callbacks) {
      try {
        callback(event)
      } catch {
        // Safe callback execution
      }
    }
  }
}
