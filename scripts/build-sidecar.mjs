#!/usr/bin/env node
// Builds the deckseb CLI as a Node Single Executable Application (SEA) and places it where
// Tauri's `bundle.externalBin` expects it: src-tauri/binaries/deckseb-server-<target-triple>[.exe].
// SEA cannot cross-compile: the produced binary always targets the Node runtime running this script.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const workDir = path.join(root, 'build', 'sidecar')
const binDir = path.join(root, 'src-tauri', 'binaries')
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'

function hostTargetTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE
  const info = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  const host = info.match(/^host: (\S+)$/m)?.[1]
  if (!host) throw new Error('Could not read the host target triple from `rustc -vV`')
  return host
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: isWindows && cmd === 'npx' })
}

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22) throw new Error(`Node >= 22 is required to build the sidecar (found ${process.version})`)

rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
mkdirSync(binDir, { recursive: true })

// 1. Bundle to a single CommonJS file: SEA main scripts must be CJS with only builtin requires.
const bundlePath = path.join(workDir, 'deckseb-sidecar.cjs')
await build({
  entryPoints: [path.join(root, 'src', 'cli', 'deckseb.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: { 'import.meta.dirname': '__dirname' },
  logLevel: 'info',
})
const bundled = readFileSync(bundlePath, 'utf8').replace(/^#!.*\n/, '')
writeFileSync(bundlePath, bundled)

// 2. SEA config: the stylesheet travels as an embedded asset (read via node:sea getAsset).
const blobPath = path.join(workDir, 'sea-prep.blob')
const triple = hostTargetTriple()
const outBinary = path.join(binDir, `deckseb-server-${triple}${isWindows ? '.exe' : ''}`)
const seaConfig = {
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: { 'macos.css': path.join(root, 'src', 'styles', 'macos.css') },
}

// Node >= 25.5 builds the executable in one step; older runtimes need the blob + postject flow.
const hasBuildSea = major > 25 || (major === 25 && minor >= 5)
rmSync(outBinary, { force: true })

if (hasBuildSea) {
  writeFileSync(
    path.join(workDir, 'sea-config.json'),
    JSON.stringify({ ...seaConfig, output: outBinary, executable: process.execPath }, null, 2)
  )
  run(process.execPath, ['--build-sea', path.join(workDir, 'sea-config.json')])
} else {
  writeFileSync(path.join(workDir, 'sea-config.json'), JSON.stringify(seaConfig, null, 2))
  run(process.execPath, ['--experimental-sea-config', path.join(workDir, 'sea-config.json')])
  copyFileSync(process.execPath, outBinary)
  chmodSync(outBinary, 0o755)
  if (isMac) run('codesign', ['--remove-signature', outBinary])
  const postjectArgs = [
    'postject',
    outBinary,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]
  if (isMac) postjectArgs.push('--macho-segment-name', 'NODE_SEA')
  run('npx', postjectArgs)
}

// macOS refuses to run modified binaries without a (possibly ad-hoc) signature.
if (isMac) run('codesign', ['--force', '--sign', '-', outBinary])

console.log(`\nSidecar ready: ${path.relative(root, outBinary)}`)
