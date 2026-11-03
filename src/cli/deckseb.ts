#!/usr/bin/env node
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { detectPlanInStream } from '../core/plan-detector.ts'
import { BUNDLE_ID, VERSION } from '../version.ts'
import {
  getDefaultTopologyPath,
  isDecksebRegistered,
  registerDecksebNode,
  unregisterDecksebNode,
} from './setup.ts'
import {
  launchStandaloneDesktopWindow,
  startUiServer,
} from './ui-server.ts'

function printHelp(): void {
  console.log(`
🪐 ${BUNDLE_ID} v${VERSION} — Visor Editorial Minimalista e Instantáneo de Planes

Uso:
  deckseb [watch|ui] [--port 4321] [--open] [--browser]
      Inicia el visor en segundo plano, abre la ventana en cuanto un modelo cree
      un plan (*plan*.md) y actualiza la vista en tiempo real vía SSE.

  deckseb <archivo.md> | deckseb show <archivo.md> [--port 4321]
      Abre de inmediato el plan en la ventana editorial (reutiliza servidor si está activo).

  deckseb detect <archivo.md> [--json]
      Analiza un archivo e inspecciona bloques Mermaid y clasificación del segmento.

  deckseb status [--json]
      Muestra el estado del visor, puerto activo y registro en la topología de hubseb.

  deckseb setup
      Registra deckseb en hubseb topology.json como nodo de visualización (ui.deck).

  deckseb purge
      Elimina deckseb de la topología de hubseb.

  deckseb --version, -v
      Muestra la versión de deckseb.

  deckseb --help, -h
      Muestra esta ayuda.
`)
}

function extractPort(args: string[], defaultPort = 4321): number {
  const portIdx = args.indexOf('--port')
  if (portIdx !== -1 && args[portIdx + 1]) {
    const val = parseInt(args[portIdx + 1]!, 10)
    if (!Number.isNaN(val) && val > 0) return val
  }
  return defaultPort
}

async function handleStatus(jsonMode: boolean, port: number): Promise<void> {
  const registered = await isDecksebRegistered()
  let serverActive = false
  let activePlansCount = 0

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/plans`, {
      signal: AbortSignal.timeout(500),
    })
    if (res.ok) {
      serverActive = true
      const data = await res.json()
      if (Array.isArray(data.plans)) {
        activePlansCount = data.plans.length
      }
    }
  } catch {
    serverActive = false
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          version: VERSION,
          bundleId: BUNDLE_ID,
          registeredInTopology: registered,
          topologyPath: getDefaultTopologyPath(),
          uiServer: {
            port,
            status: serverActive ? 'running' : 'stopped',
            plansLoaded: activePlansCount,
          },
        },
        null,
        2
      )
    )
    return
  }

  console.log(`\n🪐 deckseb v${VERSION} — Estado del Visor:`)
  console.log(`  • Registrado en hubseb:     ${registered ? '✅ SÍ' : '❌ NO'}`)
  console.log(`  • Servidor Visor (:4321):    ${serverActive ? `🟢 ACTIVO (${activePlansCount} planes en memoria)` : '⚪ INACTIVO'}`)
  console.log(`  • Topología:                ${getDefaultTopologyPath()}\n`)
}

async function handleDetect(filePath: string, jsonMode: boolean): Promise<void> {
  try {
    const fullPath = path.resolve(filePath)
    if (!existsSync(fullPath)) {
      console.error(`Error: el archivo no existe: ${filePath}`)
      process.exit(1)
    }

    const content = await fs.readFile(fullPath, 'utf8')
    const detected = detectPlanInStream('cli-session', 'active-project', content, fullPath)

    if (!detected) {
      if (jsonMode) {
        console.log(JSON.stringify({ detected: null }))
      } else {
        console.log(`No se detectó un plan de implementación o bloque Mermaid en: ${filePath}`)
      }
      return
    }

    if (jsonMode) {
      console.log(JSON.stringify({ detected }, null, 2))
      return
    }

    console.log(`\n📋 Artefacto Detectado:`)
    console.log(`  • Título:    ${detected.title}`)
    console.log(`  • Segmento:  ${detected.segment}`)
    console.log(`  • Archivo:   ${detected.filePath}`)
    console.log(`  • Diagramas: ${detected.mermaidBlocks.length} bloque(s) Mermaid`)
    console.log(`  • Memoseb:   categoría sugerida "${detected.memosebCategory || 'architecture'}"\n`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error al analizar ${filePath}: ${msg}`)
    process.exit(1)
  }
}

async function handleOpenFile(filePath: string, args: string[]): Promise<void> {
  const fullPath = path.resolve(filePath)
  if (!existsSync(fullPath)) {
    console.error(`Error: el archivo no existe: ${filePath}`)
    process.exit(1)
  }

  const port = extractPort(args, 4321)
  const useBrowser = args.includes('--browser')

  // 1. Try sending to an already-running server
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fullPath }),
      signal: AbortSignal.timeout(600),
    })
    if (res.ok) {
      console.log(`✨ Plan enviado al visor activo en http://127.0.0.1:${port}`)
      launchStandaloneDesktopWindow(`http://127.0.0.1:${port}`, useBrowser)
      return
    }
  } catch {
    // Server is not running; start a new one below
  }

  // 2. Start a new server instance with the plan loaded
  console.log(`\n🚀 Abriendo ${path.basename(fullPath)} en http://127.0.0.1:${port}`)
  const instance = await startUiServer({
    port,
    initialPlanFile: fullPath,
    openWindow: !useBrowser,
    openBrowser: useBrowser,
    autoOpenOnPlan: true,
  })
  console.log(`✨ Visor activo en ${instance.url} (Presiona Ctrl+C para salir)\n`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const firstArg = args[0]
  const jsonMode = args.includes('--json')
  const port = extractPort(args, 4321)

  if (firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    printHelp()
    return
  }

  if (firstArg === '--version' || firstArg === '-v' || firstArg === 'version') {
    console.log(`${BUNDLE_ID} v${VERSION}`)
    return
  }

  if (!firstArg || firstArg === 'watch' || firstArg === 'ui') {
    const openWindow = args.includes('--open')
    const useBrowser = args.includes('--browser')
    console.log(`\n🚀 Iniciando deckseb Visor de Planes en http://127.0.0.1:${port}`)
    const instance = await startUiServer({
      port,
      autoOpenOnPlan: true,
      openWindow,
      openBrowser: useBrowser,
    })
    console.log(`✨ Vigilando planes en tiempo real en ${instance.url} (Presiona Ctrl+C para salir)\n`)
    return
  }

  if (firstArg === 'show') {
    const target = args[1]
    if (!target) {
      console.error('Error: especifica el archivo a mostrar: deckseb show <archivo.md>')
      process.exit(1)
    }
    await handleOpenFile(target, args)
    return
  }

  // If the first argument is an existing markdown file or ends with .md
  if (firstArg.endsWith('.md') || existsSync(path.resolve(firstArg))) {
    await handleOpenFile(firstArg, args)
    return
  }

  switch (firstArg) {
    case 'detect': {
      const target = args[1]
      if (!target) {
        console.error('Error: especifica el archivo a analizar: deckseb detect <archivo.md>')
        process.exit(1)
      }
      await handleDetect(target, jsonMode)
      break
    }
    case 'status': {
      await handleStatus(jsonMode, port)
      break
    }
    case 'setup': {
      const outcome = await registerDecksebNode()
      console.log(`✅ ${BUNDLE_ID} registrado en ${outcome.topologyFile}`)
      break
    }
    case 'purge': {
      const outcome = await unregisterDecksebNode()
      if (outcome.removed) {
        console.log(`🧹 ${BUNDLE_ID} eliminado de ${outcome.topologyFile}`)
      } else {
        console.log(`ℹ️ ${BUNDLE_ID} no estaba registrado en ${outcome.topologyFile}`)
      }
      break
    }
    default: {
      console.error(`Comando desconocido: ${firstArg}`)
      printHelp()
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error('Fatal CLI error:', err)
  process.exit(1)
})
