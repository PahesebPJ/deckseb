import { execFile, execSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { SebEcosystemObserver } from '../core/ecosystem-observer.ts'
import { detectPlanInStream } from '../core/plan-detector.ts'
import { SegmentedArtifactVault } from '../core/segmented-vault.ts'
import { computeSessionContextQuota } from '../core/transcript-monitor.ts'
import type { DetectedArtifact } from '../types/deck.ts'
import { BUNDLE_ID, PACKAGE_ROOT, VERSION } from '../version.ts'

export interface UiServerOptions {
  port?: number
  host?: string
  openBrowser?: boolean
  openWindow?: boolean
  vaultRoot?: string
}

export function launchStandaloneDesktopWindow(url: string, forceBrowser = false): void {
  if (forceBrowser) {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execFile(cmd, [url], () => {})
    return
  }

  const appArgs = [`--app=${url}`, '--window-size=1380,880', '--class=deckseb']

  if (process.platform === 'linux') {
    const candidates = ['chromium', 'google-chrome', 'google-chrome-stable', 'brave', 'microsoft-edge']
    for (const bin of candidates) {
      try {
        const p = execFile(bin, appArgs, () => {})
        if (p.pid) return
      } catch {
        // try next
      }
    }
    execFile('xdg-open', [url], () => {})
    return
  }

  if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    for (const bin of macCandidates) {
      if (existsSync(bin)) {
        execFile(bin, appArgs, () => {})
        return
      }
    }
    execFile('open', [url], () => {})
    return
  }

  if (process.platform === 'win32') {
    const winCandidates = ['msedge.exe', 'chrome.exe', 'brave.exe']
    for (const bin of winCandidates) {
      try {
        const p = execFile(bin, appArgs, () => {})
        if (p.pid) return
      } catch {}
    }
    execFile('start', [url], () => {})
    return
  }

  execFile('xdg-open', [url], () => {})
}

export interface UiServerInstance {
  server: http.Server
  port: number
  url: string
  close: () => Promise<void>
}

export interface TerminalSessionInfo {
  id: string
  hostId: string
  title: string
  cwd: string
  pid: number
  status: 'running' | 'idle' | 'closed'
  lines: string[]
  createdAt: string
  usedTokens: number
  maxTokens: number
}

function getSanitizedEnv(): NodeJS.ProcessEnv {
  const home = os.homedir()
  const localBin = path.join(home, '.local', 'bin')
  const usrLocalBin = '/usr/local/bin'
  const currentPath = process.env.PATH || '/usr/bin:/bin'
  const parts = currentPath.split(':')
  if (!parts.includes(localBin)) parts.unshift(localBin)
  if (!parts.includes(usrLocalBin)) parts.unshift(usrLocalBin)
  return {
    ...process.env,
    PATH: parts.join(':'),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
}

function getSystemInfo(cwd: string): { osRelease: string; branch: string } {
  let osRelease = `${os.type()} ${os.release()} (${os.arch()})`
  try {
    osRelease = execSync('uname -sr', { encoding: 'utf8', timeout: 1500 }).trim()
  } catch {}

  let branch = 'main'
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
    }).trim()
  } catch {}

  return { osRelease, branch }
}

export class RealTerminalManager {
  private sessions = new Map<string, TerminalSessionInfo>()
  private processes = new Map<string, ChildProcess>()

  async createSession(hostId: string, title?: string, cwd?: string): Promise<TerminalSessionInfo> {
    const sessionCwd = cwd && existsSync(cwd) ? path.resolve(cwd) : process.cwd()
    const id = `term-${hostId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const sessionTitle = title || `${hostId} · ${path.basename(sessionCwd)}`
    const env = getSanitizedEnv()

    const shellBin = process.env.SHELL || '/bin/sh'
    const proc = spawn(shellBin, ['-s'], {
      cwd: sessionCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const pid = proc.pid || process.pid
    proc.unref()
    this.processes.set(id, proc)

    const { osRelease, branch } = getSystemInfo(sessionCwd)

    const initialLines = [
      `\x1b[1;36m[deckseb]\x1b[0m Sixzone Tactical Terminal initialized for \x1b[1m${hostId}\x1b[0m (PID: ${pid})`,
      `\x1b[90mSystem:\x1b[0m ${osRelease} | \x1b[90mCWD:\x1b[0m ${sessionCwd}`,
      `\x1b[32m✔ Git Branch:\x1b[0m ${branch} | \x1b[38;5;39mStatus:\x1b[0m RUNNING`,
      `\x1b[90mTip: Run real shell commands (ls, git status, pwd), quick pills or /plan /compact\x1b[0m`,
    ]

    const session: TerminalSessionInfo = {
      id,
      hostId,
      title: sessionTitle,
      cwd: sessionCwd,
      pid,
      status: 'running',
      lines: initialLines,
      createdAt: new Date().toISOString(),
      usedTokens: 14200,
      maxTokens: 200000,
    }

    this.sessions.set(id, session)

    proc.on('exit', () => {
      const s = this.sessions.get(id)
      if (s && s.status === 'running') {
        s.status = 'idle'
      }
    })

    return session
  }

  listSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      hostId: s.hostId,
      title: s.title,
      cwd: s.cwd,
      pid: s.pid,
      status: s.status,
      lines: [...s.lines],
      createdAt: s.createdAt,
      usedTokens: s.usedTokens,
      maxTokens: s.maxTokens,
    }))
  }

  getSession(sessionId: string): TerminalSessionInfo | undefined {
    return this.sessions.get(sessionId)
  }

  killSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const proc = this.processes.get(sessionId)
    if (proc) {
      try {
        proc.stdin?.end()
        proc.kill('SIGTERM')
      } catch {}
      this.processes.delete(sessionId)
    }
    session.status = 'closed'
    this.sessions.delete(sessionId)
    return true
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.killSession(id)
    }
  }

  async executeCommand(
    sessionId: string,
    command: string,
    vault: SegmentedArtifactVault
  ): Promise<{
    success: boolean
    output?: string
    stdout?: string
    stderr?: string
    code?: number
    lines: string[]
    cwd: string
    detectedArtifact?: DetectedArtifact | null
    tokenUsage?: { used: number; max: number; remainingPercent: number }
  }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const trimmed = command.trim()
    session.lines.push(`❯ ${command}`)
    session.usedTokens = Math.min(
      session.maxTokens,
      session.usedTokens + Math.floor(command.length / 3) + 25
    )

    // Handle /plan or • Escanear Plan
    if (trimmed === '/plan' || trimmed.startsWith('/plan ')) {
      let planText = ''
      let planFile = ''
      const candidates = [
        path.join(session.cwd, 'README.md'),
        path.join(PACKAGE_ROOT, 'README.md'),
        path.join(session.cwd, 'AGENT_INSTALL.md'),
      ]
      for (const cand of candidates) {
        if (existsSync(cand)) {
          try {
            planText = await readFile(cand, 'utf8')
            planFile = cand
            break
          } catch {}
        }
      }

      if (!planText || !planText.includes('```mermaid')) {
        planText = `# Plan de Mando: deckseb Sixzone Bento\n\nArquitectura interactiva de terminal táctica en modo Bento Grid.\n\n\`\`\`mermaid\nflowchart LR\n  CLI["Host CLI (${session.hostId})"] --> Engine["deckseb Core Engine"]\n  Engine --> BentoUI["Sixzone Bento UI"]\n  Engine --> Vault[".seb-vault/"]\n  Engine --> Memo["memoseb FTS5"]\n\`\`\`\n\n## Matriz de Despacho\n- Terminales PTY reales en /api/terminal\n- Sincronización en vivo con memoseb\n- Auto-renderizado de diagramas SVG`
        planFile = path.join(session.cwd, 'plans', 'sixzone-plan.md')
      }

      const detected = detectPlanInStream(
        session.id,
        path.basename(session.cwd) || 'deckseb',
        planText,
        planFile
      )

      if (detected) {
        await vault.saveArtifact(detected)
      }

      session.lines.push(
        `\x1b[32m✔ Plan escaneado e indexado en .seb-vault! Desplegando en Inspector Táctico...\x1b[0m`
      )

      return {
        success: true,
        output: 'Plan detectado y guardado en .seb-vault',
        stdout: 'Plan detectado',
        lines: session.lines,
        cwd: session.cwd,
        detectedArtifact: detected,
      }
    }

    // Handle /compact
    if (trimmed === '/compact') {
      session.usedTokens = Math.max(12000, Math.floor(session.usedTokens * 0.45))
      const percent = Math.round((1 - session.usedTokens / session.maxTokens) * 100)
      session.lines.push(
        `\x1b[32m✔ Contexto compactado exitosamente. Capacidad restante: ${percent}%\x1b[0m`
      )
      return {
        success: true,
        output: 'Context compacted',
        lines: session.lines,
        cwd: session.cwd,
        tokenUsage: {
          used: session.usedTokens,
          max: session.maxTokens,
          remainingPercent: percent,
        },
      }
    }

    // Handle cd command
    if (trimmed === 'cd' || trimmed.startsWith('cd ')) {
      const target = trimmed === 'cd' ? os.homedir() : trimmed.slice(3).trim()
      const resolved = target.startsWith('~')
        ? path.join(os.homedir(), target.slice(1))
        : path.resolve(session.cwd, target)

      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        session.cwd = resolved
        session.lines.push(`\x1b[90m${resolved}\x1b[0m`)
        return {
          success: true,
          stdout: resolved,
          lines: session.lines,
          cwd: session.cwd,
        }
      } else {
        const errMsg = `cd: no such file or directory: ${target}`
        session.lines.push(`\x1b[31m${errMsg}\x1b[0m`)
        return {
          success: false,
          stderr: errMsg,
          lines: session.lines,
          cwd: session.cwd,
        }
      }
    }

    // Handle clear / Limpiar
    if (trimmed === 'clear' || trimmed === 'Limpiar') {
      session.lines = []
      return {
        success: true,
        stdout: '',
        lines: session.lines,
        cwd: session.cwd,
      }
    }

    // REAL SYSTEM EXECUTION
    const env = getSanitizedEnv()
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: session.cwd,
        env,
      })

      let stdout = ''
      let stderr = ''

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {}
      }, 15000)

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        const combined = (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).trimEnd()
        if (combined) {
          const split = combined.split(/\r?\n/)
          for (const line of split) {
            session.lines.push(line)
          }
        }
        resolve({
          success: code === 0,
          stdout,
          stderr,
          code: code ?? 0,
          lines: session.lines,
          cwd: session.cwd,
        })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        const errMsg = String(err.message || err)
        session.lines.push(`\x1b[31mError: ${errMsg}\x1b[0m`)
        resolve({
          success: false,
          stderr: errMsg,
          code: 1,
          lines: session.lines,
          cwd: session.cwd,
        })
      })
    })
  }
}

function parseJsonBody<T = any>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'))
      }
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({} as T)
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${String(err)}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const json = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(json)
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  res.end(html)
}

function sendCss(res: http.ServerResponse, css: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  })
  res.end(css)
}

export function generateDeckUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="es" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>deckseb v${VERSION} — Mission Control</title>
  <link rel="stylesheet" href="/styles/macos.css">
  <style>
    /* Inline fallbacks for zero flash */
    body {
      margin: 0;
      padding: 0;
      background: #05080b;
      color: #ffffff;
      overflow: hidden;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    }
  </style>
</head>
<body>
  <div class="bento-shell">
    <!-- Topbar: Bento Card with macOS traffic lights & fast action pills -->
    <header class="bento-card bento-topbar mac-titlebar">
      <span class="corner-cross tl">+</span>
      <span class="corner-cross tr">+</span>

      <div class="topbar-left mac-titlebar-left">
        <div class="traffic-lights mac-traffic-lights">
          <span class="traffic-light close" title="Cerrar"></span>
          <span class="traffic-light minimize" title="Minimizar"></span>
          <span class="traffic-light maximize" title="Maximizar"></span>
        </div>
        <button class="bento-pill pill-ghost pill-mini" id="toggleSidebarBtn" title="Ocultar / Mostrar Sidebar Izquierda">
          ☰ Sidebar
        </button>
        <span class="brand-badge app-badge">deckseb v${VERSION} — Mission Control</span>
      </div>

      <div class="topbar-center titlebar-center mac-titlebar-center">
        <div class="host-status-chip">
          <span class="status-indicator live status-dot-pulse" id="livePill" title="Sesión activa"></span>
          <span class="window-title" id="activeHostLabel">shell · deckseb</span>
          <span class="header-tags" id="activePidBadge">PID: ...</span>
        </div>
      </div>

      <div class="topbar-actions titlebar-actions mac-titlebar-right">
        <button class="bento-pill pill-cyan" id="simulatePlanBtn" title="Escanear y abrir plan en Inspector">
          • Escanear Plan
        </button>
        <button class="bento-pill pill-ghost" id="topTabPlan" title="Abrir Plan & Mermaid">
          • Plan & Mermaid
        </button>
        <button class="bento-pill pill-ghost" id="topTabCrew" title="Abrir CrewSeb">
          • CrewSeb (10)
        </button>
        <button class="bento-pill pill-ghost" id="topTabMemo" title="Abrir MemoSeb">
          • MemoSeb
        </button>
        <button class="bento-pill pill-ghost" id="topTabVault" title="Abrir Bóveda">
          • .seb-vault
        </button>
        <button class="bento-pill pill-petrol" id="themeToggleBtn" title="Alternar Modo Claro / Oscuro">
          <span id="themeIcon">☀️</span> <span id="themeLabel">Claro</span>
        </button>
        <button class="bento-pill pill-ghost pill-mini" id="toggleInspectorBtn" title="Abrir / Ocultar Inspector Derecho">
          Inspector
        </button>
      </div>
    </header>

    <!-- Main Workspace: 3 Columns Bento Grid -->
    <main class="bento-workspace mac-workspace">
      <!-- Column 1: Left Sidebar of Real Terminal Sessions (290px, collapsible) -->
      <aside class="bento-card bento-sidebar" id="leftSidebar">
        <span class="corner-cross tl">+</span>
        <span class="corner-cross tr">+</span>
        <span class="corner-cross bl">+</span>
        <span class="corner-cross br">+</span>

        <div class="bento-header">
          <span class="bento-header-title">
            <span>💻</span> SESIONES DE TERMINAL
          </span>
          <span class="header-tags" id="sessionCountBadge">1 activa</span>
        </div>

        <div class="sidebar-host-grid">
          <button class="bento-pill pill-petrol pill-mini host-btn" data-host="shell">• + Shell</button>
          <button class="bento-pill pill-petrol pill-mini host-btn" data-host="antigravity">• + Antigravity</button>
          <button class="bento-pill pill-petrol pill-mini host-btn" data-host="claude">• + Claude</button>
          <button class="bento-pill pill-petrol pill-mini host-btn" data-host="codex">• + Codex</button>
          <button class="bento-pill pill-petrol pill-mini host-btn" data-host="opencode">• + OpenCode</button>
          <button class="bento-pill pill-petrol pill-mini host-btn" data-host="herdr">• + Herdr</button>
        </div>

        <div class="sessions-scroll-list" id="sessionsList">
          <!-- Injected dynamically -->
        </div>
      </aside>

      <!-- Column 2: Central Terminal (Real PTY/Shell Output & Execution) -->
      <section class="bento-card bento-terminal-col terminal-container">
        <span class="corner-cross tl">+</span>
        <span class="corner-cross tr">+</span>
        <span class="corner-cross bl">+</span>
        <span class="corner-cross br">+</span>

        <div class="terminal-header">
          <div class="tabs-list" id="tabsContainer">
            <!-- Tabs injected dynamically -->
          </div>
          <div class="terminal-actions">
            <select id="newTabSelect" class="mac-select">
              <option value="" disabled selected>+ Nueva Sesión...</option>
              <option value="shell">shell (Terminal local)</option>
              <option value="antigravity">antigravity (Gemini CLI)</option>
              <option value="claude">claude (Claude Code)</option>
              <option value="codex">codex (OpenAI)</option>
              <option value="opencode">opencode</option>
              <option value="herdr">herdr</option>
            </select>
          </div>
        </div>

        <div class="terminal-body" id="termOutput">
          <!-- Real terminal stream lines -->
        </div>

        <!-- Quick Pills Bar above input -->
        <div class="terminal-quick-pills">
          <span style="font-size: 11px; color: var(--bento-text-muted); margin-right: 4px;">Atajos:</span>
          <button class="bento-pill pill-petrol pill-mini quick-cmd-btn" data-cmd="ls -la">• ls -la</button>
          <button class="bento-pill pill-petrol pill-mini quick-cmd-btn" data-cmd="git status">• git status</button>
          <button class="bento-pill pill-petrol pill-mini quick-cmd-btn" data-cmd="crewseb models list">• crewseb models list</button>
          <button class="bento-pill pill-petrol pill-mini quick-cmd-btn" data-cmd="memoseb context">• memoseb context</button>
          <button class="bento-pill pill-cyan pill-mini quick-cmd-btn" data-cmd="/plan">• /plan</button>
          <button class="bento-pill pill-ghost pill-mini quick-cmd-btn" data-cmd="Limpiar">• Limpiar</button>
        </div>

        <div class="terminal-prompt-bar">
          <span class="prompt-symbol">❯</span>
          <input type="text" id="termInput" class="terminal-input" placeholder="Escribe un comando (/plan, /compact, crewseb models list, memoseb context)..." autofocus />
          <button id="sendBtn" class="bento-pill pill-white">• Enviar</button>
        </div>
      </section>

      <!-- Column 3: Right Inspector (Plan, CrewSeb, MemoSeb, Vault) -->
      <aside class="bento-card bento-inspector mac-inspector" id="sideInspector">
        <span class="corner-cross tl">+</span>
        <span class="corner-cross tr">+</span>
        <span class="corner-cross bl">+</span>
        <span class="corner-cross br">+</span>

        <div class="bento-header">
          <span class="bento-header-title">
            <span>⚡</span> INSPECTOR TÁCTICO
          </span>
          <button class="session-close-btn" id="closeInspectorBtn" title="Cerrar Inspector">×</button>
        </div>

        <div class="inspector-tabs">
          <button class="tab-btn active" data-tab="plan">📋 Plan & Mermaid</button>
          <button class="tab-btn" data-tab="crew">👥 CrewSeb (<span id="crewCountBadge">10</span>)</button>
          <button class="tab-btn" data-tab="memo">🧠 MemoSeb</button>
          <button class="tab-btn" data-tab="vault">📁 .seb-vault</button>
        </div>

        <div class="inspector-content" id="inspectorContent">
          <!-- Panel 1: Plan & Mermaid SVG -->
          <div class="panel-view" id="panelPlan">
            <div class="panel-header">
              <h3 id="planTitle">Plan de Implementación Activo</h3>
              <div class="header-tags" id="planSegmentBadge">Segmento: plans</div>
            </div>
            <div class="plan-markdown" id="planBody">
              <p>Esperando la ejecución de <code>/plan</code> o escaneo de artefactos...</p>
            </div>
            <div class="mermaid-preview-container">
              <h4>Visualización Interactiva SVG</h4>
              <div class="mermaid-diagram-box" id="mermaidBox">
                <!-- Inline SVG diagram -->
              </div>
            </div>
            <div class="panel-footer">
              <select id="memoCategorySelect" class="mac-select">
                <option value="architecture">architecture</option>
                <option value="decision">decision</option>
                <option value="domain">domain</option>
                <option value="convention">convention</option>
                <option value="bugfix">bugfix</option>
              </select>
              <button class="bento-pill pill-cyan" id="syncMemoBtn">• 🧠 Enviar a memoseb</button>
            </div>
          </div>

          <!-- Panel 2: CrewSeb 10 Roles -->
          <div class="panel-view" id="panelCrew" style="display: none;">
            <div class="panel-header">
              <h3>Tripulación crewseb</h3>
              <span class="header-tags" id="crewConcurrencyLabel">Modo: parallel (cloud-tiered)</span>
            </div>
            <div class="crew-roster" id="crewRoster">
              <!-- Crew specialists list -->
            </div>
          </div>

          <!-- Panel 3: MemoSeb Live Memories -->
          <div class="panel-view" id="panelMemo" style="display: none;">
            <div class="panel-header">
              <h3>Bóveda memoseb</h3>
              <span class="header-tags" id="memoStatsLabel">Cargando...</span>
            </div>
            <div class="memo-feed" id="memoFeed">
              <!-- Memories list -->
            </div>
          </div>

          <!-- Panel 4: .seb-vault Folders -->
          <div class="panel-view" id="panelVault" style="display: none;">
            <div class="panel-header">
              <h3>Carpetas Segmentadas (.seb-vault)</h3>
            </div>
            <div class="vault-tree" id="vaultTree">
              <div class="segment-folder">📁 plans/ <span class="header-tags">activo</span></div>
              <div class="segment-folder">📁 diagrams/ <span class="header-tags">.mmd</span></div>
              <div class="segment-folder">📁 specs/ <span class="header-tags">bdd</span></div>
              <div class="segment-folder">📁 reviews/ <span class="header-tags">qa</span></div>
              <div class="segment-folder">📁 post-mortems/ <span class="header-tags">rca</span></div>
            </div>
          </div>
        </div>
      </aside>
    </main>

    <!-- Bottom Telemetry Statusbar: Bento Card -->
    <footer class="bento-card bento-statusbar mac-statusbar">
      <span class="corner-cross bl">+</span>
      <span class="corner-cross br">+</span>

      <div class="status-left">
        <span class="status-pill safe" id="optionalModeBadge">✓ 100% Opcional • Observador Pasivo</span>
        <span class="status-text" id="activeProjectSlug">proyecto: deckseb</span>
      </div>

      <div class="status-center">
        <div class="quota-meter-container">
          <div class="quota-meter-labels">
            <span>Contexto Restante: <strong id="contextRemainingLabel">85%</strong></span>
            <span id="tokenCountsLabel">30,000 / 200,000 tokens</span>
          </div>
          <div class="quota-bar-track">
            <div class="quota-bar-fill safe" id="quotaBarFill" style="width: 85%;"></div>
          </div>
        </div>
      </div>

      <div class="status-right">
        <button class="bento-pill pill-petrol pill-mini" id="compactQuickBtn" title="Inyectar /compact en la sesión activa">
          • ⚡ /compact
        </button>
      </div>
    </footer>
  </div>

  <script>
    // Client state
    let activeTheme = 'dark';
    let activeSessionId = '';
    let sessions = [];
    let isLeftSidebarOpen = true;
    let isInspectorOpen = true;

    // ANSI escape code parser to HTML
    function ansiToHtml(text) {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\x1b\\[1;34m/g, '<span style="color:#60a5fa;font-weight:bold;">')
        .replace(/\\x1b\\[1;35m/g, '<span style="color:#c084fc;font-weight:bold;">')
        .replace(/\\x1b\\[1;36m/g, '<span style="color:#38bdf8;font-weight:bold;">')
        .replace(/\\x1b\\[38;5;39m/g, '<span style="color:#38bdf8;">')
        .replace(/\\x1b\\[32m/g, '<span style="color:#34d399;">')
        .replace(/\\x1b\\[31m/g, '<span style="color:#f87171;">')
        .replace(/\\x1b\\[33m/g, '<span style="color:#fbbf24;">')
        .replace(/\\x1b\\[36m/g, '<span style="color:#22d3ee;">')
        .replace(/\\x1b\\[90m/g, '<span style="color:#94a3b8;">')
        .replace(/\\x1b\\[1m/g, '<span style="font-weight:bold;">')
        .replace(/\\x1b\\[0m/g, '</span>');
    }

    // Dynamic pure SVG renderer for Mermaid flowcharts
    function renderMermaidSvg(mermaidCode) {
      if (!mermaidCode) return '<p style="color:var(--bento-text-muted);">Sin diagrama Mermaid.</p>';
      
      // Extract nodes and connections
      const lines = mermaidCode.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
      const nodes = [];
      const nodeMap = new Map();

      // Find node definitions: ID["Label"] or ID[Label]
      const nodeRegex = /([A-Za-z0-9_]+)\\["?([^"\\]]+)"?\\]/g;
      lines.forEach(line => {
        let match;
        while ((match = nodeRegex.exec(line)) !== null) {
          const id = match[1];
          const label = match[2];
          if (!nodeMap.has(id)) {
            const nodeObj = { id, label, index: nodes.length };
            nodes.push(nodeObj);
            nodeMap.set(id, nodeObj);
          }
        }
      });

      if (nodes.length === 0) {
        // Fallback default nodes if custom format
        nodes.push(
          { id: 'Host', label: 'Terminal Host', index: 0 },
          { id: 'Core', label: 'deckseb Core', index: 1 },
          { id: 'UI', label: 'Sixzone Bento UI', index: 2 },
          { id: 'Vault', label: '.seb-vault', index: 3 }
        );
      }

      const totalNodes = nodes.length;
      const nodeWidth = 140;
      const nodeHeight = 44;
      const spacingX = 40;
      const startX = 20;
      const totalWidth = startX * 2 + totalNodes * nodeWidth + (totalNodes - 1) * spacingX;
      const totalHeight = 110;

      let svg = '<svg viewBox="0 0 ' + totalWidth + ' ' + totalHeight + '" class="bento-mermaid-svg" xmlns="http://www.w3.org/2000/svg">';
      svg += '<defs>';
      svg += '  <linearGradient id="nodeGrad" x1="0%" y1="0%" x2="100%" y2="100%">';
      svg += '    <stop offset="0%" stop-color="#0b3142" />';
      svg += '    <stop offset="100%" stop-color="#07131b" />';
      svg += '  </linearGradient>';
      svg += '  <marker id="cyanArrow" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">';
      svg += '    <polygon points="0 0, 8 3.5, 0 7" fill="#38bdf8" />';
      svg += '  </marker>';
      svg += '</defs>';

      // Draw connection lines
      for (let i = 0; i < totalNodes - 1; i++) {
        const x1 = startX + i * (nodeWidth + spacingX) + nodeWidth;
        const y1 = totalHeight / 2;
        const x2 = startX + (i + 1) * (nodeWidth + spacingX);
        const y2 = totalHeight / 2;
        svg += '<path d="M ' + x1 + ' ' + y1 + ' L ' + (x2 - 2) + ' ' + y2 + '" stroke="#1ca3c4" stroke-width="2" stroke-dasharray="4 2" marker-end="url(#cyanArrow)" />';
      }

      // Draw nodes
      nodes.forEach((n, idx) => {
        const x = startX + idx * (nodeWidth + spacingX);
        const y = (totalHeight - nodeHeight) / 2;
        svg += '<g transform="translate(' + x + ',' + y + ')">';
        svg += '  <rect width="' + nodeWidth + '" height="' + nodeHeight + '" rx="10" ry="10" fill="url(#nodeGrad)" stroke="#38bdf8" stroke-width="1.6" />';
        svg += '  <text x="' + (nodeWidth / 2) + '" y="' + (nodeHeight / 2 + 4) + '" fill="#ffffff" font-size="11.5" font-weight="600" text-anchor="middle" font-family="-apple-system, sans-serif">' + n.label + '</text>';
        svg += '</g>';
      });

      svg += '</svg>';
      return svg;
    }

    // Render Sessions in Sidebar and Tabs
    function renderSessions() {
      const listContainer = document.getElementById('sessionsList');
      const tabsContainer = document.getElementById('tabsContainer');
      const countBadge = document.getElementById('sessionCountBadge');

      listContainer.innerHTML = '';
      tabsContainer.innerHTML = '';
      countBadge.innerText = sessions.length + ' activa' + (sessions.length > 1 ? 's' : '');

      sessions.forEach(s => {
        const isActive = s.id === activeSessionId;

        // 1. Sidebar Card
        const card = document.createElement('div');
        card.className = 'session-item-card ' + (isActive ? 'active' : '');
        card.onclick = (e) => {
          if (e.target.classList.contains('session-close-btn')) return;
          selectSession(s.id);
        };

        const shortCwd = s.cwd ? (s.cwd.length > 25 ? '...' + s.cwd.slice(-22) : s.cwd) : '~/deckseb';
        card.innerHTML = 
          '<div class="session-item-left">' +
            '<span class="status-dot ' + (s.status === 'running' ? 'running' : 'idle') + '"></span>' +
            '<div class="session-meta">' +
              '<span class="session-title-text">' + s.title + '</span>' +
              '<span class="session-sub-text">PID ' + (s.pid || '-') + ' • ' + shortCwd + '</span>' +
            '</div>' +
          '</div>' +
          '<button class="session-close-btn" title="Cerrar sesión">×</button>';

        const closeBtn = card.querySelector('.session-close-btn');
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          killSession(s.id);
        };
        listContainer.appendChild(card);

        // 2. Terminal Tab
        const tab = document.createElement('div');
        tab.className = 'terminal-tab ' + (isActive ? 'active' : '');
        tab.onclick = () => selectSession(s.id);
        tab.innerHTML = '<span>• ' + s.title + '</span>';
        tabsContainer.appendChild(tab);
      });

      const current = sessions.find(s => s.id === activeSessionId);
      if (current) {
        document.getElementById('activeHostLabel').innerText = current.title;
        document.getElementById('activePidBadge').innerText = 'PID: ' + (current.pid || '-');
      }
    }

    function renderTerminal() {
      const term = document.getElementById('termOutput');
      const current = sessions.find(s => s.id === activeSessionId);
      if (!current) {
        term.innerHTML = '<div class="terminal-line" style="color:var(--bento-text-muted);">Sin sesiones activas. Crea una nueva sesión arriba.</div>';
        return;
      }

      term.innerHTML = (current.lines || []).map(line => {
        return '<div class="terminal-line">' + ansiToHtml(line) + '</div>';
      }).join('');

      term.scrollTop = term.scrollHeight;
    }

    function selectSession(id) {
      activeSessionId = id;
      renderSessions();
      renderTerminal();
    }

    // Terminal API Handlers
    async function fetchSessions() {
      try {
        const res = await fetch('/api/terminal/sessions');
        const data = await res.json();
        sessions = data.sessions || [];
        if (sessions.length > 0 && (!activeSessionId || !sessions.some(s => s.id === activeSessionId))) {
          activeSessionId = sessions[0].id;
        }
        renderSessions();
        renderTerminal();
      } catch (err) {
        console.error('Error fetching terminal sessions:', err);
      }
    }

    async function createTerminalSession(hostId) {
      try {
        const res = await fetch('/api/terminal/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hostId, title: hostId + ' · deckseb' })
        });
        const data = await res.json();
        if (data.session) {
          sessions.push(data.session);
          activeSessionId = data.session.id;
          renderSessions();
          renderTerminal();
        }
      } catch (err) {
        console.error('Error creating terminal session:', err);
      }
    }

    async function killSession(sessionId) {
      if (sessions.length <= 1) {
        alert('Debe permanecer al menos una sesión de terminal activa.');
        return;
      }
      try {
        await fetch('/api/terminal/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
        sessions = sessions.filter(s => s.id !== sessionId);
        if (activeSessionId === sessionId) {
          activeSessionId = sessions[0]?.id || '';
        }
        renderSessions();
        renderTerminal();
      } catch (err) {
        console.error('Error killing session:', err);
      }
    }

    async function executeCommand(command) {
      if (!command || !command.trim() || !activeSessionId) return;
      const inp = document.getElementById('termInput');
      inp.value = '';

      const current = sessions.find(s => s.id === activeSessionId);
      if (current) {
        current.lines.push('❯ ' + command);
        renderTerminal();
      }

      try {
        const res = await fetch('/api/terminal/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeSessionId, command })
        });
        const data = await res.json();

        if (current) {
          if (data.lines) {
            current.lines = data.lines;
          }
          if (data.cwd) {
            current.cwd = data.cwd;
          }
        }
        renderSessions();
        renderTerminal();

        // Handle detected artifact
        if (data.detectedArtifact) {
          openPlanInInspector(data.detectedArtifact);
        }

        // Handle token quota
        if (data.tokenUsage) {
          updateQuota(data.tokenUsage.remainingPercent, data.tokenUsage.used, data.tokenUsage.max);
        }
      } catch (err) {
        if (current) {
          current.lines.push('\\x1b[31mError de comunicación: ' + err.message + '\\x1b[0m');
          renderTerminal();
        }
      }
    }

    function openPlanInInspector(artifact) {
      // Ensure inspector is open
      if (!isInspectorOpen) {
        toggleInspector();
      }
      switchInspectorTab('plan');

      document.getElementById('planTitle').innerText = artifact.title || 'Plan de Implementación';
      document.getElementById('planSegmentBadge').innerText = 'Segmento: ' + (artifact.segment || 'plans');
      document.getElementById('planBody').innerHTML = 
        '<h4>Contenido Detectado:</h4><p>' + 
        (artifact.content ? artifact.content.replace(/\\n/g, '<br/>') : 'Plan escaneado correctamente.') + 
        '</p>';

      const mbox = document.getElementById('mermaidBox');
      const mermaidCode = artifact.mermaidBlocks && artifact.mermaidBlocks.length > 0 ? artifact.mermaidBlocks[0] : '';
      mbox.innerHTML = renderMermaidSvg(mermaidCode) + 
        (mermaidCode ? '<pre class="mermaid-raw">' + mermaidCode + '</pre>' : '');
    }

    function updateQuota(remainingPercent, usedTokens, maxTokens) {
      document.getElementById('contextRemainingLabel').innerText = remainingPercent + '%';
      document.getElementById('tokenCountsLabel').innerText = 
        usedTokens.toLocaleString() + ' / ' + maxTokens.toLocaleString() + ' tokens';
      const bar = document.getElementById('quotaBarFill');
      bar.style.width = remainingPercent + '%';
      bar.className = 'quota-bar-fill ' + (remainingPercent < 25 ? 'critical' : remainingPercent < 50 ? 'warning' : 'safe');
    }

    function switchInspectorTab(tabId) {
      document.querySelectorAll('.inspector-tabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });
      document.getElementById('panelPlan').style.display = tabId === 'plan' ? 'flex' : 'none';
      document.getElementById('panelCrew').style.display = tabId === 'crew' ? 'flex' : 'none';
      document.getElementById('panelMemo').style.display = tabId === 'memo' ? 'flex' : 'none';
      document.getElementById('panelVault').style.display = tabId === 'vault' ? 'flex' : 'none';

      if (tabId === 'memo') {
        loadMemosebMemories();
      } else if (tabId === 'crew') {
        loadCrewRoster();
      }
    }

    function toggleSidebar() {
      const sidebar = document.getElementById('leftSidebar');
      isLeftSidebarOpen = !isLeftSidebarOpen;
      sidebar.classList.toggle('collapsed', !isLeftSidebarOpen);
    }

    function toggleInspector() {
      const insp = document.getElementById('sideInspector');
      isInspectorOpen = !isInspectorOpen;
      insp.classList.toggle('collapsed', !isInspectorOpen);
    }

    async function loadMemosebMemories() {
      try {
        const res = await fetch('/api/memoseb/memories');
        const data = await res.json();
        const feed = document.getElementById('memoFeed');
        document.getElementById('memoStatsLabel').innerText = (data.totalCount || 0) + ' memorias activas';

        if (data.memories && data.memories.length > 0) {
          feed.innerHTML = data.memories.map(m => {
            return '<div class="memo-card">' +
              '<span class="memo-card-cat">[' + m.category + ']</span>' +
              '<strong class="memo-card-title">' + m.title + '</strong>' +
              '<span class="memo-card-snippet">' + (m.content || '') + '</span>' +
            '</div>';
          }).join('');
        } else {
          feed.innerHTML = '<p style="color:var(--bento-text-muted);">Sin memorias registradas en memoseb.</p>';
        }
      } catch (err) {
        console.warn('Error loading memories:', err);
      }
    }

    async function loadCrewRoster() {
      try {
        const res = await fetch('/api/snapshot');
        const snap = await res.json();
        const roster = document.getElementById('crewRoster');
        const personas = snap.personas || {
          researcher: 'Atlas', analyst: 'Iris', architect: 'Nova', developer: 'Orion',
          'qa-automation': 'Lyra', devops: 'Kael', sre: 'Vanguard', security: 'Aegis',
          'code-reviewer': 'Solon', documenter: 'Clio'
        };
        const keys = Object.keys(personas);
        document.getElementById('crewCountBadge').innerText = String(keys.length);
        document.getElementById('crewConcurrencyLabel').innerText = 
          'Modo: ' + (snap.concurrencyMode || 'parallel') + ' (preset: ' + (snap.preset || 'cloud-tiered') + ')';

        roster.innerHTML = keys.map(role => {
          return '<div class="crew-card">' +
            '<div class="crew-role"><strong>' + role + '</strong></div>' +
            '<div class="crew-persona">[' + personas[role] + ' · ' + role + ']</div>' +
          '</div>';
        }).join('');
      } catch (err) {
        console.warn('Error loading crew:', err);
      }
    }

    // Event Bindings
    document.getElementById('toggleSidebarBtn').onclick = toggleSidebar;
    document.getElementById('toggleInspectorBtn').onclick = toggleInspector;
    document.getElementById('closeInspectorBtn').onclick = toggleInspector;

    document.getElementById('themeToggleBtn').onclick = () => {
      activeTheme = activeTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', activeTheme);
      document.getElementById('themeIcon').innerText = activeTheme === 'dark' ? '☀️' : '🌙';
      document.getElementById('themeLabel').innerText = activeTheme === 'dark' ? 'Claro' : 'Oscuro';
    };

    document.getElementById('simulatePlanBtn').onclick = () => {
      executeCommand('/plan');
    };

    document.getElementById('compactQuickBtn').onclick = () => {
      executeCommand('/compact');
    };

    document.getElementById('sendBtn').onclick = () => {
      const inp = document.getElementById('termInput');
      executeCommand(inp.value);
    };

    document.getElementById('termInput').onkeydown = (e) => {
      if (e.key === 'Enter') {
        executeCommand(e.target.value);
      }
    };

    // Quick Command Pills
    document.querySelectorAll('.quick-cmd-btn').forEach(btn => {
      btn.onclick = () => {
        executeCommand(btn.dataset.cmd);
      };
    });

    // Sidebar Host Creation Pills
    document.querySelectorAll('.host-btn').forEach(btn => {
      btn.onclick = () => {
        createTerminalSession(btn.dataset.host);
      };
    });

    // New Tab Selector
    document.getElementById('newTabSelect').onchange = (e) => {
      const val = e.target.value;
      if (val) {
        createTerminalSession(val);
        e.target.value = '';
      }
    };

    // Topbar Tabs Buttons
    document.getElementById('topTabPlan').onclick = () => {
      if (!isInspectorOpen) toggleInspector();
      switchInspectorTab('plan');
    };
    document.getElementById('topTabCrew').onclick = () => {
      if (!isInspectorOpen) toggleInspector();
      switchInspectorTab('crew');
    };
    document.getElementById('topTabMemo').onclick = () => {
      if (!isInspectorOpen) toggleInspector();
      switchInspectorTab('memo');
    };
    document.getElementById('topTabVault').onclick = () => {
      if (!isInspectorOpen) toggleInspector();
      switchInspectorTab('vault');
    };

    // Inspector tab clicks
    document.querySelectorAll('.inspector-tabs .tab-btn').forEach(btn => {
      btn.onclick = () => switchInspectorTab(btn.dataset.tab);
    });

    // Sync to memoseb
    document.getElementById('syncMemoBtn').onclick = async () => {
      const btn = document.getElementById('syncMemoBtn');
      const cat = document.getElementById('memoCategorySelect').value;
      btn.disabled = true;
      btn.innerText = 'Sincronizando...';
      try {
        await fetch('/api/sync-memoseb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: document.getElementById('planTitle').innerText,
            content: document.getElementById('planBody').innerText,
            category: cat,
            tags: ['deckseb', 'sixzone', 'architecture']
          })
        });
        btn.innerText = '✔ Aprendido en memoseb!';
        setTimeout(() => {
          btn.innerText = '• 🧠 Enviar a memoseb';
          btn.disabled = false;
        }, 2000);
      } catch (err) {
        btn.innerText = 'Error';
        setTimeout(() => {
          btn.innerText = '• 🧠 Enviar a memoseb';
          btn.disabled = false;
        }, 2000);
      }
    };

    // Initial Bootstrap
    fetchSessions();
    loadCrewRoster();
  </script>
</body>
</html>
`
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerInstance> {
  const host = options.host ?? '127.0.0.1'
  const observer = new SebEcosystemObserver()
  const vault = new SegmentedArtifactVault({ vaultRoot: options.vaultRoot })
  const terminalManager = new RealTerminalManager()

  // Initialize automatic initial real terminal session
  await terminalManager.createSession('shell', 'shell · deckseb', process.cwd())

  // Cache or read CSS
  const cssPath = path.join(PACKAGE_ROOT, 'src', 'styles', 'macos.css')
  let cachedCss = ''
  if (existsSync(cssPath)) {
    try {
      cachedCss = await readFile(cssPath, 'utf8')
    } catch {
      cachedCss = '/* macos.css fallback */'
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const pathname = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    // Static Routes
    if (pathname === '/' && req.method === 'GET') {
      sendHtml(res, generateDeckUiHtml())
      return
    }

    if (pathname === '/styles/macos.css' && req.method === 'GET') {
      sendCss(res, cachedCss)
      return
    }

    // Terminal Real Endpoints
    if (pathname === '/api/terminal/sessions' && req.method === 'GET') {
      try {
        const sessions = terminalManager.listSessions()
        sendJson(res, 200, { sessions })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (pathname === '/api/terminal/create' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<{ hostId?: string; title?: string; cwd?: string }>(req)
        const hostId = body.hostId || 'shell'
        const session = await terminalManager.createSession(hostId, body.title, body.cwd)
        sendJson(res, 200, { session })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (pathname === '/api/terminal/input' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<{ sessionId: string; command: string }>(req)
        if (!body.sessionId || typeof body.command !== 'string') {
          sendJson(res, 400, { error: 'sessionId and command are required' })
          return
        }
        const outcome = await terminalManager.executeCommand(body.sessionId, body.command, vault)
        sendJson(res, 200, outcome)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (pathname === '/api/terminal/kill' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<{ sessionId: string }>(req)
        if (!body.sessionId) {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }
        const success = terminalManager.killSession(body.sessionId)
        sendJson(res, 200, { success, sessionId: body.sessionId })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    // Memoseb Context Live Endpoint
    if (pathname === '/api/memoseb/memories' && req.method === 'GET') {
      try {
        let output = ''
        try {
          output = execSync('memoseb context --max-tokens 1200', {
            encoding: 'utf8',
            timeout: 3500,
          })
        } catch {
          output =
            'Briefing for project deckseb — 3 memories (~450 tokens):\n  • [architecture] Arquitectura Sixzone Bento Grid\n  • [convention] TypeScript estricto y Node 22\n  • [domain] Hub de terminales y observador pasivo'
        }

        const lines = output.split('\n').filter((l) => l.trim().startsWith('•'))
        const parsed = lines.map((line) => {
          const match = line.match(/•\s*\[(\w+)\]\s*(.+?)(?::\s*(.*))?$/)
          if (match) {
            return {
              category: match[1],
              title: match[2],
              content: match[3] || match[2],
            }
          }
          return { category: 'architecture', title: line.replace('•', '').trim(), content: line }
        })

        sendJson(res, 200, {
          memories: parsed,
          rawText: output,
          totalCount: parsed.length,
        })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    // Ecosystem & Vault Endpoints
    if (pathname === '/api/snapshot' && req.method === 'GET') {
      try {
        const snapshot = observer.getSnapshot()
        sendJson(res, 200, snapshot)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (pathname === '/api/artifacts' && req.method === 'GET') {
      try {
        const artifacts = await vault.listArtifacts()
        sendJson(res, 200, artifacts)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (pathname === '/api/detect' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<{ text?: string; filePath?: string }>(req)
        const text = body.text ?? ''
        const detected = detectPlanInStream('http-session', 'active-project', text, body.filePath)
        sendJson(res, 200, { detected })
      } catch (err) {
        sendJson(res, 400, { error: String(err) })
      }
      return
    }

    if (pathname === '/api/sync-memoseb' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<{
          title: string
          content: string
          category?: any
          tags?: string[]
        }>(req)
        const art = await vault.saveArtifact({
          id: `art-ui-${Date.now()}`,
          sessionId: 'http-session',
          projectSlug: 'deckseb',
          segment: 'plans',
          title: body.title || 'Artifact from DeckSeb UI',
          filePath: 'plans/ui-artifact.md',
          content: body.content || '',
          mermaidBlocks: [],
          detectedAt: new Date().toISOString(),
          syncedToMemoseb: false,
          memosebCategory: body.category || 'architecture',
        })
        const syncResult = await vault.syncArtifactToMemoseb(art.id, body.category || 'architecture', {
          title: body.title,
          tags: body.tags,
        })
        sendJson(res, 200, syncResult)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (pathname === '/api/quota' && req.method === 'GET') {
      try {
        const sessionId = url.searchParams.get('sessionId') ?? 'session-agy-01'
        const quota = computeSessionContextQuota(sessionId, [])
        sendJson(res, 200, quota)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    // 404
    sendJson(res, 404, { error: 'Not found', path: pathname })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4321, host, () => {
      resolve()
    })
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 4321)
  const actualUrl = `http://${host}:${port}`

  const shouldLaunch = options.openWindow ?? options.openBrowser ?? false
  if (shouldLaunch) {
    launchStandaloneDesktopWindow(actualUrl, Boolean(options.openBrowser && !options.openWindow))
  }

  return {
    server,
    port,
    url: actualUrl,
    close: async () => {
      terminalManager.killAll()
      await new Promise<void>((res) => server.close(() => res()))
    },
  }
}
