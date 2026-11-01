import React, { useState, useEffect } from 'react'
import { AgentHostId, ThemeMode } from './types/deck'
import { deckClient } from './services/deckClient'
import { MacShell, InspectorTab } from './components/layout/MacShell'
import { TerminalViewport } from './components/terminal/TerminalViewport'
import { PlanDrawer } from './components/plans/PlanDrawer'
import { CrewMonitorPanel } from './components/monitors/CrewMonitorPanel'
import { MemoMonitorPanel } from './components/monitors/MemoMonitorPanel'
import { ContextQuotaBar } from './components/telemetry/ContextQuotaBar'

export const App: React.FC = () => {
  const [theme, setTheme] = useState<ThemeMode>('dark')
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(true)
  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTab>('plans')
  const [autoOpenOnPlan, setAutoOpenOnPlan] = useState<boolean>(true)
  const [activeHost, setActiveHost] = useState<AgentHostId>('antigravity')
  const [activeSessionId, setActiveSessionId] = useState<string>('session-agy-01')
  const [planCount, setPlanCount] = useState<number>(2)
  const [activeSubagentsCount, setActiveSubagentsCount] = useState<number>(1)

  // Initialize Theme and Listeners
  useEffect(() => {
    deckClient.getTheme().then((t) => {
      setTheme(t)
      document.documentElement.setAttribute('data-theme', t)
    })

    // Listen for detected artifacts to auto-open drawer
    const unsubArtifact = deckClient.on('deck:artifact-detected', () => {
      setPlanCount((prev) => prev + 1)
      if (autoOpenOnPlan) {
        setIsDrawerOpen(true)
        setActiveInspectorTab('plans')
      }
    })

    // Listen for ecosystem snapshot updates
    const unsubEco = deckClient.on('deck:ecosystem-updated', (snap) => {
      const working = snap.activeSubagents.filter((sa) => sa.status === 'working').length
      setActiveSubagentsCount(working)
    })

    // Initial counts
    deckClient.listArtifacts().then((arts) => setPlanCount(arts.length))
    deckClient.getEcosystemSnapshot().then((snap) => {
      const working = snap.activeSubagents.filter((sa) => sa.status === 'working').length
      setActiveSubagentsCount(working)
    })

    return () => {
      unsubArtifact()
      unsubEco()
    }
  }, [autoOpenOnPlan])

  const handleToggleTheme = async () => {
    const nextTheme: ThemeMode = theme === 'dark' ? 'light' : 'dark'
    await deckClient.setTheme(nextTheme)
    setTheme(nextTheme)
    document.documentElement.setAttribute('data-theme', nextTheme)
  }

  const handleSimulatePlan = () => {
    deckClient.triggerSimulatedPlan(activeSessionId)
    setIsDrawerOpen(true)
    setActiveInspectorTab('plans')
  }

  const handleTriggerCompact = () => {
    deckClient.writeTerminal(activeSessionId, '/compact')
  }

  const renderDrawerContent = () => {
    switch (activeInspectorTab) {
      case 'plans':
        return (
          <PlanDrawer
            isOpen={isDrawerOpen}
            onClose={() => setIsDrawerOpen(false)}
            autoOpenOnPlan={autoOpenOnPlan}
            onToggleAutoOpen={() => setAutoOpenOnPlan(!autoOpenOnPlan)}
          />
        )
      case 'crew':
        return <CrewMonitorPanel onClose={() => setIsDrawerOpen(false)} />
      case 'memo':
        return <MemoMonitorPanel onClose={() => setIsDrawerOpen(false)} />
      default:
        return null
    }
  }

  return (
    <MacShell
      theme={theme}
      onToggleTheme={handleToggleTheme}
      isDrawerOpen={isDrawerOpen}
      onToggleDrawer={() => setIsDrawerOpen(!isDrawerOpen)}
      activeInspectorTab={activeInspectorTab}
      onSelectInspectorTab={setActiveInspectorTab}
      activeHost={activeHost}
      onChangeHost={setActiveHost}
      onSimulatePlan={handleSimulatePlan}
      planCount={planCount}
      activeSubagentsCount={activeSubagentsCount}
      drawerContent={renderDrawerContent()}
      footerContent={
        <ContextQuotaBar
          activeSessionId={activeSessionId}
          onTriggerCompact={handleTriggerCompact}
        />
      }
    >
      <TerminalViewport
        activeSessionId={activeSessionId}
        onSessionChange={setActiveSessionId}
        onPlanTriggered={() => {
          if (autoOpenOnPlan) {
            setIsDrawerOpen(true)
            setActiveInspectorTab('plans')
          }
        }}
      />
    </MacShell>
  )
}

export default App
