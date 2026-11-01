import React, { useState, useEffect } from 'react'
import {
  ArtifactSegment,
  ARTIFACT_SEGMENTS,
  DetectedArtifact,
  MemosebCategory,
  MEMOSEB_CATEGORIES,
} from '../../types/deck'
import { deckClient } from '../../services/deckClient'

interface PlanDrawerProps {
  isOpen: boolean
  onClose: () => void
  autoOpenOnPlan: boolean
  onToggleAutoOpen: () => void
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

  // Simple parser for statements like: A["Label"] --> B["Label B"] or A --> B
  const linkRegex = /([a-zA-Z0-9_\-]+)(?:\["([^"]+)"\])?\s*(-->|---|-.->)\s*(?:\|([^|]+)\|)?\s*([a-zA-Z0-9_\-]+)(?:\["([^"]+)"\])?/g

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    let m: RegExpExecArray | null
    linkRegex.lastIndex = 0
    while ((m = linkRegex.exec(line)) !== null) {
      const fromId = m[1]
      const fromLabel = m[2] || m[1]
      const toId = m[5]
      const toLabel = m[6] || m[5]
      const edgeLabel = m[4]

      nodesMap.set(fromId, fromLabel)
      nodesMap.set(toId, toLabel)
      edges.push({ from: fromId, to: toId, label: edgeLabel })
    }
  }

  if (nodesMap.size === 0) {
    return (
      <pre style={{ margin: 0, fontSize: '11px', color: 'var(--mac-text-secondary)' }}>
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
        padding: '12px',
        overflowX: 'auto',
      }}
    >
      {uniqueNodes.map(([id, label], idx) => (
        <React.Fragment key={id}>
          <div
            className="diagram-node"
            style={{
              borderColor: idx === 0 ? 'var(--mac-accent)' : 'var(--mac-border)',
              background: idx === 0 ? 'var(--mac-accent-subtle)' : 'var(--mac-bg-card)',
            }}
          >
            <div style={{ fontSize: '10px', color: 'var(--mac-text-muted)' }}>{id}</div>
            <div>{label}</div>
          </div>
          {idx < uniqueNodes.length - 1 && (
            <div className="diagram-arrow" style={{ transform: isHorizontal ? 'rotate(-90deg)' : 'none' }}>
              <span>↓</span>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

export const PlanDrawer: React.FC<PlanDrawerProps> = ({
  isOpen,
  onClose,
  autoOpenOnPlan,
  onToggleAutoOpen,
}) => {
  const [artifacts, setArtifacts] = useState<DetectedArtifact[]>([])
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [selectedSegment, setSelectedSegment] = useState<ArtifactSegment | 'all'>('all')
  const [selectedCategory, setSelectedCategory] = useState<MemosebCategory>('architecture')
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [viewRawMermaid, setViewRawMermaid] = useState<boolean>(false)

  // Load artifacts
  const refreshArtifacts = () => {
    deckClient.listArtifacts().then((list) => {
      setArtifacts(list)
      if (list.length > 0 && !selectedArtifactId) {
        setSelectedArtifactId(list[0].id)
      }
    })
  }

  useEffect(() => {
    refreshArtifacts()

    // Listen for new detected artifacts
    const unsub = deckClient.on('deck:artifact-detected', (art) => {
      setArtifacts((prev) => [art, ...prev.filter((a) => a.id !== art.id)])
      setSelectedArtifactId(art.id)
      if (art.memosebCategory) {
        setSelectedCategory(art.memosebCategory)
      }
    })

    return unsub
  }, [])

  const filteredArtifacts = artifacts.filter(
    (a) => selectedSegment === 'all' || a.segment === selectedSegment
  )

  const activeArtifact =
    artifacts.find((a) => a.id === selectedArtifactId) ||
    (filteredArtifacts.length > 0 ? filteredArtifacts[0] : null)

  const handleSyncToMemoseb = async () => {
    if (!activeArtifact) return
    setSyncStatus('Sincronizando con vault.db...')
    const res = await deckClient.syncArtifactToMemoseb(
      activeArtifact.id,
      selectedCategory,
      activeArtifact.title
    )
    if (res.success) {
      setSyncStatus(`✔ Sincronizado en memoseb (ID: ${res.memoryId})`)
      refreshArtifacts()
    } else {
      setSyncStatus(`Error: ${res.error}`)
    }
    setTimeout(() => setSyncStatus(null), 4000)
  }

  return (
    <div className={`mac-drawer ${!isOpen ? 'collapsed' : ''}`}>
      {/* Drawer Header */}
      <div className="mac-drawer-header">
        <div className="mac-drawer-title">
          <span>📋 Planes & Diagramas</span>
          <span className="badge-segment">{activeArtifact?.segment || 'plans'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            className={`mac-segment-btn ${autoOpenOnPlan ? 'active' : ''}`}
            onClick={onToggleAutoOpen}
            title="Auto-abrir drawer al detectar planes nuevos o diagramas Mermaid"
            style={{ fontSize: '11px', padding: '2px 8px' }}
          >
            Auto-open {autoOpenOnPlan ? 'ON' : 'OFF'}
          </button>
          <button className="mac-icon-btn" onClick={onClose} title="Cerrar panel lateral">
            ✕
          </button>
        </div>
      </div>

      {/* Segment Tabs */}
      <div style={{ padding: '8px 16px 0 16px' }}>
        <div className="plan-segment-tabs">
          <button
            className={`plan-segment-tab ${selectedSegment === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedSegment('all')}
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
              >
                {seg}/ ({count})
              </button>
            )
          })}
        </div>
      </div>

      {/* Artifacts List or Dropdown */}
      {filteredArtifacts.length > 1 && (
        <div style={{ padding: '8px 16px 0 16px' }}>
          <select
            className="mac-select"
            style={{ width: '100%' }}
            value={activeArtifact?.id || ''}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedArtifactId(e.target.value)}
          >
            {filteredArtifacts.map((art) => (
              <option key={art.id} value={art.id}>
                [{art.segment}] {art.title} {art.syncedToMemoseb ? '✔ memoseb' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Drawer Content */}
      <div className="mac-drawer-content">
        {activeArtifact ? (
          <div className="artifact-card">
            {/* Header info */}
            <div className="artifact-header">
              <div>
                <div className="artifact-title">{activeArtifact.title}</div>
                <div className="artifact-meta" style={{ marginTop: '4px' }}>
                  <span>📁 {activeArtifact.filePath}</span>
                  <span>•</span>
                  <span>{new Date(activeArtifact.detectedAt).toLocaleTimeString()}</span>
                </div>
              </div>
              <div>
                {activeArtifact.syncedToMemoseb ? (
                  <span
                    style={{
                      padding: '3px 8px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--mac-color-healthy-subtle)',
                      color: 'var(--mac-color-healthy)',
                      border: '1px solid var(--mac-color-healthy)',
                    }}
                  >
                    ✔ Memoseb
                  </span>
                ) : (
                  <span
                    style={{
                      padding: '3px 8px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--mac-bg-chip)',
                      color: 'var(--mac-text-muted)',
                    }}
                  >
                    Pendiente
                  </span>
                )}
              </div>
            </div>

            {/* Markdown Body */}
            <div
              style={{
                fontSize: '12px',
                lineHeight: 1.6,
                color: 'var(--mac-text-secondary)',
                whiteSpace: 'pre-wrap',
                background: 'var(--mac-bg-input)',
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid var(--mac-border-subtle)',
                maxHeight: '220px',
                overflowY: 'auto',
              }}
            >
              {activeArtifact.content}
            </div>

            {/* Mermaid Diagram Blocks */}
            {activeArtifact.mermaidBlocks && activeArtifact.mermaidBlocks.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-primary)' }}>
                    📊 Diagrama Mermaid Detectado
                  </span>
                  <button
                    className="mac-segment-btn"
                    style={{ fontSize: '10px', padding: '2px 6px' }}
                    onClick={() => setViewRawMermaid(!viewRawMermaid)}
                  >
                    {viewRawMermaid ? 'Ver Gráfico' : 'Ver Código Raw'}
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
                      }}
                    >
                      {activeArtifact.mermaidBlocks.join('\n\n')}
                    </pre>
                  ) : (
                    activeArtifact.mermaidBlocks.map((blk, idx) => (
                      <div key={idx}>{renderMermaidVisual(blk)}</div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Memoseb Sync Controls */}
            <div
              style={{
                marginTop: '8px',
                paddingTop: '12px',
                borderTop: '1px solid var(--mac-border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-primary)' }}>
                Sincronización con memoseb
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: 'var(--mac-text-secondary)' }}>Categoría:</label>
                <select
                  className="mac-select"
                  style={{ flex: 1 }}
                  value={selectedCategory}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedCategory(e.target.value as MemosebCategory)}
                >
                  {MEMOSEB_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
                <button className="mac-primary-btn" onClick={handleSyncToMemoseb}>
                  <span>📥</span>
                  <span>Enviar a memoseb</span>
                </button>
              </div>

              {syncStatus && (
                <div
                  style={{
                    fontSize: '11px',
                    color: syncStatus.startsWith('Error')
                      ? 'var(--mac-color-critical)'
                      : 'var(--mac-color-healthy)',
                    fontWeight: 500,
                  }}
                >
                  {syncStatus}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div
            style={{
              textAlign: 'center',
              padding: '40px 20px',
              color: 'var(--mac-text-muted)',
            }}
          >
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>📑</div>
            <div>No hay artefactos en este segmento.</div>
            <div style={{ fontSize: '11px', marginTop: '4px' }}>
              Escribe <code style={{ color: 'var(--mac-accent)' }}>/plan</code> en la terminal para
              generar uno nuevo.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
