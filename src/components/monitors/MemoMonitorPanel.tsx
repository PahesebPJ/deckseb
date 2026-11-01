import React, { useState, useEffect } from 'react'
import {
  ArtifactSegment,
  ARTIFACT_SEGMENTS,
  MemoActivityEvent,
  VaultStats,
} from '../../types/deck'
import { deckClient } from '../../services/deckClient'

interface MemoMonitorPanelProps {
  onClose?: () => void
}

export const MemoMonitorPanel: React.FC<MemoMonitorPanelProps> = ({ onClose }) => {
  const [vaultStats, setVaultStats] = useState<VaultStats>({
    projectCount: 4,
    memoryCount: 42,
    totalTokens: 38400,
  })
  const [events, setEvents] = useState<MemoActivityEvent[]>([])
  const [activeSegmentFilter, setActiveSegmentFilter] = useState<string>('all')

  const loadData = () => {
    deckClient.getEcosystemSnapshot().then((snap) => {
      setVaultStats(snap.vaultStats)
    })
    deckClient.listMemoEvents().then((evs) => {
      setEvents(evs)
    })
  }

  useEffect(() => {
    loadData()

    const unsub = deckClient.on('deck:memo-event', (ev) => {
      setEvents((prev) => [ev, ...prev.filter((e) => e.id !== ev.id)])
      setVaultStats((prev) => ({
        ...prev,
        memoryCount: ev.action === 'remember' ? prev.memoryCount + 1 : prev.memoryCount,
        totalTokens: prev.totalTokens + ev.tokenCount,
      }))
    })

    return unsub
  }, [])

  const getActionBadgeClass = (action: string) => {
    switch (action) {
      case 'context':
        return 'memo-action-context'
      case 'recall':
        return 'memo-action-recall'
      case 'remember':
        return 'memo-action-remember'
      case 'analyze':
        return 'memo-action-analyze'
      default:
        return ''
    }
  }

  return (
    <div className="mac-drawer">
      {/* Header */}
      <div className="mac-drawer-header">
        <div className="mac-drawer-title">
          <span>🧠 memoseb Vault Monitor</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button className="mac-icon-btn" onClick={loadData} title="Refrescar bóveda">
            ↻
          </button>
          {onClose && (
            <button className="mac-icon-btn" onClick={onClose} title="Cerrar monitor">
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="mac-drawer-content">
        {/* Vault Stats 3-Grid */}
        <div className="vault-stats-grid">
          <div className="vault-stat-box">
            <div className="vault-stat-value">{vaultStats.projectCount}</div>
            <div className="vault-stat-label">Proyectos</div>
          </div>
          <div className="vault-stat-box">
            <div className="vault-stat-value">{vaultStats.memoryCount}</div>
            <div className="vault-stat-label">Recuerdos</div>
          </div>
          <div className="vault-stat-box">
            <div className="vault-stat-value">
              {(vaultStats.totalTokens / 1000).toFixed(1)}k
            </div>
            <div className="vault-stat-label">Tokens Vault</div>
          </div>
        </div>

        {/* DB Location info */}
        <div
          style={{
            fontSize: '11px',
            color: 'var(--mac-text-muted)',
            background: 'var(--mac-bg-card)',
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid var(--mac-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>📦 Bóveda FTS5 + Vectorial:</span>
          <code style={{ color: 'var(--mac-accent)', fontSize: '10px' }}>~/.config/hubseb/memoseb/vault.db</code>
        </div>

        {/* Segmented Folders Sync Status */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-primary)' }}>
            Estado de Carpetas Segmentadas
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '6px',
              fontSize: '11px',
            }}
          >
            {ARTIFACT_SEGMENTS.map((seg) => (
              <div
                key={seg}
                style={{
                  background: 'var(--mac-bg-card)',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--mac-border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ fontWeight: 500 }}>{seg}/</span>
                <span style={{ color: 'var(--mac-color-healthy)', fontSize: '10px' }}>✔ sincronizado</span>
              </div>
            ))}
          </div>
        </div>

        {/* Live Operations Feed */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mac-text-primary)' }}>
              Feed de Actividad en Vivo ({events.length})
            </span>
            <span style={{ fontSize: '10px', color: 'var(--mac-text-muted)' }}>Eventos recientes</span>
          </div>

          <div className="memo-events-feed">
            {events.map((ev) => (
              <div key={ev.id} className="memo-event-item">
                <span className={`memo-action-badge ${getActionBadgeClass(ev.action)}`}>
                  {ev.action}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: 'var(--mac-text-primary)', wordBreak: 'break-word' }}>
                    {ev.summary}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '10px',
                      color: 'var(--mac-text-muted)',
                      marginTop: '3px',
                    }}
                  >
                    <span>📁 {ev.projectId}</span>
                    <span>•</span>
                    <span>{ev.tokenCount} tokens</span>
                    <span>•</span>
                    <span>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
