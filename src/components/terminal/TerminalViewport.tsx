import React, { useState, useEffect, useRef } from 'react'
import { AgentHostId, SUPPORTED_AGENT_HOSTS, TerminalSession } from '../../types/deck'
import { deckClient } from '../../services/deckClient'

interface TerminalViewportProps {
  onPlanTriggered?: () => void
  activeSessionId?: string
  onSessionChange?: (sessionId: string) => void
}

/**
 * Parses basic ANSI color codes to styled HTML elements
 */
function renderAnsiText(text: string): React.ReactNode[] {
  // Regex to match ANSI escape sequences: \x1b[...m
  const ansiRegex = /\x1b\[([0-9;]+)m/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let currentClasses: string[] = []
  let currentStyle: React.CSSProperties = {}
  let match: RegExpExecArray | null

  while ((match = ansiRegex.exec(text)) !== null) {
    const chunk = text.substring(lastIndex, match.index)
    if (chunk) {
      parts.push(
        <span
          key={`part-${lastIndex}`}
          className={currentClasses.join(' ')}
          style={{ ...currentStyle }}
        >
          {chunk}
        </span>
      )
    }

    const codes = (match[1] ?? '').split(';').map((c) => parseInt(c, 10))
    for (const code of codes) {
      if (code === 0) {
        currentClasses = []
        currentStyle = {}
      } else if (code === 1) {
        currentStyle.fontWeight = 'bold'
      } else if (code === 30) {
        currentStyle.color = 'var(--term-black)'
      } else if (code === 31) {
        currentStyle.color = 'var(--term-red)'
      } else if (code === 32) {
        currentStyle.color = 'var(--term-green)'
      } else if (code === 33) {
        currentStyle.color = 'var(--term-yellow)'
      } else if (code === 34) {
        currentStyle.color = 'var(--term-blue)'
      } else if (code === 35) {
        currentStyle.color = 'var(--term-magenta)'
      } else if (code === 36) {
        currentStyle.color = 'var(--term-cyan)'
      } else if (code === 37) {
        currentStyle.color = 'var(--term-white)'
      } else if (code >= 90 && code <= 97) {
        currentStyle.color = 'var(--term-gray)'
      }
    }

    lastIndex = ansiRegex.lastIndex
  }

  const remainder = text.substring(lastIndex)
  if (remainder) {
    parts.push(
      <span
        key={`part-${lastIndex}`}
        className={currentClasses.join(' ')}
        style={{ ...currentStyle }}
      >
        {remainder}
      </span>
    )
  }

  return parts
}

export const TerminalViewport: React.FC<TerminalViewportProps> = ({
  onPlanTriggered,
  activeSessionId: propActiveSessionId,
  onSessionChange,
}) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [splitSessionId, setSplitSessionId] = useState<string | null>(null)
  const [isSplit, setIsSplit] = useState<boolean>(false)
  const [outputs, setOutputs] = useState<Record<string, string[]>>({})
  const [inputVal, setInputVal] = useState<string>('')
  const [showNewTabMenu, setShowNewTabMenu] = useState<boolean>(false)

  const outputEndRef = useRef<HTMLDivElement | null>(null)
  const splitOutputEndRef = useRef<HTMLDivElement | null>(null)

  // Load initial sessions
  useEffect(() => {
    deckClient.listTerminals().then((list) => {
      setSessions(list)
      const initialId = propActiveSessionId || (list[0] ? list[0].id : '')
      setActiveId(initialId)
      if (onSessionChange && initialId) {
        onSessionChange(initialId)
      }

      // Populate histories
      const histMap: Record<string, string[]> = {}
      for (const s of list) {
        histMap[s.id] = deckClient.getTerminalHistory(s.id)
      }
      setOutputs(histMap)
    })
  }, [])

  // Sync prop changes
  useEffect(() => {
    if (propActiveSessionId && propActiveSessionId !== activeId) {
      setActiveId(propActiveSessionId)
    }
  }, [propActiveSessionId])

  // Listen for terminal data
  useEffect(() => {
    const unsub = deckClient.on('deck:terminal-data', ({ sessionId, data }) => {
      setOutputs((prev) => ({
        ...prev,
        [sessionId]: data.split('\n'),
      }))
    })
    return unsub
  }, [])

  // Auto scroll to bottom
  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollTop = outputEndRef.current.scrollHeight
    }
    if (splitOutputEndRef.current) {
      splitOutputEndRef.current.scrollTop = splitOutputEndRef.current.scrollHeight
    }
  }, [outputs, activeId, splitSessionId])

  const handleSelectTab = (sessionId: string) => {
    setActiveId(sessionId)
    if (onSessionChange) {
      onSessionChange(sessionId)
    }
  }

  const handleCreateTab = async (hostId: AgentHostId) => {
    const session = await deckClient.createTerminal({
      hostId,
      title: `${hostId} · session`,
    })
    const updated = await deckClient.listTerminals()
    setSessions(updated)
    setActiveId(session.id)
    if (onSessionChange) {
      onSessionChange(session.id)
    }
    setOutputs((prev) => ({
      ...prev,
      [session.id]: deckClient.getTerminalHistory(session.id),
    }))
    setShowNewTabMenu(false)
  }

  const handleCloseTab = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await deckClient.closeTerminal(sessionId)
    const updated = await deckClient.listTerminals()
    setSessions(updated)
    if (activeId === sessionId) {
      const nextId = updated[0] ? updated[0].id : ''
      setActiveId(nextId)
      if (onSessionChange) {
        onSessionChange(nextId)
      }
    }
    if (splitSessionId === sessionId) {
      setSplitSessionId(null)
      setIsSplit(false)
    }
  }

  const handleSendCommand = (cmd: string) => {
    if (!activeId) return
    deckClient.writeTerminal(activeId, cmd)
    setInputVal('')

    // Auto-open drawer if plan triggered
    if (cmd.trim().startsWith('/plan') && onPlanTriggered) {
      onPlanTriggered()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSendCommand(inputVal)
    }
  }

  const toggleSplitView = () => {
    if (!isSplit) {
      const secondary = sessions.find((s) => s.id !== activeId)
      if (secondary) {
        setSplitSessionId(secondary.id)
        setIsSplit(true)
      }
    } else {
      setIsSplit(false)
      setSplitSessionId(null)
    }
  }

  const currentLines = outputs[activeId] || []
  const splitLines = splitSessionId ? outputs[splitSessionId] || [] : []
  const activeSession = sessions.find((s) => s.id === activeId)

  return (
    <div className="terminal-container">
      {/* Tab Bar */}
      <div className="terminal-tab-bar">
        <div className="terminal-tabs-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`terminal-tab ${s.id === activeId ? 'active' : ''}`}
              onClick={() => handleSelectTab(s.id)}
              title={`${s.hostId} (${s.cwd})`}
            >
              <span className={`terminal-tab-indicator ${s.status}`} />
              <span>{s.title}</span>
              {sessions.length > 1 && (
                <span
                  className="terminal-tab-close"
                  onClick={(e: React.MouseEvent) => handleCloseTab(s.id, e)}
                  title="Cerrar pestaña"
                >
                  ✕
                </span>
              )}
            </div>
          ))}

          {/* New Tab Button */}
          <div style={{ position: 'relative' }}>
            <button
              className="mac-icon-btn"
              style={{ width: '24px', height: '24px', fontSize: '14px' }}
              onClick={() => setShowNewTabMenu(!showNewTabMenu)}
              title="Nueva pestaña de terminal"
            >
              +
            </button>

            {showNewTabMenu && (
              <div
                style={{
                  position: 'absolute',
                  top: '28px',
                  left: 0,
                  zIndex: 20,
                  background: 'var(--mac-bg-window)',
                  border: '1px solid var(--mac-border)',
                  borderRadius: '8px',
                  boxShadow: 'var(--mac-shadow-card)',
                  padding: '6px',
                  minWidth: '150px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: 'var(--mac-text-muted)',
                    padding: '2px 8px',
                    textTransform: 'uppercase',
                  }}
                >
                  Seleccionar Host
                </div>
                {SUPPORTED_AGENT_HOSTS.map((host) => (
                  <button
                    key={host}
                    className="mac-segment-btn"
                    style={{ textAlign: 'left', width: '100%', justifyContent: 'flex-start' }}
                    onClick={() => handleCreateTab(host)}
                  >
                    <span>⚡</span>
                    <span>{host}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Tools (Split View & Fast Plan Trigger) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            className={`mac-icon-btn ${isSplit ? 'active' : ''}`}
            onClick={toggleSplitView}
            title={isSplit ? 'Cerrar vista dividida' : 'Dividir vista de terminal (Split pane)'}
            style={{ width: '26px', height: '26px' }}
          >
            ◫
          </button>
          <button
            className="mac-primary-btn"
            style={{ padding: '3px 8px', fontSize: '11px' }}
            onClick={() => {
              handleSendCommand('/plan')
            }}
            title="Simular generación de plan y auto-abrir drawer lateral"
          >
            <span>⚡</span>
            <span>Simular /plan</span>
          </button>
        </div>
      </div>

      {/* Terminal Panes */}
      <div className="terminal-panes-wrapper">
        {/* Primary Pane */}
        <div className="terminal-pane">
          <div className="terminal-output" ref={outputEndRef}>
            {currentLines.map((line, idx) => (
              <div key={idx} style={{ minHeight: '1.2em' }}>
                {renderAnsiText(line)}
              </div>
            ))}
          </div>

          {/* Quick Action Chips */}
          <div className="terminal-quick-actions">
            <span style={{ color: 'var(--mac-text-muted)', fontSize: '10px' }}>Comandos rápidos:</span>
            <button className="quick-chip" onClick={() => handleSendCommand('/plan')}>
              /plan
            </button>
            <button className="quick-chip" onClick={() => handleSendCommand('/compact')}>
              /compact
            </button>
            <button className="quick-chip" onClick={() => handleSendCommand('crewseb models list')}>
              crewseb models list
            </button>
            <button className="quick-chip" onClick={() => handleSendCommand('memoseb context')}>
              memoseb context
            </button>
            <button className="quick-chip" onClick={() => handleSendCommand('clear')}>
              clear
            </button>
          </div>

          {/* Interactive Input Bar */}
          <div className="terminal-input-bar">
            <span className="terminal-prompt">
              {activeSession ? `${activeSession.hostId}>` : '$'}
            </span>
            <input
              type="text"
              className="terminal-input"
              placeholder="Escribe un comando (/plan, /compact, crewseb models list, memoseb context)..."
              value={inputVal}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInputVal(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <button
              className="mac-primary-btn"
              style={{ padding: '3px 10px', fontSize: '11px' }}
              onClick={() => handleSendCommand(inputVal)}
            >
              Enter ↵
            </button>
          </div>
        </div>

        {/* Secondary Split Pane (if active) */}
        {isSplit && splitSessionId && (
          <div className="terminal-pane">
            <div
              style={{
                height: '28px',
                background: 'rgba(0,0,0,0.2)',
                borderBottom: '1px solid var(--mac-border-subtle)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 10px',
                fontSize: '11px',
                color: 'var(--mac-text-secondary)',
              }}
            >
              <span>Split: {sessions.find((s) => s.id === splitSessionId)?.title}</span>
            </div>
            <div className="terminal-output" ref={splitOutputEndRef}>
              {splitLines.map((line, idx) => (
                <div key={idx} style={{ minHeight: '1.2em' }}>
                  {renderAnsiText(line)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
