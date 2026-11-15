#!/usr/bin/env node
// Exercises the real SEA binary the way the Tauri shell does: no Node on PATH, wait for the
// ready line, hit the HTML, API and the embedded stylesheet asset, then close stdin and expect
// a clean exit. `--version` alone would not catch a broken SEA asset or sidecar mode.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const binary = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  console.error('usage: node scripts/smoke-sidecar.mjs <path-to-deckseb-server-binary>')
  process.exit(2)
}

const home = mkdtempSync(path.join(os.tmpdir(), 'deckseb-smoke-'))
const child = spawn(binary, ['sidecar'], {
  cwd: home,
  env: { HOME: home, USERPROFILE: home, PATH: '', SystemRoot: process.env.SystemRoot ?? '' },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const fail = (message) => {
  console.error(`✘ ${message}`)
  child.kill()
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

const ready = await new Promise((resolve) => {
  let buffer = ''
  const timer = setTimeout(() => fail('no ready line within 30 s'), 30_000)
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    clearTimeout(timer)
    resolve(JSON.parse(buffer.slice(0, newline)))
  })
  child.once('exit', (code) => fail(`sidecar exited early with code ${code}`))
})
child.removeAllListeners('exit')
console.log(`✔ ready at ${ready.url}`)

for (const [route, type, pattern] of [
  ['/', 'text/html', /deckseb/],
  ['/api/plans', 'application/json', /"plans"/],
  ['/styles/macos.css', 'text/css', /data-theme="dark"/],
]) {
  const res = await fetch(`${ready.url}${route}`)
  const body = await res.text()
  if (res.status !== 200) fail(`${route} -> HTTP ${res.status}`)
  if (!(res.headers.get('content-type') ?? '').includes(type)) fail(`${route} -> wrong content-type`)
  if (!pattern.test(body)) fail(`${route} -> unexpected body`)
  console.log(`✔ ${route} (${body.length} B)`)
}

const exitCode = new Promise((resolve) => child.once('exit', resolve))
child.stdin.end()
const timer = setTimeout(() => fail('sidecar did not exit within 5 s of stdin closing'), 5_000)
const code = await exitCode
clearTimeout(timer)
rmSync(home, { recursive: true, force: true })
if (code !== 0) fail(`exit code ${code}`)
console.log('✔ clean exit after stdin closed')
