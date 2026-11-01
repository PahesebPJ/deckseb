import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentHostId,
  ConcurrencyMode,
  CrewRole,
  CrewSubagentActivity,
  MemoActivityEvent,
  SebEcosystemSnapshot,
  VaultStats,
} from '../types/deck.ts'

import { DatabaseSync } from 'node:sqlite'

export interface SebEcosystemObserverOptions {
  topologyPath?: string
  crewModelsPath?: string
  crewPersonasPath?: string
  memosebDbPath?: string
  homeDir?: string
}

export const DEFAULT_CREW_PERSONAS: Record<CrewRole, string> = {
  researcher: 'Theo',
  analyst: 'Axel',
  architect: 'Juno',
  developer: 'Orion',
  'qa-automation': 'Elio',
  devops: 'Rhea',
  sre: 'Vega',
  security: 'Kael',
  'code-reviewer': 'Kira',
  documenter: 'Astrid',
}

export class SebEcosystemObserver {
  readonly topologyPath: string
  readonly crewModelsPath: string
  readonly crewPersonasPath: string
  readonly memosebDbPath: string
  readonly homeDir: string

  constructor(options?: SebEcosystemObserverOptions) {
    this.homeDir = options?.homeDir ?? os.homedir()
    this.topologyPath =
      options?.topologyPath ??
      path.join(this.homeDir, '.config', 'hubseb', 'topology.json')
    this.crewModelsPath =
      options?.crewModelsPath ??
      path.join(this.homeDir, '.config', 'hubseb', 'crewseb-models.json')
    this.crewPersonasPath =
      options?.crewPersonasPath ??
      path.join(this.homeDir, '.config', 'hubseb', 'crewseb-personas.json')

    if (options?.memosebDbPath) {
      this.memosebDbPath = options.memosebDbPath
    } else {
      const sqlitePath = path.join(
        this.homeDir,
        '.local',
        'share',
        'memoseb',
        'vault.sqlite'
      )
      const dbPath = path.join(
        this.homeDir,
        '.local',
        'share',
        'memoseb',
        'vault.db'
      )
      this.memosebDbPath = fs.existsSync(sqlitePath) ? sqlitePath : dbPath
    }
  }

  /**
   * Safely reads and parses a JSON file, returning null if it doesn't exist or is invalid.
   */
  private readJsonSafe<T>(filePath: string): T | null {
    try {
      if (!fs.existsSync(filePath)) return null
      const content = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(content) as T
    } catch {
      return null
    }
  }

  /**
   * Queries SQLite database for vault stats using node:sqlite.
   * Degrades gracefully if node:sqlite or file is missing.
   */
  private readVaultStats(): VaultStats {
    const emptyStats: VaultStats = { projectCount: 0, memoryCount: 0, totalTokens: 0 }
    if (!fs.existsSync(this.memosebDbPath)) {
      return emptyStats
    }

    try {
      const db = new DatabaseSync(this.memosebDbPath, { readOnly: true })
      const row = db
        .prepare(
          'SELECT count(distinct project_id) as projectCount, count(*) as memoryCount, coalesce(sum(token_count), 0) as totalTokens FROM memories'
        )
        .get() as {
        projectCount?: number
        memoryCount?: number
        totalTokens?: number
      } | null
      db.close()

      if (row) {
        return {
          projectCount: Number(row.projectCount ?? 0),
          memoryCount: Number(row.memoryCount ?? 0),
          totalTokens: Number(row.totalTokens ?? 0),
        }
      }
      return emptyStats
    } catch {
      return emptyStats
    }
  }

  /**
   * Detects available agent hosts on the host system.
   */
  private detectAvailableHosts(): AgentHostId[] {
    const hosts: AgentHostId[] = ['shell']

    // Antigravity check
    const antigravityDir = path.join(this.homeDir, '.gemini', 'antigravity-cli')
    if (fs.existsSync(antigravityDir)) {
      hosts.push('antigravity')
    }

    // Claude check
    const claudeDir = path.join(this.homeDir, '.anthropic')
    if (fs.existsSync(claudeDir)) {
      hosts.push('claude')
    }

    // Codex check
    const codexDir = path.join(this.homeDir, '.codex')
    if (fs.existsSync(codexDir)) {
      hosts.push('codex')
    }

    // Opencode check
    const opencodeDir = path.join(this.homeDir, '.opencode')
    if (fs.existsSync(opencodeDir)) {
      hosts.push('opencode')
    }

    // Herdr check
    const herdrDir = path.join(this.homeDir, '.herdr')
    if (fs.existsSync(herdrDir)) {
      hosts.push('herdr')
    }

    return hosts
  }

  /**
   * Builds and returns a complete SebEcosystemSnapshot without altering any files.
   */
  getSnapshot(activeSubagents: CrewSubagentActivity[] = [], memoEvents: MemoActivityEvent[] = []): SebEcosystemSnapshot {
    const topology = this.readJsonSafe<{
      nodes?: Record<string, { id?: string; provides?: string[] }>
    }>(this.topologyPath)

    const models = this.readJsonSafe<{
      preset?: string
      concurrency?: { mode?: ConcurrencyMode; maxLocalParallel?: number }
    }>(this.crewModelsPath)

    const personasFile = this.readJsonSafe<{
      personas?: Record<CrewRole, string>
    }>(this.crewPersonasPath)

    const hubsebDetected = Boolean(topology && topology.nodes)
    const crewsebDetected = Boolean(
      (topology?.nodes && 'crewseb' in topology.nodes) ||
        fs.existsSync(this.crewModelsPath) ||
        fs.existsSync(this.crewPersonasPath)
    )
    const memosebDetected = Boolean(
      (topology?.nodes && 'memoseb' in topology.nodes) ||
        fs.existsSync(this.memosebDbPath)
    )
    const herdrDetected = Boolean(
      topology?.nodes && 'herdr' in topology.nodes
    )

    const concurrencyMode: ConcurrencyMode =
      models?.concurrency?.mode ?? 'parallel'
    const maxLocalParallel =
      typeof models?.concurrency?.maxLocalParallel === 'number'
        ? models.concurrency.maxLocalParallel
        : 1
    const preset = models?.preset ?? 'default'

    const personas: Record<CrewRole, string> = {
      ...DEFAULT_CREW_PERSONAS,
      ...(personasFile?.personas ?? {}),
    }

    const vaultStats = this.readVaultStats()
    const availableHosts = this.detectAvailableHosts()

    return {
      optionalMode: true,
      hubsebDetected,
      crewsebDetected,
      memosebDetected,
      herdrDetected,
      availableHosts,
      concurrencyMode,
      maxLocalParallel,
      preset,
      personas,
      activeSubagents,
      memoEvents,
      vaultStats,
    }
  }
}
