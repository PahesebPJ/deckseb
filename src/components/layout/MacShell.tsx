import React from 'react'
import { AgentHostId, SUPPORTED_AGENT_HOSTS, ThemeMode } from '../../types/deck'

export type InspectorTab = 'plans' | 'crew' | 'memo'

interface MacShellProps {
  theme: ThemeMode
  onToggleTheme: () => void
  isDrawerOpen: boolean
  onToggleDrawer: () => void
  activeInspectorTab: InspectorTab
  onSelectInspectorTab: (tab: InspectorTab) => void
  activeHost: AgentHostId
  onChangeHost: (host: AgentHostId) => void
  onSimulatePlan: () => void
  planCount: number
  activeSubagentsCount: number
  children: React.ReactNode
  drawerContent: React.ReactNode
  footerContent: React.ReactNode
}

export const MacShell: React.FC<MacShellProps> = ({
  theme,
  onToggleTheme,
  isDrawerOpen,
  onToggleDrawer,
  activeInspectorTab,
  onSelectInspectorTab,
  activeHost,
  onChangeHost,
  onSimulatePlan,
  planCount,
  activeSubagentsCount,
  children,
  drawerContent,
  footerContent,
}) => {
  return (
    <div className="mac-window">
      {/* Titlebar macOS Sequoia */}
      <header className="mac-titlebar">
        {/* Left: Window Controls Traffic Lights & Host Select */}
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

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '12px' }}>
            <span style={{ fontSize: '11px', color: 'var(--mac-text-muted)' }}>Host:</span>
            <select
              className="mac-select"
              value={activeHost}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChangeHost(e.target.value as AgentHostId)}
              title="Cambiar orquestador activo para nuevas sesiones"
            >
              {SUPPORTED_AGENT_HOSTS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Center: Title & Project Badge */}
        <div className="mac-titlebar-center">
          <span>deckseb</span>
          <span className="mac-title-badge">Tactical Deck • Sequoia</span>
        </div>

        {/* Right: Inspector Tab Switcher, Fast Plan Trigger & Theme Toggle */}
        <div className="mac-titlebar-right">
          {/* Quick Plan Simulation */}
          <button
            className="mac-primary-btn"
            onClick={onSimulatePlan}
            title="Disparar simulación de plan y abrir drawer lateral automáticamente"
          >
            <span>⚡</span>
            <span>Simular Plan</span>
          </button>

          {/* Segmented Control for Inspector Tabs */}
          <div className="mac-segmented-control">
            <button
              className={`mac-segment-btn ${
                isDrawerOpen && activeInspectorTab === 'plans' ? 'active' : ''
              }`}
              onClick={() => {
                onSelectInspectorTab('plans')
                if (!isDrawerOpen) onToggleDrawer()
              }}
              title="Ver Planes y diagramas Mermaid"
            >
              <span>📋 Planes</span>
              {planCount > 0 && (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '1px 5px',
                    borderRadius: '8px',
                    background: 'var(--mac-accent)',
                    color: '#fff',
                  }}
                >
                  {planCount}
                </span>
              )}
            </button>

            <button
              className={`mac-segment-btn ${
                isDrawerOpen && activeInspectorTab === 'crew' ? 'active' : ''
              }`}
              onClick={() => {
                onSelectInspectorTab('crew')
                if (!isDrawerOpen) onToggleDrawer()
              }}
              title="Monitor de subagentes crewseb"
            >
              <span>👥 Crew</span>
              {activeSubagentsCount > 0 && (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '1px 5px',
                    borderRadius: '8px',
                    background: 'var(--mac-color-healthy)',
                    color: '#fff',
                  }}
                >
                  {activeSubagentsCount}
                </span>
              )}
            </button>

            <button
              className={`mac-segment-btn ${
                isDrawerOpen && activeInspectorTab === 'memo' ? 'active' : ''
              }`}
              onClick={() => {
                onSelectInspectorTab('memo')
                if (!isDrawerOpen) onToggleDrawer()
              }}
              title="Monitor de bóveda memoseb"
            >
              <span>🧠 Memo</span>
            </button>
          </div>

          {/* Toggle Drawer Open/Close */}
          <button
            className={`mac-icon-btn ${isDrawerOpen ? 'active' : ''}`}
            onClick={onToggleDrawer}
            title={isDrawerOpen ? 'Colapsar panel lateral' : 'Desplegar panel lateral'}
          >
            {isDrawerOpen ? '⇥' : '⇤'}
          </button>

          {/* Theme Toggle (Light / Dark) */}
          <button
            className="mac-icon-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro'}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {/* Main Split Body: Terminal + Lateral Inspector */}
      <main className="mac-workspace">
        <section className="mac-main-content">{children}</section>
        {isDrawerOpen && drawerContent}
      </main>

      {/* Footer Telemetry */}
      {footerContent}
    </div>
  )
}
