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

export function buildDeckNodeRegistration(): TopologyNode {
  const distBin = path.join(PACKAGE_ROOT, 'dist', 'cli', 'deckseb.js')
  const srcBin = path.join(PACKAGE_ROOT, 'src', 'cli', 'deckseb.ts')
  const scriptPath = fsSync.existsSync(distBin) ? distBin : srcBin

  return {
    id: BUNDLE_ID,
    version: VERSION,
    summary:
      'Desktop mission control, PTY terminal hub, and passive telemetry viewer for *seb ecosystem',
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
