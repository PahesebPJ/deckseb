import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ArtifactSegment,
  DetectedArtifact,
  MemosebCategory,
} from '../types/deck.ts'
import { slugifyTitle } from './plan-detector.ts'

const execFileAsync = promisify(execFile)

export interface ProjectManifest {
  projectSlug: string
  updatedAt: string
  artifacts: DetectedArtifact[]
}

export interface SegmentedArtifactVaultOptions {
  vaultRoot?: string
  memosebBin?: string
}

export class SegmentedArtifactVault {
  readonly vaultRoot: string
  private readonly defaultMemosebBin?: string

  constructor(options?: SegmentedArtifactVaultOptions) {
    this.vaultRoot = options?.vaultRoot ?? path.resolve(process.cwd(), '.seb-vault')
    this.defaultMemosebBin = options?.memosebBin
  }

  private getProjectDir(projectSlug: string): string {
    return path.join(this.vaultRoot, projectSlug)
  }

  private getManifestPath(projectSlug: string): string {
    return path.join(this.getProjectDir(projectSlug), 'manifest.json')
  }

  private async loadManifest(projectSlug: string): Promise<ProjectManifest> {
    const manifestPath = this.getManifestPath(projectSlug)
    try {
      const data = await fs.readFile(manifestPath, 'utf8')
      return JSON.parse(data) as ProjectManifest
    } catch {
      return {
        projectSlug,
        updatedAt: new Date().toISOString(),
        artifacts: [],
      }
    }
  }

  private async saveManifest(manifest: ProjectManifest): Promise<void> {
    const manifestPath = this.getManifestPath(manifest.projectSlug)
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    manifest.updatedAt = new Date().toISOString()
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  }

  /**
   * Writes the artifact to its segmented folder (<vaultRoot>/<projectSlug>/<segment>/<slug>.md),
   * extracts any Mermaid diagrams into diagrams/<slug>-diagram-<n>.mmd,
   * and updates manifest.json.
   */
  async saveArtifact(artifact: DetectedArtifact): Promise<DetectedArtifact> {
    const projectDir = this.getProjectDir(artifact.projectSlug)
    const segmentDir = path.join(projectDir, artifact.segment)
    const diagramsDir = path.join(projectDir, 'diagrams')

    await fs.mkdir(segmentDir, { recursive: true })

    const slug = slugifyTitle(artifact.title)
    const fileName = `${slug}.md`
    const targetFilePath = path.join(segmentDir, fileName)

    // Save markdown content
    await fs.writeFile(targetFilePath, artifact.content, 'utf8')

    // Save individual mermaid diagrams if present
    if (artifact.mermaidBlocks && artifact.mermaidBlocks.length > 0) {
      await fs.mkdir(diagramsDir, { recursive: true })
      for (let i = 0; i < artifact.mermaidBlocks.length; i++) {
        const diagramCode = artifact.mermaidBlocks[i]!
        const diagramFile = path.join(diagramsDir, `${slug}-diagram-${i + 1}.mmd`)
        await fs.writeFile(diagramFile, diagramCode, 'utf8')
      }
    }

    const updatedArtifact: DetectedArtifact = {
      ...artifact,
      filePath: targetFilePath,
    }

    // Persist to project manifest
    const manifest = await this.loadManifest(artifact.projectSlug)
    const existingIndex = manifest.artifacts.findIndex(
      (a) => a.id === updatedArtifact.id
    )
    if (existingIndex >= 0) {
      manifest.artifacts[existingIndex] = updatedArtifact
    } else {
      manifest.artifacts.push(updatedArtifact)
    }
    await this.saveManifest(manifest)

    return updatedArtifact
  }

  /**
   * Lists artifacts from manifests, optionally filtered by projectSlug, segment, or sessionId.
   */
  async listArtifacts(filter?: {
    projectSlug?: string
    segment?: ArtifactSegment
    sessionId?: string
  }): Promise<DetectedArtifact[]> {
    const results: DetectedArtifact[] = []

    if (filter?.projectSlug) {
      const manifest = await this.loadManifest(filter.projectSlug)
      results.push(...manifest.artifacts)
    } else {
      // Scan all project folders in vaultRoot
      try {
        const entries = await fs.readdir(this.vaultRoot, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const manifest = await this.loadManifest(entry.name)
            results.push(...manifest.artifacts)
          }
        }
      } catch {
        // vaultRoot may not exist yet; return empty list
        return []
      }
    }

    return results.filter((art) => {
      if (filter?.segment && art.segment !== filter.segment) {
        return false
      }
      if (filter?.sessionId && art.sessionId !== filter.sessionId) {
        return false
      }
      return true
    })
  }

  /**
   * Resolves the executable path to `memoseb` or null if not found.
   */
  private resolveMemosebBin(candidate?: string): { bin: string; isNodeScript: boolean } | null {
    if (candidate) {
      if (fsSync.existsSync(candidate)) {
        return { bin: candidate, isNodeScript: candidate.endsWith('.js') || candidate.endsWith('.ts') }
      }
      return null
    }

    if (this.defaultMemosebBin) {
      if (fsSync.existsSync(this.defaultMemosebBin)) {
        return {
          bin: this.defaultMemosebBin,
          isNodeScript: this.defaultMemosebBin.endsWith('.js') || this.defaultMemosebBin.endsWith('.ts'),
        }
      }
      return null
    }

    // Check known project paths
    const localDevBin = '/home/alan/Documents/projects/memoseb/dist/bin/memoseb.js'
    if (fsSync.existsSync(localDevBin)) {
      return { bin: localDevBin, isNodeScript: true }
    }

    return null
  }

  /**
   * Synchronizes an artifact to memoseb using `memoseb remember`.
   * Gracefully degrades if memoseb is not installed or available.
   */
  async syncArtifactToMemoseb(
    artifactId: string,
    category: MemosebCategory,
    options?: {
      title?: string
      tags?: string[]
      memosebBin?: string
      cwd?: string
    }
  ): Promise<{ success: boolean; memoryId?: string; error?: string }> {
    // 1. Locate the artifact in manifests
    const allArtifacts = await this.listArtifacts()
    const artifact = allArtifacts.find((a) => a.id === artifactId)
    if (!artifact) {
      return {
        success: false,
        error: `Artifact with id "${artifactId}" not found in vault`,
      }
    }

    // 2. Resolve memoseb binary
    const resolved = this.resolveMemosebBin(options?.memosebBin)
    if (!resolved) {
      return {
        success: false,
        error: 'memoseb binary not found (optional tool)',
      }
    }

    const title = options?.title ?? artifact.title
    const tags = options?.tags && options.tags.length > 0
      ? options.tags.join(',')
      : `${artifact.projectSlug},${artifact.segment}`

    try {
      const args: string[] = []
      let executable = resolved.bin

      if (resolved.isNodeScript) {
        executable = process.execPath
        args.push(resolved.bin)
      }

      args.push(
        'remember',
        artifact.content,
        '--project',
        artifact.projectSlug,
        '--title',
        title,
        '--category',
        category,
        '--tags',
        tags,
        '--json'
      )

      const { stdout } = await execFileAsync(executable, args, {
        cwd: options?.cwd ?? process.cwd(),
      })

      let memoryId: string | undefined
      try {
        const json = JSON.parse(stdout)
        memoryId = json.payload?.memory?.id
      } catch {
        const match = stdout.match(/Stored memory \[([a-f0-9-]+)\]/i)
        if (match?.[1]) {
          memoryId = match[1]
        }
      }

      // Mark artifact as synced in manifest
      const manifest = await this.loadManifest(artifact.projectSlug)
      const idx = manifest.artifacts.findIndex((a) => a.id === artifact.id)
      if (idx >= 0) {
        manifest.artifacts[idx] = {
          ...manifest.artifacts[idx]!,
          syncedToMemoseb: true,
          memosebCategory: category,
        }
        await this.saveManifest(manifest)
      }

      return {
        success: true,
        memoryId,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: `memoseb execution failed: ${message}`,
      }
    }
  }
}
