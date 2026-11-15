import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, afterEach, describe, it } from 'node:test'
import { runSidecar, type SidecarReadyEvent } from '../src/cli/sidecar.ts'

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli', 'deckseb.ts')

// A failed assertion must not leave a live server behind: it would keep the runner hanging.
const spawned = new Set<ChildProcessWithoutNullStreams>()

function killSpawned(): void {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  spawned.clear()
}

async function spawnSidecar(
  home: string,
  env: NodeJS.ProcessEnv = {}
): Promise<{ child: ChildProcessWithoutNullStreams; ready: SidecarReadyEvent }> {
  const child = spawn(process.execPath, [CLI, 'sidecar'], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  spawned.add(child)
  const ready = await new Promise<SidecarReadyEvent>((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const nl = buf.indexOf('\n')
      if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)) as SidecarReadyEvent)
    })
    child.once('exit', (code) => reject(new Error(`sidecar exited early with ${code}`)))
  })
  return { child, ready }
}

function exitWithin(child: ChildProcessWithoutNullStreams, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

describe('deckseb sidecar mode', () => {
  const tempDirs: string[] = []

  const makeTempDir = async (prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  afterEach(killSpawned)

  after(async () => {
    killSpawned()
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  })

  it('announces a ready line with an ephemeral loopback URL and serves the API', async () => {
    const tempDir = await makeTempDir('deckseb-sidecar-')
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let output = ''
    stdout.on('data', (chunk) => (output += chunk.toString()))

    const handle = await runSidecar({
      stdin,
      stdout,
      serverOptions: { vaultRoot: path.join(tempDir, 'vault'), disableAutoPoll: true },
    })

    const lines = output.trim().split('\n')
    assert.equal(lines.length, 1, 'exactly one stdout line before any request')
    const ready = JSON.parse(lines[0] ?? '') as SidecarReadyEvent
    assert.equal(ready.event, 'ready')
    assert.notEqual(ready.port, 4321, 'must not reuse the daemon default port')
    assert.ok(ready.port > 0)
    assert.equal(ready.url, `http://127.0.0.1:${ready.port}`)

    const plans = await fetch(`${ready.url}/api/plans`)
    assert.equal(plans.status, 200)
    const css = await fetch(`${ready.url}/styles/macos.css`)
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type') ?? '', /text\/css/)

    let shutDown = false
    const closed = new Promise<void>((resolve) => {
      handle.instance.server.once('close', () => {
        shutDown = true
        resolve()
      })
    })
    stdin.end()
    await closed
    assert.ok(shutDown, 'closing stdin stops the server')
  })

  it('binds a distinct port per instance', async () => {
    const dirs = [await makeTempDir('deckseb-sidecar-'), await makeTempDir('deckseb-sidecar-')]
    const handles = await Promise.all(
      dirs.map((dir) =>
        runSidecar({
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          serverOptions: { vaultRoot: path.join(dir, 'vault'), disableAutoPoll: true },
        })
      )
    )
    assert.notEqual(handles[0]?.instance.port, handles[1]?.instance.port)
    await Promise.all(handles.map((h) => h.shutdown()))
  })

  it('exits the CLI process when the parent closes stdin', { timeout: 20_000 }, async () => {
    const home = await makeTempDir('deckseb-sidecar-home-')
    const { child, ready } = await spawnSidecar(home)
    assert.equal(ready.event, 'ready')
    assert.equal(ready.pid, child.pid)
    assert.equal((await fetch(`${ready.url}/`)).status, 200)

    const exited = exitWithin(child, 5_000)
    child.stdin.end()
    assert.equal(await exited, 0)
  })

  it('exits cleanly on SIGTERM', { timeout: 20_000, skip: process.platform === 'win32' }, async () => {
    const home = await makeTempDir('deckseb-sidecar-home-')
    const { child } = await spawnSidecar(home)
    const exited = exitWithin(child, 5_000)
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
  })

  it('does not hang on a half-open request when stdin closes', { timeout: 20_000 }, async () => {
    const home = await makeTempDir('deckseb-sidecar-home-')
    const { child, ready } = await spawnSidecar(home)
    const socket = net.connect(ready.port, '127.0.0.1')
    socket.on('error', () => {})
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write('POST /api/plans HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\n{"partial":')

    const exited = exitWithin(child, 5_000)
    child.stdin.end()
    assert.equal(await exited, 0)
    socket.destroy()
  })

  it(
    'never launches a browser window when a new plan appears',
    { timeout: 30_000, skip: process.platform === 'win32' },
    async () => {
      const home = await makeTempDir('deckseb-sidecar-home-')
      const fakeBin = path.join(home, 'fake-bin')
      const launches = path.join(home, 'launches.log')
      await fs.mkdir(fakeBin)
      for (const name of ['xdg-open', 'open', 'chromium', 'google-chrome', 'omarchy-launch-webapp']) {
        await fs.writeFile(path.join(fakeBin, name), `#!/bin/sh\necho ${name} >> "${launches}"\n`, {
          mode: 0o755,
        })
      }

      const { child, ready } = await spawnSidecar(home, { PATH: fakeBin })
      await fs.mkdir(path.join(home, 'plans'))
      await fs.writeFile(
        path.join(home, 'plans', 'implementation-plan.md'),
        '# Plan de implementación\n\n## Pasos\n\n1. Primer paso\n2. Segundo paso\n'
      )

      let detected = false
      for (let i = 0; i < 40 && !detected; i++) {
        await new Promise((r) => setTimeout(r, 250))
        const body = await (await fetch(`${ready.url}/api/plans`)).text()
        detected = body.includes('implementation-plan.md')
      }
      assert.ok(detected, 'the plan must be picked up, otherwise this test proves nothing')
      // Auto-open is throttled to 1.5 s; wait past it before asserting nothing was launched.
      await new Promise((r) => setTimeout(r, 2_000))
      assert.equal(await fs.readFile(launches, 'utf8').catch(() => ''), '')

      const exited = exitWithin(child, 5_000)
      child.stdin.end()
      assert.equal(await exited, 0)
    }
  )
})
