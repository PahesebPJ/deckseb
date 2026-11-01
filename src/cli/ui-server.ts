import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { SebEcosystemObserver } from '../core/ecosystem-observer.ts'
import { detectPlanInStream } from '../core/plan-detector.ts'
import { SegmentedArtifactVault } from '../core/segmented-vault.ts'
import { computeSessionContextQuota } from '../core/transcript-monitor.ts'
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

  const appArgs = [`--app=${url}`, '--window-size=1280,820', '--class=deckseb']

  if (process.platform === 'linux') {
    const candidates = ['chromium', 'google-chrome', 'google-chrome-stable', 'brave', 'microsoft-edge']
    for (const bin of candidates) {
      try {
        const p = execFile(bin, appArgs, () => {})
        if (p.pid) return
      } catch {
        // try next candidate
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

  // Fallback
  execFile('xdg-open', [url], () => {})
}

export interface UiServerInstance {
  server: http.Server
  port: number
  url: string
  close: () => Promise<void>
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
    /* Inline base fallbacks */
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--mac-bg-window, #1e1e1e);
      color: var(--mac-text-primary, #ffffff);
      overflow: hidden;
      height: 100vh;
    }
  </style>
</head>
<body>
  <div class="mac-window">
    <!-- Titlebar style macOS -->
    <header class="mac-titlebar">
      <div class="traffic-lights">
        <span class="traffic-light close" title="Cerrar"></span>
        <span class="traffic-light minimize" title="Minimizar"></span>
        <span class="traffic-light maximize" title="Maximizar"></span>
      </div>

      <div class="titlebar-center">
        <span class="app-badge">deckseb v${VERSION}</span>
        <span class="divider">/</span>
        <span class="window-title" id="activeHostLabel">antigravity (Gemini CLI)</span>
        <span class="status-indicator live" id="livePill" title="Conexión en vivo"></span>
      </div>

      <div class="titlebar-actions">
        <button class="mac-btn secondary" id="themeToggleBtn" title="Alternar Modo Claro / Oscuro">
          <span id="themeIcon">☀️</span> <span id="themeLabel">Claro</span>
        </button>
        <button class="mac-btn primary" id="simulatePlanBtn" title="Detectar y Abrir Plan">
          <span>📋 Abrir Plan</span>
        </button>
      </div>
    </header>

    <!-- Workspace -->
    <main class="mac-workspace">
      <!-- Terminal Viewport -->
      <section class="terminal-container">
        <div class="terminal-header">
          <div class="tabs-list" id="tabsContainer">
            <!-- Tabs dynamically injected -->
          </div>
          <div class="terminal-actions">
            <select id="newTabSelect" class="mac-select">
              <option value="" disabled selected>+ Nuevo Agente...</option>
              <option value="antigravity">antigravity (Gemini CLI)</option>
              <option value="claude">claude (Claude Code)</option>
              <option value="codex">codex (OpenAI)</option>
              <option value="opencode">opencode</option>
              <option value="herdr">herdr</option>
              <option value="shell">shell (Terminal local)</option>
            </select>
          </div>
        </div>

        <div class="terminal-body" id="termOutput">
          <!-- Terminal stream -->
        </div>

        <div class="terminal-prompt-bar">
          <span class="prompt-symbol">❯</span>
          <input type="text" id="termInput" class="terminal-input" placeholder="Escribe un comando (/plan, /compact, crewseb models list, memoseb context)..." autofocus />
          <button id="sendBtn" class="mac-btn secondary">Enviar</button>
        </div>
      </section>

      <!-- Side Inspector (Drawer) -->
      <aside class="mac-inspector" id="sideInspector">
        <div class="inspector-tabs">
          <button class="tab-btn active" data-tab="plan">📋 Plan & Diagramas</button>
          <button class="tab-btn" data-tab="crew">👥 crewseb (<span id="crewCountBadge">0</span>)</button>
          <button class="tab-btn" data-tab="memo">🧠 memoseb</button>
          <button class="tab-btn" data-tab="vault">📁 Bóveda</button>
        </div>

        <div class="inspector-content" id="inspectorContent">
          <!-- Panels dynamically displayed -->
          <div class="panel-view" id="panelPlan">
            <div class="panel-header">
              <h3 id="planTitle">Plan de Implementación Activo</h3>
              <div class="header-tags" id="planSegmentBadge">Segmento: plans</div>
            </div>
            <div class="plan-markdown" id="planBody">
              <p>Esperando la generación de un plan o diagrama por el agente...</p>
            </div>
            <div class="mermaid-preview-container">
              <h4>Visualización de Diagrama Mermaid</h4>
              <div class="mermaid-diagram-box" id="mermaidBox">
                <!-- Mermaid box -->
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
              <button class="mac-btn primary" id="syncMemoBtn">🧠 Enviar a memoseb</button>
            </div>
          </div>

          <div class="panel-view" id="panelCrew" style="display: none;">
            <div class="panel-header">
              <h3>Tripulación crewseb</h3>
              <span class="concurrency-badge" id="crewConcurrencyLabel">Modo: parallel</span>
            </div>
            <div class="crew-roster" id="crewRoster">
              <!-- Crew specialists list -->
            </div>
          </div>

          <div class="panel-view" id="panelMemo" style="display: none;">
            <div class="panel-header">
              <h3>Bóveda memoseb</h3>
              <span class="vault-stats-badge" id="memoStatsLabel">0 memorias</span>
            </div>
            <div class="memo-feed" id="memoFeed">
              <!-- Memo events list -->
            </div>
          </div>

          <div class="panel-view" id="panelVault" style="display: none;">
            <div class="panel-header">
              <h3>Carpetas Segmentadas (.seb-vault)</h3>
            </div>
            <div class="vault-tree" id="vaultTree">
              <div class="segment-folder">📁 plans/</div>
              <div class="segment-folder">📁 diagrams/</div>
              <div class="segment-folder">📁 specs/</div>
              <div class="segment-folder">📁 reviews/</div>
              <div class="segment-folder">📁 post-mortems/</div>
            </div>
          </div>
        </div>
      </aside>
    </main>

    <!-- Bottom Telemetry Bar -->
    <footer class="mac-statusbar">
      <div class="status-left">
        <span class="status-pill safe" id="optionalModeBadge">✓ 100% Opcional • Observador Pasivo</span>
        <span class="status-text" id="activeProjectSlug">proyecto: deckseb</span>
      </div>

      <div class="status-center">
        <div class="quota-meter-container">
          <div class="quota-meter-labels">
            <span>Contexto Restante: <strong id="contextRemainingLabel">82%</strong></span>
            <span id="tokenCountsLabel">36,000 / 200,000 tokens</span>
          </div>
          <div class="quota-bar-track">
            <div class="quota-bar-fill safe" id="quotaBarFill" style="width: 82%;"></div>
          </div>
        </div>
      </div>

      <div class="status-right">
        <button class="mac-btn compact-btn" id="compactQuickBtn" title="Inyectar /compact en la sesión activa">
          ⚡ /compact
        </button>
      </div>
    </footer>
  </div>

  <script>
    // Client state
    let activeTheme = 'dark';
    let activeSession = 'session-agy-01';
    let sessions = [
      { id: 'session-agy-01', title: 'antigravity · deckseb', hostId: 'antigravity' },
      { id: 'session-claude-02', title: 'claude · crewseb', hostId: 'claude' }
    ];
    let terminalHistories = {
      'session-agy-01': [
        '\\x1b[1;34m[deckseb]\\x1b[0m Tactical Terminal Deck initialized on \\x1b[1mantigravity (Gemini CLI)\\x1b[0m',
        '\\x1b[32m✔ hubseb ecosystem connected:\\x1b[0m crewseb (10 roles), memoseb (FTS5 vault), herdr',
        '\\x1b[90mTip: Type /plan, /compact, crewseb models list, or memoseb context\\x1b[0m',
        'agy:~/Documents/projects/deckseb$ git status',
        'On branch develop',
        'nothing to commit, working tree clean'
      ],
      'session-claude-02': [
        '\\x1b[1;35m[claude-code]\\x1b[0m Claude Code 3.7 Sonnet session active in /projects/crewseb',
        'Ready for autonomous task execution.'
      ]
    };

    // Render helpers
    function renderTabs() {
      const container = document.getElementById('tabsContainer');
      container.innerHTML = '';
      sessions.forEach(s => {
        const tab = document.createElement('div');
        tab.className = 'terminal-tab ' + (s.id === activeSession ? 'active' : '');
        tab.innerHTML = '<span class="tab-dot ' + s.hostId + '"></span>' +
                        '<span class="tab-title">' + s.title + '</span>' +
                        '<span class="tab-close" data-id="' + s.id + '">×</span>';
        tab.onclick = (e) => {
          if (e.target.classList.contains('tab-close')) {
            e.stopPropagation();
            closeSession(s.id);
            return;
          }
          activeSession = s.id;
          document.getElementById('activeHostLabel').innerText = s.title;
          renderTabs();
          renderTerminal();
        };
        container.appendChild(tab);
      });
    }

    function renderTerminal() {
      const term = document.getElementById('termOutput');
      const lines = terminalHistories[activeSession] || [];
      term.innerHTML = lines.map(line => {
        let clean = line
          .replace(/\\x1b\\[1;34m/g, '<span style="color:#60a5fa;font-weight:bold;">')
          .replace(/\\x1b\\[1;35m/g, '<span style="color:#c084fc;font-weight:bold;">')
          .replace(/\\x1b\\[32m/g, '<span style="color:#4ade80;">')
          .replace(/\\x1b\\[36m/g, '<span style="color:#22d3ee;">')
          .replace(/\\x1b\\[90m/g, '<span style="color:#94a3b8;">')
          .replace(/\\x1b\\[1m/g, '<span style="font-weight:bold;">')
          .replace(/\\x1b\\[0m/g, '</span>');
        return '<div class="terminal-line">' + clean + '</div>';
      }).join('');
      term.scrollTop = term.scrollHeight;
    }

    function closeSession(id) {
      if (sessions.length <= 1) return;
      sessions = sessions.filter(s => s.id !== id);
      delete terminalHistories[id];
      if (activeSession === id) {
        activeSession = sessions[0].id;
      }
      renderTabs();
      renderTerminal();
    }

    // Command handling
    async function executeCommand(cmd) {
      if (!cmd.trim()) return;
      if (!terminalHistories[activeSession]) terminalHistories[activeSession] = [];
      terminalHistories[activeSession].push('❯ ' + cmd);

      const trimmed = cmd.trim();
      if (trimmed === '/plan' || trimmed.startsWith('/plan ')) {
        terminalHistories[activeSession].push('\\x1b[32m✔ Plan de arquitectura detectado! Desplegando Inspector Lateral...\\x1b[0m');
        triggerPlanView(
          'Plan: Interfaz Táctica macOS Sequoia para deckseb',
          'plans',
          '# Arquitectura de Mando DeckSeb\\n\\n1. Multiplexor de terminales con PTY nativo\\n2. Auto-despliegue de diagramas Mermaid\\n3. Sincronización post-desarrollo con memoseb',
          ['flowchart LR\\n  CLI[Ecosistema *seb] --> Hub[hubseb]\\n  Hub --> Crew[crewseb 10 roles]\\n  Hub --> Memo[memoseb vault]\\n  Deck[deckseb UI] -.->|Observador| Hub']
        );
      } else if (trimmed === '/compact') {
        terminalHistories[activeSession].push('\\x1b[32m✔ Contexto compactado exitosamente. Capacidad libre: 92%\\x1b[0m');
        updateQuota(92, 16000, 200000);
      } else if (trimmed === 'crewseb models list') {
        terminalHistories[activeSession].push('Configuración de modelos de crewseb (preset: cloud-tiered):');
        terminalHistories[activeSession].push('  🔍 researcher [balanced] | 🏛️ architect [deep] | 🛠️ developer [deep]');
        terminalHistories[activeSession].push('  🧪 qa-automation [balanced] | 👁️ code-reviewer [deep] | 📚 documenter [balanced]');
      } else if (trimmed === 'memoseb context') {
        terminalHistories[activeSession].push('\\x1b[36mBriefing for project deckseb (3 memories, ~458 tokens):\\x1b[0m');
        terminalHistories[activeSession].push('  • [architecture] Arquitectura y topología de deckseb');
        terminalHistories[activeSession].push('  • [convention] Convenciones, scripts y verificación');
        terminalHistories[activeSession].push('  • [domain] Propósito funcional y dominio');
      } else {
        // Echo
        terminalHistories[activeSession].push('Ejecutado: ' + cmd);
      }
      renderTerminal();
    }

    function triggerPlanView(title, segment, body, mermaidBlocks) {
      document.getElementById('planTitle').innerText = title;
      document.getElementById('planSegmentBadge').innerText = 'Segmento: ' + segment;
      document.getElementById('planBody').innerHTML = '<h4>Contenido del Plan:</h4><p>' + body.replace(/\\n/g, '<br/>') + '</p>';

      const mbox = document.getElementById('mermaidBox');
      if (mermaidBlocks && mermaidBlocks.length > 0) {
        mbox.innerHTML = '<div class="diagram-render-preview">' +
          '<div class="diagram-node active">Ecosistema *seb</div> ➜ ' +
          '<div class="diagram-node">hubseb / crewseb</div> ➜ ' +
          '<div class="diagram-node">memoseb vault</div>' +
          '<pre class="mermaid-raw">' + mermaidBlocks[0] + '</pre></div>';
      } else {
        mbox.innerHTML = '<p class="muted">Sin bloques de diagrama Mermaid.</p>';
      }

      // Switch to plan tab
      switchInspectorTab('plan');
    }

    function updateQuota(remainingPercent, usedTokens, maxTokens) {
      document.getElementById('contextRemainingLabel').innerText = remainingPercent + '%';
      document.getElementById('tokenCountsLabel').innerText = usedTokens.toLocaleString() + ' / ' + maxTokens.toLocaleString() + ' tokens';
      const bar = document.getElementById('quotaBarFill');
      bar.style.width = remainingPercent + '%';
      bar.className = 'quota-bar-fill ' + (remainingPercent < 25 ? 'critical' : remainingPercent < 50 ? 'warning' : 'safe');
    }

    function switchInspectorTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });
      document.getElementById('panelPlan').style.display = tabId === 'plan' ? 'block' : 'none';
      document.getElementById('panelCrew').style.display = tabId === 'crew' ? 'block' : 'none';
      document.getElementById('panelMemo').style.display = tabId === 'memo' ? 'block' : 'none';
      document.getElementById('panelVault').style.display = tabId === 'vault' ? 'block' : 'none';
    }

    // Event listeners
    document.getElementById('themeToggleBtn').onclick = () => {
      activeTheme = activeTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', activeTheme);
      document.getElementById('themeIcon').innerText = activeTheme === 'dark' ? '☀️' : '🌙';
      document.getElementById('themeLabel').innerText = activeTheme === 'dark' ? 'Claro' : 'Oscuro';
    };

    document.getElementById('simulatePlanBtn').onclick = () => {
      executeCommand('/plan Arquitectura macOS');
    };

    document.getElementById('compactQuickBtn').onclick = () => {
      executeCommand('/compact');
    };

    document.getElementById('sendBtn').onclick = () => {
      const inp = document.getElementById('termInput');
      executeCommand(inp.value);
      inp.value = '';
    };

    document.getElementById('termInput').onkeydown = (e) => {
      if (e.key === 'Enter') {
        executeCommand(e.target.value);
        e.target.value = '';
      }
    };

    document.getElementById('newTabSelect').onchange = (e) => {
      const val = e.target.value;
      if (!val) return;
      const newId = 'session-' + val + '-' + String(Date.now()).slice(-4);
      sessions.push({ id: newId, title: val + ' · session', hostId: val });
      terminalHistories[newId] = [
        '[' + val + '] Nueva sesión interactiva iniciada en ' + val,
        'Listo.'
      ];
      activeSession = newId;
      document.getElementById('activeHostLabel').innerText = val + ' · session';
      e.target.value = '';
      renderTabs();
      renderTerminal();
    };

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => switchInspectorTab(btn.dataset.tab);
    });

    document.getElementById('syncMemoBtn').onclick = async () => {
      const cat = document.getElementById('memoCategorySelect').value;
      const btn = document.getElementById('syncMemoBtn');
      btn.disabled = true;
      btn.innerText = 'Sincronizando...';
      try {
        const res = await fetch('/api/sync-memoseb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: document.getElementById('planTitle').innerText,
            content: document.getElementById('planBody').innerText,
            category: cat,
            tags: ['deckseb', 'architecture', 'plans']
          })
        });
        const data = await res.json();
        btn.innerText = '✔ Aprendido en memoseb!';
        setTimeout(() => {
          btn.innerText = '🧠 Enviar a memoseb';
          btn.disabled = false;
        }, 2000);
      } catch (err) {
        btn.innerText = 'Error';
        setTimeout(() => {
          btn.innerText = '🧠 Enviar a memoseb';
          btn.disabled = false;
        }, 2000);
      }
    };

    // Initial load from backend API
    async function initFromApi() {
      try {
        const res = await fetch('/api/snapshot');
        const snap = await res.json();
        if (snap.crewsebDetected) {
          const roster = document.getElementById('crewRoster');
          const personas = snap.personas || {};
          const keys = Object.keys(personas);
          document.getElementById('crewCountBadge').innerText = String(keys.length);
          document.getElementById('crewConcurrencyLabel').innerText = 'Modo: ' + (snap.concurrencyMode || 'parallel') + ' (preset: ' + (snap.preset || 'cloud-tiered') + ')';
          roster.innerHTML = keys.map(role => {
            return '<div class="crew-card">' +
              '<div class="crew-role"><strong>' + role + '</strong></div>' +
              '<div class="crew-persona">[' + personas[role] + ' · ' + role + ']</div>' +
            '</div>';
          }).join('');
        }
        if (snap.vaultStats) {
          document.getElementById('memoStatsLabel').innerText = snap.vaultStats.memoryCount + ' memorias (~' + snap.vaultStats.totalTokens + ' tokens)';
        }
      } catch (err) {
        console.warn('API snapshot fallback mode:', err);
      }
    }

    renderTabs();
    renderTerminal();
    initFromApi();
  </script>
</body>
</html>
`
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerInstance> {
  const host = options.host ?? '127.0.0.1'
  const observer = new SebEcosystemObserver()
  const vault = new SegmentedArtifactVault({ vaultRoot: options.vaultRoot })

  // Read or fallback CSS
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

    // API Routes
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
        const body = await parseJsonBody<{ title: string; content: string; category?: any; tags?: string[] }>(req)
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
      await new Promise<void>((res) => server.close(() => res()))
    },
  }
}
