import type { Readable, Writable } from 'node:stream'
import { startUiServer, type UiServerInstance, type UiServerOptions } from './ui-server.ts'

export interface SidecarReadyEvent {
  event: 'ready'
  url: string
  port: number
  pid: number
}

export interface SidecarHandle {
  instance: UiServerInstance
  shutdown: () => Promise<void>
}

export interface SidecarOptions {
  stdin?: Readable
  stdout?: Writable
  serverOptions?: UiServerOptions
  onShutdown?: () => void
}

/**
 * Runs deckseb as a desktop-shell sidecar: binds an ephemeral loopback port, never spawns
 * browser windows (the native shell owns the window) and announces itself with a single JSON
 * line on stdout. Closing stdin is the parent-death signal, so the server never outlives the
 * shell even if the shell crashes before it can kill us.
 */
export async function runSidecar(options: SidecarOptions = {}): Promise<SidecarHandle> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout

  const instance = await startUiServer({
    ...options.serverOptions,
    port: 0,
    host: '127.0.0.1',
    openWindow: false,
    openBrowser: false,
    autoOpenOnPlan: false,
  })

  let stopping: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    stopping ??= instance.close().finally(() => options.onShutdown?.())
    return stopping
  }

  stdin.on('end', () => void shutdown())
  stdin.on('close', () => void shutdown())
  stdin.on('error', () => void shutdown())
  stdin.resume()

  const ready: SidecarReadyEvent = {
    event: 'ready',
    url: instance.url,
    port: instance.port,
    pid: process.pid,
  }
  stdout.write(`${JSON.stringify(ready)}\n`)

  return { instance, shutdown }
}
