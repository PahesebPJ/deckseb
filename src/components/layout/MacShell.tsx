import React from 'react'
import { ThemeMode } from '../../types/deck'

export interface MacShellProps {
  theme: ThemeMode
  onToggleTheme: () => void
  currentPlanTitle?: string
  planCount?: number
  onSimulatePlan?: () => void
  children: React.ReactNode
}

export const MacShell: React.FC<MacShellProps> = ({
  theme,
  onToggleTheme,
  currentPlanTitle,
  planCount = 0,
  onSimulatePlan,
  children,
}) => {
  return (
    <div className="mac-window">
      {/* Titlebar macOS Sequoia Minimal */}
      <header className="mac-titlebar">
        {/* Left: Traffic Lights & Brand */}
        <div className="mac-titlebar-left">
          <div className="mac-traffic-lights">
            <span
              className="traffic-light close"
              title="Cerrar ventana"
              onClick={() => console.log('Close clicked')}
            />
            <span
              className="traffic-light minimize"
              title="Minimizar"
              onClick={() => console.log('Minimize clicked')}
            />
            <span
              className="traffic-light maximize"
              title="Pantalla completa"
              onClick={() => console.log('Maximize clicked')}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px' }}>
            <span className="brand-badge">deckseb</span>
            <span className="mac-title-badge">Plan Viewer</span>
          </div>
        </div>

        {/* Center: Current Plan Title or Context */}
        <div className="mac-titlebar-center">
          {currentPlanTitle ? (
            <span
              style={{
                fontWeight: 600,
                color: 'var(--mac-text-primary)',
                maxWidth: '460px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={currentPlanTitle}
            >
              📋 {currentPlanTitle}
            </span>
          ) : (
            <span style={{ color: 'var(--mac-text-muted)' }}>
              Visor Editorial de Planes ({planCount} {planCount === 1 ? 'artefacto' : 'artefactos'})
            </span>
          )}
        </div>

        {/* Right: Plan Simulator & Theme Toggle */}
        <div className="mac-titlebar-right">
          {/* Quick Simulated Plan for Testing */}
          {onSimulatePlan && (
            <button
              className="mac-primary-btn"
              onClick={onSimulatePlan}
              title="Generar plan táctico simulado para probar el visor"
              style={{ fontSize: '11px', padding: '4px 10px' }}
            >
              <span>⚡ Simular Plan</span>
            </button>
          )}

          {/* Theme Toggle (Light / Dark) */}
          <button
            className="mac-icon-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro'}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {/* Main Full-Screen Reading Workspace */}
      <main
        className="mac-workspace"
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {children}
      </main>
    </div>
  )
}
