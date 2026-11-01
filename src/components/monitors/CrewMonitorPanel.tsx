import React, { useState, useEffect } from 'react'
import {
  ConcurrencyMode,
  CrewRole,
  CrewSubagentActivity,
  SebEcosystemSnapshot,
} from '../../types/deck'
import { deckClient } from '../../services/deckClient'

interface CrewMonitorPanelProps {
  onClose?: () => void
}

export const CrewMonitorPanel: React.FC<CrewMonitorPanelProps> = ({ onClose }) => {
  const [snapshot, setSnapshot] = useState<SebEcosystemSnapshot | null>(null)
  const [filterRole, setFilterRole] = useState<string>('all')

  const refreshSnapshot = () => {
    deckClient.getEcosystemSnapshot().then((snap) => {
      setSnapshot(snap)
    })
  }

  useEffect(() => {
    refreshSnapshot()

    const unsubSub = deckClient.on('deck:subagent-updated', () => {
      refreshSnapshot()
    })
    const unsubEco = deckClient.on('deck:ecosystem-updated', (snap) => {
      setSnapshot(snap)
    })

    return () => {
      unsubSub()
      unsubEco()
    }
  }, [])

  const subagents = snapshot?.activeSubagents || []
  const filteredSubagents = subagents.filter(
    (sa) => filterRole === 'all' || sa.role === filterRole
  )

  const workingCount = subagents.filter((s) => s.status === 'working').length
  const completedCount = subagents.filter((s) => s.status === 'completed').length

  const getTierClass = (tier: string) => {
    switch (tier) {
      case 'deep':
        return 'tier-deep'
      case 'balanced':
        return 'tier-balanced'
      case 'fast':
        return 'tier-fast'
      default:
        return ''
    }
  }

  return (
    <div className="mac-drawer">
      {/* Header */}
      <div className="mac-drawer-header">
        <div className="mac-drawer-title">
          <span>👥 crewseb Monitor</span>
          <span
            style={{
              fontSize: '10px',
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'var(--mac-accent-subtle)',
              color: 'var(--mac-accent)',
              fontWeight: 600,
            }}
          >
            {snapshot?.preset || 'cloud-tiered'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button className="mac-icon-btn" onClick={refreshSnapshot} title="Refrescar telemetría">
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
        {/* Status bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--mac-bg-card)',
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid var(--mac-border)',
          }}
        >
          <div>
            <div style={{ fontSize: '11px', color: 'var(--mac-text-muted)' }}>Modo Concurrencia</div>
            <div style={{ fontSize: '13px', fontWeight: 600, textTransform: 'capitalize' }}>
              {snapshot?.concurrencyMode || 'parallel'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--mac-text-muted)' }}>Max Local Parallel</div>
            <div style={{ fontSize: '13px', fontWeight: 600 }}>
              {snapshot?.maxLocalParallel || 4}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--mac-text-muted)' }}>Subagentes</div>
            <div style={{ fontSize: '13px', fontWeight: 600 }}>
              <span style={{ color: 'var(--mac-accent)' }}>{workingCount} activos</span> / {completedCount} ok
            </div>
          </div>
        </div>

        {/* Roles Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
          <button
            className={`plan-segment-tab ${filterRole === 'all' ? 'active' : ''}`}
            onClick={() => setFilterRole('all')}
          >
            Todos ({subagents.length})
          </button>
          {['developer', 'architect', 'researcher', 'qa-automation'].map((r) => (
            <button
              key={r}
              className={`plan-segment-tab ${filterRole === r ? 'active' : ''}`}
              onClick={() => setFilterRole(r)}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Subagent Cards List */}
        <div className="crew-grid">
          {filteredSubagents.map((sa) => (
            <div
              key={sa.id}
              className={`subagent-card ${sa.status === 'working' ? 'working' : ''}`}
            >
              <div className="subagent-card-header">
                <div className="subagent-signature">
                  <span>{sa.badge}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className={`subagent-tier-badge ${getTierClass(sa.modelTier)}`}>
                    {sa.modelTier}
                  </span>
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background:
                        sa.status === 'working'
                          ? 'var(--mac-accent)'
                          : sa.status === 'completed'
                          ? 'var(--mac-color-healthy)'
                          : 'var(--mac-text-muted)',
                      boxShadow:
                        sa.status === 'working'
                          ? '0 0 8px var(--mac-accent)'
                          : 'none',
                    }}
                    title={sa.status}
                  />
                </div>
              </div>

              <div style={{ fontSize: '12px', color: 'var(--mac-text-primary)' }}>
                {sa.taskRole}
              </div>

              <div className="subagent-details">
                <span title="Modelo LLM">🧠 {sa.modelTag}</span>
                <span>•</span>
                {sa.worktree ? (
                  <span className="subagent-worktree" title="Worktree aislado">
                    🌿 {sa.worktree}
                  </span>
                ) : (
                  <span style={{ color: 'var(--mac-text-muted)', fontSize: '10px' }}>
                    (shared worktree)
                  </span>
                )}
                <span>•</span>
                <span style={{ fontSize: '10px', color: 'var(--mac-text-muted)' }}>
                  Iniciado {new Date(sa.startedAt).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>

        {filteredSubagents.length === 0 && (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--mac-text-muted)' }}>
            No hay subagentes con este filtro.
          </div>
        )}
      </div>
    </div>
  )
}
