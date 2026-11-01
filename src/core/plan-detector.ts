import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  ArtifactSegment,
  DetectedArtifact,
  MemosebCategory,
} from '../types/deck.ts'

/**
 * Extracts all ```mermaid ... ``` code blocks from markdown text.
 */
export function extractMermaidBlocks(markdown: string): string[] {
  if (!markdown || typeof markdown !== 'string') {
    return []
  }

  const blocks: string[] = []
  // Matches ```mermaid followed by code and closing ```
  const regex = /```mermaid[^\n\r]*[\r\n]+([\s\S]*?)```/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(markdown)) !== null) {
    const code = match[1]?.trim()
    if (code) {
      blocks.push(code)
    }
  }

  return blocks
}

/**
 * Classifies an artifact into one of the 5 segments:
 * 'plans' | 'diagrams' | 'specs' | 'reviews' | 'post-mortems'
 */
export function classifyArtifactSegment(
  filePath: string,
  content: string
): ArtifactSegment {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/')
  const normalizedContent = (content || '').toLowerCase()

  // 1. Check file path heuristics
  if (
    normalizedPath.includes('post-mortem') ||
    normalizedPath.includes('postmortem') ||
    normalizedPath.includes('rca')
  ) {
    return 'post-mortems'
  }
  if (
    normalizedPath.includes('review') ||
    normalizedPath.includes('audit')
  ) {
    return 'reviews'
  }
  if (
    normalizedPath.includes('spec') ||
    normalizedPath.includes('bdd') ||
    normalizedPath.endsWith('.feature')
  ) {
    return 'specs'
  }
  if (
    normalizedPath.endsWith('.mmd') ||
    normalizedPath.includes('/diagrams/') ||
    normalizedPath.includes('/diagram/')
  ) {
    return 'diagrams'
  }
  if (
    normalizedPath.includes('plan') ||
    normalizedPath.includes('roadmap')
  ) {
    return 'plans'
  }

  // 2. Check content headings and keywords
  if (
    /#\s*.*(post-?mortem|incident\s*review|root\s*cause)/i.test(content) ||
    /root\s+cause\s+analysis/i.test(content)
  ) {
    return 'post-mortems'
  }

  if (
    /#\s*.*(code\s*review|security\s*audit|peer\s*review|audit\s*report)/i.test(
      content
    ) ||
    /\b(security\s*audit|code\s*review)\b/i.test(content)
  ) {
    return 'reviews'
  }

  if (
    /\bscenario:\s+/i.test(content) ||
    (/\bgiven\s+/i.test(content) &&
      /\bwhen\s+/i.test(content) &&
      /\bthen\s+/i.test(content)) ||
    /#\s*.*(spec|specification|acceptance\s*criteria|bdd)/i.test(content)
  ) {
    return 'specs'
  }

  if (
    /#\s*.*(plan|roadmap|implementation|fase|matriz\s+de\s+despacho)/i.test(
      content
    ) ||
    /\b(dispatch\s*matrix|matriz\s*de\s*despacho)\b/i.test(content)
  ) {
    return 'plans'
  }

  // 3. Diagram dominance heuristic: contains mermaid blocks and little else
  const mermaidBlocks = extractMermaidBlocks(content)
  if (mermaidBlocks.length > 0) {
    const stripped = content
      .replace(/```mermaid[^\n\r]*[\r\n]+([\s\S]*?)```/gi, '')
      .replace(/#+\s+.*[\r\n]+/g, '')
      .trim()
    // If stripped text has minimal remaining prose, consider it a diagram artifact
    if (stripped.length < 120) {
      return 'diagrams'
    }
    return 'plans'
  }

  // Default fallback
  return 'plans'
}

/**
 * Maps an artifact segment to the most appropriate Memoseb category.
 */
export function defaultCategoryForSegment(
  segment: ArtifactSegment
): MemosebCategory {
  switch (segment) {
    case 'plans':
      return 'architecture'
    case 'diagrams':
      return 'architecture'
    case 'specs':
      return 'domain'
    case 'reviews':
      return 'convention'
    case 'post-mortems':
      return 'bugfix'
  }
}

/**
 * Sanitizes a title for use in file paths.
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'artifact'
}

/**
 * Detects whether a terminal stream chunk or file corresponds to an implementation plan
 * or structured document with Mermaid diagrams.
 */
export function detectPlanInStream(
  sessionId: string,
  projectSlug: string,
  rawText: string,
  filePath?: string
): DetectedArtifact | null {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return null
  }

  const mermaidBlocks = extractMermaidBlocks(rawText)

  // Must have mermaid blocks OR strong markdown plan/spec/review/postmortem structure
  const hasHeading1 = /^#\s+(.+)$/m.test(rawText)
  const hasPlanKeywords =
    /\b(plan|implementation|dispatch\s*matrix|matriz\s*de\s*despacho|scenario:|code\s*review|security\s*audit|post-?mortem)\b/i.test(
      rawText
    )
  const isTargetFile =
    Boolean(filePath) &&
    /\.(md|markdown|mmd)$/i.test(filePath!) &&
    (hasHeading1 || mermaidBlocks.length > 0)

  const qualifies = mermaidBlocks.length > 0 || (hasHeading1 && hasPlanKeywords) || isTargetFile

  if (!qualifies) {
    return null
  }

  // Extract title from first markdown heading 1, heading 2, or file path
  let title = ''
  const h1Match = rawText.match(/^#\s+(.+)$/m)
  if (h1Match?.[1]) {
    title = h1Match[1].trim()
  } else {
    const h2Match = rawText.match(/^##\s+(.+)$/m)
    if (h2Match?.[1]) {
      title = h2Match[1].trim()
    } else if (filePath) {
      const base = path.basename(filePath, path.extname(filePath))
      title = base.replace(/[-_]/g, ' ')
    } else {
      title = 'Detected Artifact'
    }
  }

  const segment = classifyArtifactSegment(filePath ?? '', rawText)
  const slug = slugifyTitle(title)
  const derivedPath =
    filePath ?? path.join(projectSlug, segment, `${slug}.md`)

  return {
    id: randomUUID(),
    sessionId,
    projectSlug,
    segment,
    title,
    filePath: derivedPath,
    content: rawText,
    mermaidBlocks,
    detectedAt: new Date().toISOString(),
    syncedToMemoseb: false,
    memosebCategory: defaultCategoryForSegment(segment),
  }
}
