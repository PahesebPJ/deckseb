import React, { useState, useEffect } from 'react'
import { SessionContextQuota } from '../../types/deck'
import { deckClient } from '../../services/deckClient'

interface ContextQuotaBarProps {
  activeSessionId?: string
  onTriggerCompact?: () => void
}

export const ContextQuotaBar: React.FC<ContextQuotaBarProps> = ({
  activeSessionId,
  onTriggerCompact,
}) => {
  const [quota, setQuota] = useState<SessionContextQuota>({
    sessionId: activeSessionId || 'session-agy-01',
    modelName: 'gemini-3.8-flash',
    usedTokens: 142000,
    maxTokens: 200000,
    remainingPercent: 29,
    inputTokens: 118000,
    outputTokens: 24000,
    quotaUsedPercent: 71,
    quotaWindowLabel: 'Window: 1M tokens/min • 71% utilized',
    warningLevel: 'warning',
  })

  // Load quota when active session changes
  useEffect(() => {
    if (activeSessionId) {
      deckClient.getSessionQuota(activeSessionId).then((q) => {
        setQuota(q)
      })
    }
  }, [activeSessionId])

  // Listen for real-time quota updates
  useEffect(() => {
    const unsub = deckClient.on('deck:quota-updated', (updatedQuota) => {
      if (!activeSessionId || updatedQuota.sessionId === activeSessionId) {
        setQuota(updatedQuota)
      }
    })
    return unsub
  }, [activeSessionId])

  const handleCompact = () => {
    if (onTriggerCompact) {
      onTriggerCompact()
    } else if (activeSessionId) {
      deckClient.writeTerminal(activeSessionId, '/compact')
    }
  }

  const getProgressFillClass = () => {
    if (quota.remainingPercent >= 45) return 'healthy'
    if (quota.remainingPercent >= 20) return 'warning'
    return 'critical'
  }

  const usedK = (quota.usedTokens / 1000).toFixed(0)
  const maxK = (quota.maxTokens / 1000).toFixed(0)

  return (
    <footer className="mac-bottom-bar">
      {/* Left section: Ecosystem & Passive Observer Mode */}
      <div className="bottom-bar-left">
        <span
          className={`status-dot ${quota.warningLevel}`}
          title={`Estado de Contexto: ${quota.warningLevel}`}
        />
        <span style={{ fontWeight: 600, color: 'var(--mac-text-primary)' }}>
          deckseb
        </span>
        <span style={{ color: 'var(--mac-text-muted)' }}>•</span>
        <span style={{ fontSize: '10px', color: 'var(--mac-text-secondary)' }}>
          Passive Observer (hubseb/v1 • 100% Opcional)
        </span>
        <span style={{ color: 'var(--mac-text-muted)' }}>•</span>
        <span style={{ fontSize: '11px', color: 'var(--mac-accent)' }}>
          {quota.modelName}
        </span>
      </div>

      {/* Center section: Context Window & Progress */}
      <div className="bottom-bar-center">
        <span style={{ fontSize: '11px' }}>
          Contexto:{' '}
          <strong style={{ color: 'var(--mac-text-primary)' }}>
            {quota.remainingPercent}% libre
          </strong>{' '}
          ({usedK}k / {maxK}k)
        </span>

        {/* Progress Bar */}
        <div className="progress-track" title={`${quota.remainingPercent}% restante`}>
          <div
            className={`progress-fill ${getProgressFillClass()}`}
            style={{ width: `${quota.remainingPercent}%` }}
          />
        </div>

        {/* Quick Compact Button */}
        <button
          className="compact-btn"
          onClick={handleCompact}
          title="Compactar ventana de contexto para recuperar tokens"
        >
          /compact
        </button>
      </div>

      {/* Right section: Window Quota & Consumed Tokens */}
      <div className="bottom-bar-right">
        <span style={{ fontSize: '10px', color: 'var(--mac-text-muted)' }}>
          In: {(quota.inputTokens / 1000).toFixed(0)}k | Out:{' '}
          {(quota.outputTokens / 1000).toFixed(0)}k
        </span>
        <span style={{ color: 'var(--mac-text-muted)' }}>•</span>
        <span style={{ fontSize: '11px', color: 'var(--mac-text-secondary)' }}>
          {quota.quotaWindowLabel}
        </span>
      </div>
    </footer>
  )
}
