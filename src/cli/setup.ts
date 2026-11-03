import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUNDLE_ID, PACKAGE_ROOT, VERSION } from '../version.ts'

export const PROVIDES = ['ui.deck', 'artifacts.organizer']
export const CONSUMES = ['memory.vault', 'crew.specialists', 'crew.models']
export const SIGNALS = ['deck.launched', 'artifact.detected']

export interface TopologyNode {
  id: string
  version: string
  summary: string
  command: string[]
  provides: string[]
  consumes: string[]
  signals: string[]
  triggers: string[]
  registeredAt: string
}

export interface HubsebTopology {
  schema: string
  updatedAt: string
  nodes: Record<string, TopologyNode>
}

export interface SetupOptions {
  topologyPath?: string
}

export function getDefaultTopologyPath(): string {
  return path.join(os.homedir(), '.config', 'hubseb', 'topology.json')
}

export function getDecksebPidPath(): string {
  return path.join(os.homedir(), '.config', 'hubseb', 'deckseb.pid')
}

export function buildDeckNodeRegistration(): TopologyNode {
  const distBin = path.join(PACKAGE_ROOT, 'dist', 'cli', 'deckseb.js')
  const srcBin = path.join(PACKAGE_ROOT, 'src', 'cli', 'deckseb.ts')
  const scriptPath = fsSync.existsSync(distBin) ? distBin : srcBin

  return {
    id: BUNDLE_ID,
    version: VERSION,
    summary: 'Minimalist instant plan viewer for *seb ecosystem',
    command: [path.resolve(process.execPath), path.resolve(scriptPath)],
    provides: [...PROVIDES],
    consumes: [...CONSUMES],
    signals: [...SIGNALS],
    triggers: [],
    registeredAt: new Date().toISOString(),
  }
}

/**
 * Registers deckseb into hubseb topology.json as a leaf node.
 * Degrades gracefully if hubseb is not installed.
 */
export async function registerDecksebNode(
  options?: SetupOptions
): Promise<{ success: boolean; topologyFile: string; node: TopologyNode }> {
  const topologyFile = options?.topologyPath ?? getDefaultTopologyPath()
  const dir = path.dirname(topologyFile)

  await fs.mkdir(dir, { recursive: true })

  let topology: HubsebTopology
  try {
    const raw = await fs.readFile(topologyFile, 'utf8')
    topology = JSON.parse(raw) as HubsebTopology
    if (!topology.nodes || typeof topology.nodes !== 'object') {
      topology.nodes = {}
    }
  } catch {
    topology = {
      schema: 'hubseb-topology/v1',
      updatedAt: new Date().toISOString(),
      nodes: {},
    }
  }

  const node = buildDeckNodeRegistration()
  topology.nodes[BUNDLE_ID] = node
  topology.updatedAt = new Date().toISOString()

  await fs.writeFile(topologyFile, JSON.stringify(topology, null, 2), 'utf8')

  if (!options?.topologyPath) {
    try {
      const rulesDir = path.join(
        os.homedir(),
        '.gemini',
        'config',
        'plugins',
        'deckseb',
        'rules'
      )
      await fs.mkdir(rulesDir, { recursive: true })
      const ruleContent = `# Reglas activas de deckseb en Antigravity

- deckseb es el visor editorial minimalista e instantáneo de planes de la tripulación.
- Al crear un plan de implementación o ejecutar \`/plan\`, si deseas forzar la apertura visual inmediata del plan en segundo plano, invoca:
  \`deckseb show <ruta-del-plan.md> --daemon\`
- Si el visor ya está en ejecución, se actualizará en tiempo real por SSE sin abrir ventanas duplicadas.
`
      await fs.writeFile(path.join(rulesDir, 'deckseb.md'), ruleContent, 'utf8')
    } catch {
      // Graceful degradation
    }
  }

  return {
    success: true,
    topologyFile,
    node,
  }
}

/**
 * Unregisters deckseb from hubseb topology.json without altering other nodes.
 */
export async function unregisterDecksebNode(
  options?: SetupOptions
): Promise<{ success: boolean; removed: boolean; topologyFile: string }> {
  const topologyFile = options?.topologyPath ?? getDefaultTopologyPath()

  if (!options?.topologyPath) {
    try {
      const rulePath = path.join(
        os.homedir(),
        '.gemini',
        'config',
        'plugins',
        'deckseb',
        'rules',
        'deckseb.md'
      )
      if (fsSync.existsSync(rulePath)) {
        await fs.unlink(rulePath)
      }
    } catch {
      // Graceful degradation
    }
  }

  if (!fsSync.existsSync(topologyFile)) {
    return {
      success: true,
      removed: false,
      topologyFile,
    }
  }

  try {
    const raw = await fs.readFile(topologyFile, 'utf8')
    const topology = JSON.parse(raw) as HubsebTopology
    if (!topology.nodes || !(BUNDLE_ID in topology.nodes)) {
      return {
        success: true,
        removed: false,
        topologyFile,
      }
    }

    delete topology.nodes[BUNDLE_ID]
    topology.updatedAt = new Date().toISOString()

    await fs.writeFile(topologyFile, JSON.stringify(topology, null, 2), 'utf8')

    return {
      success: true,
      removed: true,
      topologyFile,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to unregister deckseb from ${topologyFile}: ${msg}`)
  }
}

/**
 * Checks whether deckseb is registered in hubseb topology.json.
 */
export async function isDecksebRegistered(
  options?: SetupOptions
): Promise<boolean> {
  const topologyFile = options?.topologyPath ?? getDefaultTopologyPath()
  try {
    if (!fsSync.existsSync(topologyFile)) return false
    const raw = await fs.readFile(topologyFile, 'utf8')
    const topology = JSON.parse(raw) as HubsebTopology
    return Boolean(topology.nodes && BUNDLE_ID in topology.nodes)
  } catch {
    return false
  }
}

/**
 * Starts deckseb UI server daemon in background detached mode.
 * Reuses existing instance if already healthy on the specified port.
 */
export async function startDecksebDaemon(
  port = 4321
): Promise<{ started: boolean; pid?: number; url: string }> {
  const url = `http://127.0.0.1:${port}`

  // 1. Check if server is already running
  try {
    const res = await fetch(`${url}/api/plans`, {
      signal: AbortSignal.timeout(400),
    })
    if (res.ok) {
      let existingPid: number | undefined
      try {
        const pidFile = getDecksebPidPath()
        if (fsSync.existsSync(pidFile)) {
          const rawPid = fsSync.readFileSync(pidFile, 'utf8').trim()
          const parsed = parseInt(rawPid, 10)
          if (!Number.isNaN(parsed)) existingPid = parsed
        }
      } catch {}
      return { started: false, pid: existingPid, url }
    }
  } catch {
    // Not running yet, proceed with spawn
  }

  // 2. Resolve script executable path
  const distBin = path.join(PACKAGE_ROOT, 'dist', 'cli', 'deckseb.js')
  const srcBin = path.join(PACKAGE_ROOT, 'src', 'cli', 'deckseb.ts')
  const scriptPath = fsSync.existsSync(distBin) ? distBin : srcBin

  const pidFile = getDecksebPidPath()
  await fs.mkdir(path.dirname(pidFile), { recursive: true })

  const child = spawn(
    process.execPath,
    [scriptPath, 'watch', '--port', String(port)],
    {
      detached: true,
      stdio: 'ignore',
    }
  )

  const pid = child.pid
  if (pid) {
    await fs.writeFile(pidFile, String(pid), 'utf8')
  }
  child.unref()

  // 3. Wait up to ~1.2s pinging /api/plans every 150ms
  const startTime = Date.now()
  while (Date.now() - startTime < 1200) {
    try {
      const ping = await fetch(`${url}/api/plans`, {
        signal: AbortSignal.timeout(150),
      })
      if (ping.ok) {
        break
      }
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  return { started: true, pid, url }
}

/**
 * Stops running deckseb daemon by killing the process tracked in deckseb.pid.
 */
export async function stopDecksebDaemon(): Promise<boolean> {
  const pidFile = getDecksebPidPath()
  if (!fsSync.existsSync(pidFile)) {
    return false
  }

  let stopped = false
  try {
    const raw = await fs.readFile(pidFile, 'utf8')
    const pid = parseInt(raw.trim(), 10)
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM')
        stopped = true
      } catch {
        // Process might already be stopped
      }
    }
  } catch {
    // Ignore read error
  } finally {
    try {
      await fs.unlink(pidFile)
    } catch {}
  }

  return stopped
}
