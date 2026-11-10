import React, { useState, useEffect } from 'react'
import {
  ArtifactSegment,
  ARTIFACT_SEGMENTS,
  DetectedArtifact,
  MemosebCategory,
  MEMOSEB_CATEGORIES,
} from '../../types/deck'
import { deckClient } from '../../services/deckClient'

export interface PlanDrawerProps {
  onActivePlanChange?: (plan: DetectedArtifact | null) => void
  isOpen?: boolean
  onClose?: () => void
}

/**
 * Parses mermaid diagram lines into simple nodes and connections for visual rendering
 */
function renderMermaidVisual(mermaidCode: string): React.ReactNode {
  const lines = mermaidCode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'))

  const diagramType = lines[0] || 'diagram'
  const isHorizontal = diagramType.includes('LR')

  interface ParsedEdge {
    from: string
    to: string
    label?: string
  }

  const nodesMap = new Map<string, string>()
  const edges: ParsedEdge[] = []

  const linkRegex =
    /([a-zA-Z0-9_\-]+)(?:\["([^"]+)"\])?\s*(-->|---|-.->)\s*(?:\|([^|]+)\|)?\s*([a-zA-Z0-9_\-]+)(?:\["([^"]+)"\])?/g

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    let m: RegExpExecArray | null
    linkRegex.lastIndex = 0
    while ((m = linkRegex.exec(line)) !== null) {
      const fromId = m[1] ?? ''
      const fromLabel = m[2] || fromId
      const toId = m[5] ?? ''
      const toLabel = m[6] || toId
      const edgeLabel = m[4]

      if (fromId && toId) {
        nodesMap.set(fromId, fromLabel)
        nodesMap.set(toId, toLabel)
        edges.push({ from: fromId, to: toId, label: edgeLabel })
      }
    }
  }

  if (nodesMap.size === 0) {
    return (
      <pre
        style={{
          margin: 0,
          fontSize: '11px',
          color: 'var(--mac-text-secondary)',
          fontFamily: 'var(--mac-font-mono)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {mermaidCode}
      </pre>
    )
  }

  const uniqueNodes = Array.from(nodesMap.entries())

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        alignItems: 'center',
        gap: '12px',
        padding: '16px',
        overflowX: 'auto',
        background: 'var(--mac-bg-input)',
        borderRadius: '8px',
        border: '1px solid var(--mac-border-subtle)',
      }}
    >
      {uniqueNodes.map(([id, label], idx) => (
        <React.Fragment key={id}>
          <div
            className="diagram-node"
            style={{
              borderColor: idx === 0 ? 'var(--mac-accent)' : 'var(--mac-border)',
              background: idx === 0 ? 'var(--mac-accent-subtle)' : 'var(--mac-bg-card)',
              padding: '8px 14px',
              borderRadius: '8px',
              minWidth: '120px',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: '10px',
                color: 'var(--mac-text-muted)',
                fontFamily: 'var(--mac-font-mono)',
              }}
            >
              {id}
            </div>
            <div
              style={{
                fontWeight: 600,
                fontSize: '12px',
                color: 'var(--mac-text-primary)',
                marginTop: '2px',
              }}
            >
              {label}
            </div>
          </div>
          {idx < uniqueNodes.length - 1 && (
            <div
              className="diagram-arrow"
              style={{
                transform: isHorizontal ? 'rotate(-90deg)' : 'none',
                color: 'var(--mac-accent)',
                fontSize: '16px',
              }}
            >
              <span>↓</span>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          style={{
            fontFamily: 'var(--mac-font-mono)',
            fontSize: '11.5px',
            background: 'var(--mac-bg-chip)',
            padding: '2px 5px',
            borderRadius: '4px',
            color: 'var(--mac-accent)',
          }}
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} style={{ color: 'var(--mac-text-primary)' }}>
          {part.slice(2, -2)}
        </strong>
      )
    }
    return part
  })
}

function renderMarkdownBody(content: string): React.ReactNode {
  const lines = content.split('\n')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {lines.map((line, idx) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('# ')) {
          return (
            <h1
              key={idx}
              style={{
                fontSize: '20px',
                fontWeight: 700,
                margin: '12px 0 6px 0',
                color: 'var(--mac-text-primary)',
              }}
            >
              {trimmed.replace(/^#\s*/, '')}
            </h1>
          )
        }
        if (trimmed.startsWith('## ')) {
          return (
            <h2
              key={idx}
              style={{
                fontSize: '16px',
                fontWeight: 700,
                margin: '10px 0 4px 0',
                color: 'var(--mac-text-primary)',
              }}
            >
              {trimmed.replace(/^##\s*/, '')}
            </h2>
          )
        }
        if (trimmed.startsWith('### ')) {
          return (
            <h3
              key={idx}
              style={{
                fontSize: '14px',
                fontWeight: 600,
                margin: '8px 0 4px 0',
                color: 'var(--mac-accent)',
              }}
            >
              {trimmed.replace(/^###\s*/, '')}
            </h3>
          )
        }
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return (
            <div
              key={idx}
              style={{
                display: 'flex',
                gap: '8px',
                paddingLeft: '8px',
                color: 'var(--mac-text-secondary)',
                fontSize: '13px',
                lineHeight: 1.6,
              }}
            >
              <span style={{ color: 'var(--mac-accent)' }}>•</span>
              <div>{renderInlineMarkdown(trimmed.replace(/^[-*]\s*/, ''))}</div>
            </div>
          )
        }
        if (/^\d+\.\s/.test(trimmed)) {
          const num = trimmed.match(/^(\d+)\.\s/)?.[1]
          return (
            <div
              key={idx}
              style={{
                display: 'flex',
                gap: '8px',
                paddingLeft: '8px',
                color: 'var(--mac-text-secondary)',
                fontSize: '13px',
                lineHeight: 1.6,
              }}
            >
              <span style={{ color: 'var(--mac-accent)', fontWeight: 600 }}>{num}.</span>
              <div>{renderInlineMarkdown(trimmed.replace(/^\d+\.\s*/, ''))}</div>
            </div>
          )
        }
        if (trimmed === '') {
          return <div key={idx} style={{ height: '6px' }} />
        }
        // Skip raw mermaid block in text since rendered below
        if (trimmed.startsWith('```mermaid') || trimmed === '```') {
          return null
        }
        return (
          <p
            key={idx}
            style={{
              margin: 0,
              fontSize: '13px',
              lineHeight: 1.65,
              color: 'var(--mac-text-secondary)',
            }}
          >
            {renderInlineMarkdown(trimmed)}
          </p>
        )
      })}
    </div>
  )
}

export const PlanDrawer: React.FC<PlanDrawerProps> = ({ onActivePlanChange }) => {
  const [artifacts, setArtifacts] = useState<DetectedArtifact[]>([])
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [selectedSegment, setSelectedSegment] = useState<ArtifactSegment | 'all'>('all')
  const [selectedCategory, setSelectedCategory] = useState<MemosebCategory>('architecture')
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [viewRawMermaid, setViewRawMermaid] = useState<boolean>(false)
  const [searchQuery, setSearchQuery] = useState<string>('')

  const refreshArtifacts = () => {
    deckClient.listArtifacts().then((list) => {
      const sorted = [...list].sort(
        (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
      )
      setArtifacts(sorted)
      if (sorted[0] && !selectedArtifactId) {
        setSelectedArtifactId(sorted[0].id)
      }
    })
  }

  useEffect(() => {
    refreshArtifacts()

    // Listen for new detected artifacts
    const unsub = deckClient.on('deck:artifact-detected', (art) => {
      setArtifacts((prev) => [art, ...prev.filter((a) => a.id !== art.id && a.filePath !== art.filePath)])
      setSelectedArtifactId(art.id)
      if (art.memosebCategory) {
        setSelectedCategory(art.memosebCategory)
      }
      onActivePlanChange?.(art)
    })

    return unsub
  }, [])

  const filteredArtifacts = artifacts.filter((a) => {
    const matchesSegment = selectedSegment === 'all' || a.segment === selectedSegment
    if (!matchesSegment) return false

    if (!searchQuery.trim()) return true

    const query = searchQuery.toLowerCase().trim()
    const matchesTitle = a.title ? a.title.toLowerCase().includes(query) : false
    const matchesPath = a.filePath ? a.filePath.toLowerCase().includes(query) : false
    const matchesSegmentName = a.segment ? a.segment.toLowerCase().includes(query) : false
    const matchesContent = a.content ? a.content.toLowerCase().includes(query) : false

    return matchesTitle || matchesPath || matchesSegmentName || matchesContent
  })

  const activeArtifact =
    artifacts.find((a) => a.id === selectedArtifactId) ||
    (filteredArtifacts.length > 0 ? filteredArtifacts[0] : null)

  useEffect(() => {
    if (activeArtifact) {
      onActivePlanChange?.(activeArtifact)
    }
  }, [activeArtifact?.id])

  const handleSyncToMemoseb = async () => {
    if (!activeArtifact) return
    setSyncStatus('Sincronizando con vault.sqlite...')
    const res = await deckClient.syncArtifactToMemoseb(
      activeArtifact.id,
      selectedCategory,
      activeArtifact.title
    )
    if (res.success) {
      setSyncStatus(`✔ Sincronizado en memoseb (ID: ${res.memoryId || 'mem-saved'})`)
      activeArtifact.syncedToMemoseb = true
      activeArtifact.memosebCategory = selectedCategory
      setArtifacts([...artifacts])
    } else {
      setSyncStatus(`Error: ${res.error || 'falló la sincronización'}`)
    }
    setTimeout(() => setSyncStatus(null), 4000)
  }

  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--bento-bg-root)',
      }}
    >
      {/* Left Sidebar: Recent Plans Selector & Segment Filters */}
      <aside
        style={{
          width: '320px',
          minWidth: '320px',
          borderRight: '1px solid var(--bento-border)',
          background: 'var(--bento-surface)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Sidebar Header */}
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--bento-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px' }}>📑</span>
            <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--mac-text-primary)' }}>
              Artefactos Detectados
            </span>
          </div>
          <span
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '999px',
              background: 'var(--mac-bg-chip)',
              color: 'var(--mac-text-secondary)',
              fontWeight: 600,
            }}
          >
            {artifacts.length}
          </span>
        </div>

        {/* Search Input macOS Sequoia Minimal */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--mac-border-subtle)' }}>
          <input
            type="search"
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            placeholder="Buscar planes por título, ruta o contenido…"
            aria-label="Buscar planes"
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: '12px',
              borderRadius: '6px',
              border: '1px solid var(--bento-border)',
              background: 'var(--mac-bg-input)',
              color: 'var(--mac-text-primary)',
              outline: 'none',
            }}
          />
        </div>

        {/* Segment Filter Tabs */}
        <div
          style={{
            padding: '10px 12px 6px 12px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            borderBottom: '1px solid var(--mac-border-subtle)',
          }}
        >
          <button
            className={`plan-segment-tab ${selectedSegment === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedSegment('all')}
            style={{ fontSize: '11px', padding: '3px 8px' }}
          >
            Todos ({artifacts.length})
          </button>
          {ARTIFACT_SEGMENTS.map((seg) => {
            const count = artifacts.filter((a) => a.segment === seg).length
            return (
              <button
                key={seg}
                className={`plan-segment-tab ${selectedSegment === seg ? 'active' : ''}`}
                onClick={() => setSelectedSegment(seg)}
                style={{ fontSize: '11px', padding: '3px 8px' }}
              >
                {seg}/ ({count})
              </button>
            )
          })}
        </div>

        {/* List of Plans */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {filteredArtifacts.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '30px 10px',
                color: 'var(--mac-text-muted)',
                fontSize: '12px',
              }}
            >
              {searchQuery.trim()
                ? 'No se encontraron planes con esa búsqueda.'
                : 'No hay planes en este segmento.'}
            </div>
          ) : (
            filteredArtifacts.map((art, index) => {
              const isSelected = activeArtifact?.id === art.id
              const isLatest = index === 0
              return (
                <div
                  key={art.id}
                  onClick={() => setSelectedArtifactId(art.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--bento-header-bg)' : 'var(--bento-surface-subtle)',
                    border: isSelected
                      ? '1px solid var(--bento-accent-cyan)'
                      : '1px solid var(--bento-border)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: '4px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          color: 'var(--mac-accent)',
                          letterSpacing: '0.4px',
                        }}
                      >
                        {art.segment}
                      </span>
                      {isLatest && (
                        <span
                          style={{
                            fontSize: '9.5px',
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: 'var(--mac-accent-subtle)',
                            color: 'var(--mac-accent)',
                            letterSpacing: '0.3px',
                            textTransform: 'uppercase',
                          }}
                        >
                          Último
                        </span>
                      )}
                    </div>
                    {art.syncedToMemoseb && (
                      <span
                        style={{
                          fontSize: '10px',
                          color: 'var(--mac-color-healthy)',
                          fontWeight: 600,
                        }}
                      >
                        ✔ memoseb
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: '12.5px',
                      fontWeight: 600,
                      color: isSelected ? 'var(--mac-text-primary)' : 'var(--mac-text-secondary)',
                      lineHeight: 1.35,
                      marginBottom: '6px',
                    }}
                  >
                    {art.title}
                  </div>
                  <div
                    style={{
                      fontSize: '10.5px',
                      color: 'var(--mac-text-muted)',
                      fontFamily: 'var(--mac-font-mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {art.filePath}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* Right Column: Editorial Plan Reading Pane */}
      <section
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--mac-bg-window)',
        }}
      >
        {activeArtifact ? (
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '24px 36px',
              maxWidth: '920px',
              margin: '0 auto',
              width: '100%',
              boxSizing: 'border-box',
            }}
          >
            {/* Editorial Document Header */}
            <div
              style={{
                borderBottom: '1px solid var(--mac-border-subtle)',
                paddingBottom: '16px',
                marginBottom: '20px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '8px',
                }}
              >
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: 'var(--mac-accent)',
                    background: 'var(--mac-accent-subtle)',
                    padding: '2px 8px',
                    borderRadius: '4px',
                  }}
                >
                  {activeArtifact.segment}
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--mac-font-mono)',
                    color: 'var(--mac-text-muted)',
                  }}
                >
                  {activeArtifact.filePath}
                </span>
                <span style={{ color: 'var(--mac-text-muted)' }}>•</span>
                <span style={{ fontSize: '11px', color: 'var(--mac-text-muted)' }}>
                  {new Date(activeArtifact.detectedAt).toLocaleTimeString()}
                </span>
              </div>

              <h1
                style={{
                  fontSize: '24px',
                  fontWeight: 700,
                  margin: '4px 0 14px 0',
                  color: 'var(--mac-text-primary)',
                  lineHeight: 1.3,
                }}
              >
                {activeArtifact.title}
              </h1>

              {/* Memoseb Sync Toolbar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  background: 'var(--bento-surface-subtle)',
                  padding: '8px 14px',
                  borderRadius: '8px',
                  border: '1px solid var(--bento-border)',
                }}
              >
                <span
                  style={{
                    fontSize: '11.5px',
                    fontWeight: 600,
                    color: 'var(--mac-text-secondary)',
                  }}
                >
                  Sincronización memoseb:
                </span>
                <select
                  className="mac-select"
                  value={selectedCategory}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setSelectedCategory(e.target.value as MemosebCategory)
                  }
                  style={{ fontSize: '11.5px', padding: '3px 8px' }}
                >
                  {MEMOSEB_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
                <button
                  className="mac-primary-btn"
                  onClick={handleSyncToMemoseb}
                  style={{ fontSize: '11px', padding: '4px 10px' }}
                >
                  <span>📥</span>
                  <span>{activeArtifact.syncedToMemoseb ? 'Re-sincronizar' : 'Enviar a memoseb'}</span>
                </button>
                {syncStatus && (
                  <span
                    style={{
                      fontSize: '11px',
                      color: syncStatus.startsWith('Error')
                        ? 'var(--mac-color-critical)'
                        : 'var(--mac-color-healthy)',
                      fontWeight: 500,
                    }}
                  >
                    {syncStatus}
                  </span>
                )}
              </div>
            </div>

            {/* Markdown Body Content */}
            <div
              style={{
                marginBottom: '28px',
                background: 'var(--bento-surface-card)',
                padding: '20px 24px',
                borderRadius: '12px',
                border: '1px solid var(--bento-border)',
              }}
            >
              {renderMarkdownBody(activeArtifact.content)}
            </div>

            {/* Mermaid Diagrams Section */}
            {activeArtifact.mermaidBlocks && activeArtifact.mermaidBlocks.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  marginBottom: '32px',
                  background: 'var(--bento-surface-card)',
                  padding: '20px 24px',
                  borderRadius: '12px',
                  border: '1px solid var(--bento-border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '15px' }}>📊</span>
                    <span
                      style={{
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--mac-text-primary)',
                      }}
                    >
                      Diagrama Arquitectónico Mermaid ({activeArtifact.mermaidBlocks.length})
                    </span>
                  </div>
                  <button
                    className="mac-segment-btn"
                    style={{ fontSize: '11px', padding: '3px 10px' }}
                    onClick={() => setViewRawMermaid(!viewRawMermaid)}
                  >
                    {viewRawMermaid ? 'Ver Gráfico Visual' : 'Ver Código Raw'}
                  </button>
                </div>

                <div className="mermaid-container">
                  {viewRawMermaid ? (
                    <pre
                      style={{
                        margin: 0,
                        fontFamily: 'var(--mac-font-mono)',
                        fontSize: '11px',
                        color: 'var(--mac-text-primary)',
                        background: 'var(--mac-bg-input)',
                        padding: '14px',
                        borderRadius: '8px',
                        border: '1px solid var(--mac-border-subtle)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {activeArtifact.mermaidBlocks.join('\n\n')}
                    </pre>
                  ) : (
                    activeArtifact.mermaidBlocks.map((blk, idx) => (
                      <div key={idx} style={{ marginBottom: idx > 0 ? '12px' : '0' }}>
                        {renderMermaidVisual(blk)}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--mac-text-muted)',
            }}
          >
            <div style={{ fontSize: '32px', marginBottom: '10px' }}>📑</div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--mac-text-secondary)' }}>
              Sin planes seleccionados
            </div>
            <div style={{ fontSize: '12px', marginTop: '6px' }}>
              Pulsa <code style={{ color: 'var(--mac-accent)' }}>⚡ Simular Plan</code> en la barra superior para generar uno de prueba.
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
