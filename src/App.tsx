import React, { useState, useEffect } from 'react'
import { DetectedArtifact, ThemeMode } from './types/deck'
import { deckClient } from './services/deckClient'
import { MacShell } from './components/layout/MacShell'
import { PlanDrawer } from './components/plans/PlanDrawer'

export const App: React.FC = () => {
  const [theme, setTheme] = useState<ThemeMode>('dark')
  const [planCount, setPlanCount] = useState<number>(0)
  const [currentPlanTitle, setCurrentPlanTitle] = useState<string | undefined>(undefined)

  useEffect(() => {
    deckClient.getTheme().then((t) => {
      setTheme(t)
      document.documentElement.setAttribute('data-theme', t)
    })

    deckClient.listArtifacts().then((arts) => {
      setPlanCount(arts.length)
      if (arts[0]) {
        setCurrentPlanTitle(arts[0].title)
      }
    })

    const unsubArtifact = deckClient.on('deck:artifact-detected', (art: DetectedArtifact) => {
      setPlanCount((prev) => prev + 1)
      setCurrentPlanTitle(art.title)
    })

    return () => {
      unsubArtifact()
    }
  }, [])

  const handleToggleTheme = async () => {
    const nextTheme: ThemeMode = theme === 'dark' ? 'light' : 'dark'
    await deckClient.setTheme(nextTheme)
    setTheme(nextTheme)
    document.documentElement.setAttribute('data-theme', nextTheme)
  }

  const handleSimulatePlan = () => {
    const newPlan = deckClient.triggerSimulatedPlan()
    setCurrentPlanTitle(newPlan.title)
  }

  const handleActivePlanChange = (plan: DetectedArtifact | null) => {
    if (plan) {
      setCurrentPlanTitle(plan.title)
    }
  }

  return (
    <MacShell
      theme={theme}
      onToggleTheme={handleToggleTheme}
      onSimulatePlan={handleSimulatePlan}
      planCount={planCount}
      currentPlanTitle={currentPlanTitle}
    >
      <PlanDrawer onActivePlanChange={handleActivePlanChange} />
    </MacShell>
  )
}

export default App
