import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, it } from 'node:test'
import { runSidecar, type SidecarReadyEvent } from '../src/cli/sidecar.ts'

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli', 'deckseb.ts')

describe('deckseb sidecar mode', () => {
  const tempDirs: string[] = []

  after(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  })

  it('announces a ready line with an ephemeral loopback URL and serves the API', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-sidecar-'))
    tempDirs.push(tempDir)
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
    const ready = JSON.parse(lines[0]) as SidecarReadyEvent
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

  it('exits the CLI process when the parent closes stdin', { timeout: 20_000 }, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-sidecar-home-'))
    tempDirs.push(home)
    const child = spawn(process.execPath, [CLI, 'sidecar'], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    const ready = await new Promise<SidecarReadyEvent>((resolve, reject) => {
      let buf = ''
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString()
        const nl = buf.indexOf('\n')
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)) as SidecarReadyEvent)
      })
      child.once('exit', (code) => reject(new Error(`sidecar exited early with ${code}`)))
    })
    assert.equal(ready.event, 'ready')
    assert.equal(ready.pid, child.pid)
    assert.equal((await fetch(`${ready.url}/`)).status, 200)

    const exitCode = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    child.stdin.end()
    assert.equal(await exitCode, 0)
  })
})
