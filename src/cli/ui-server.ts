import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  classifyArtifactSegment,
  detectPlanInStream,
  extractMermaidBlocks,
  slugifyTitle,
} from '../core/plan-detector.ts'
import { SegmentedArtifactVault } from '../core/segmented-vault.ts'
import type { DetectedArtifact } from '../types/deck.ts'
import { BUNDLE_ID, PACKAGE_ROOT, VERSION } from '../version.ts'

export interface UiServerOptions {
  port?: number
  host?: string
  openBrowser?: boolean
  openWindow?: boolean
  autoOpenOnPlan?: boolean
  initialPlanFile?: string
  watchDirs?: string[]
  vaultRoot?: string
  homeDir?: string
  disableAutoPoll?: boolean
}

export interface UiServerInstance {
  server: http.Server
  port: number
  url: string
  close: () => Promise<void>
  publishPlan: (
    artifact: DetectedArtifact,
    eventType?: 'plan:created' | 'plan:updated',
    silent?: boolean
  ) => Promise<void>
  getPlans: () => DetectedArtifact[]
  getActivePlan: () => DetectedArtifact | null
}

export function launchStandaloneDesktopWindow(
  url: string,
  forceBrowser = false
): void {
  if (forceBrowser) {
    const cmd =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'start'
          : 'xdg-open'
    execFile(cmd, [url], () => {})
    return
  }

  const appArgs = [
    `--app=${url}`,
    '--window-size=1080,860',
    '--class=deckseb',
  ]

  if (process.platform === 'linux') {
    const candidates = [
      'chromium',
      'google-chrome',
      'google-chrome-stable',
      'brave',
      'microsoft-edge',
    ]
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
      } catch {
        // try next candidate
      }
    }
    execFile('start', [url], () => {})
    return
  }

  execFile('xdg-open', [url], () => {})
}

export function generateDeckUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="es" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>deckseb — Visor Editorial de Planes</title>
  <link rel="stylesheet" href="/styles/macos.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🪐</text></svg>">
</head>
<body>
  <div class="plan-shell">
    <header class="plan-topbar">
      <div class="topbar-left">
        <div class="traffic-lights">
          <span class="traffic-light close" title="Cerrar"></span>
          <span class="traffic-light minimize" title="Minimizar"></span>
          <span class="traffic-light maximize" title="Maximizar"></span>
        </div>
        <span class="brand-badge">deckseb</span>
        <span id="liveIndicator" class="live-indicator">
          <span id="liveDot" class="live-dot"></span>
          <span id="liveText">En vivo</span>
        </span>
      </div>

      <div class="topbar-right">
        <div class="plan-select-wrapper">
          <select id="planSelector" class="plan-select" aria-label="Seleccionar plan">
            <option value="" disabled selected>Esperando planes…</option>
          </select>
          <span class="plan-select-caret">▼</span>
        </div>
        <button id="themeToggleBtn" class="theme-toggle-btn" title="Alternar Modo Oscuro / Claro" aria-label="Alternar tema">
          <span id="themeIcon">☀️</span>
        </button>
      </div>
    </header>

    <main class="plan-reader">
      <div id="emptyState" class="plan-empty-state">
        <div class="plan-empty-icon">🪐</div>
        <h2 class="plan-empty-title">Esperando plan del modelo…</h2>
        <p class="plan-empty-desc">En cuanto el agente cree un plan de implementación, aparecerá aquí automáticamente con diagramas interactivos y matriz de tareas.</p>
      </div>

      <article id="planView" class="plan-view" style="display: none;">
        <header class="plan-header">
          <div class="plan-badges-row">
            <span id="planSegment" class="segment-badge">plans</span>
          </div>
          <h1 id="planTitle" class="plan-title">Título del Plan</h1>
          <div class="plan-meta-row">
            <span class="plan-meta-item" title="Ruta del archivo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              <span id="planPath">~</span>
            </span>
            <span class="plan-meta-item" title="Hora de actualización">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span id="planTimestamp">~</span>
            </span>
          </div>
        </header>

        <section id="planContent" class="plan-article"></section>
      </article>
    </main>
  </div>

  <script>
    (function() {
      // --- State ---
      let currentPlans = [];
      let activePlanId = null;

      const emptyStateEl = document.getElementById('emptyState');
      const planViewEl = document.getElementById('planView');
      const planSelector = document.getElementById('planSelector');
      const planSegmentEl = document.getElementById('planSegment');
      const planTitleEl = document.getElementById('planTitle');
      const planPathEl = document.getElementById('planPath');
      const planTimestampEl = document.getElementById('planTimestamp');
      const planContentEl = document.getElementById('planContent');
      const liveDot = document.getElementById('liveDot');
      const liveText = document.getElementById('liveText');
      const themeToggleBtn = document.getElementById('themeToggleBtn');
      const themeIcon = document.getElementById('themeIcon');

      // --- Theme Management ---
      function initTheme() {
        const saved = localStorage.getItem('deckseb-theme');
        const theme = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        applyTheme(theme);
      }

      function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('deckseb-theme', theme);
        if (themeIcon) {
          themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
        }
      }

      if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
          const current = document.documentElement.getAttribute('data-theme') || 'dark';
          applyTheme(current === 'dark' ? 'light' : 'dark');
        });
      }

      // --- Markdown & Mermaid Renderer in Pure JS ---
      function escapeHtml(str) {
        return (str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderInline(text) {
        let out = escapeHtml(text);
        // Code: inline code
        out = out.replace(new RegExp('\\x60([^\\x60]+)\\x60', 'g'), '<code>$1</code>');
        // Bold: **text** or __text__
        out = out.replace(/(\*\*|__)(.*?)\\1/g, '<strong>$2</strong>');
        // Italic: *text* or _text_
        out = out.replace(/(\*|_)(.*?)\\1/g, '<em>$2</em>');
        // Links: [text](url)
        out = out.replace(/\\[([^\\]]+)\\]\\(([^\\)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        return out;
      }

      // Lightweight Sugiyama/Layered Layout SVG Mermaid Flowchart Generator
      function renderMermaidSvg(code) {
        try {
          const lines = code.split('\\n').map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
          if (lines.length === 0) return null;

          const firstLine = lines[0].toLowerCase();
          const isFlow = firstLine.startsWith('flowchart') || firstLine.startsWith('graph');
          const isLR = firstLine.includes('lr');

          const nodes = new Map();
          const edges = [];

          function ensureNode(id, label) {
            if (!nodes.has(id)) {
              nodes.set(id, { id, label: label || id });
            } else if (label && nodes.get(id).label === id) {
              nodes.get(id).label = label;
            }
          }

          // Parse lines
          for (let i = (isFlow ? 1 : 0); i < lines.length; i++) {
            const line = lines[i];
            // Match edge patterns: A --> B, A -->|text| B, A -.-> B, A --- B, etc.
            const edgeMatch = line.match(/^([A-Za-z0-9_.-]+(?:\\[[^\\]]+\\]|\\([^\\)]+\\)|\\{\\{[^\\}]+\\}\\}|\\{[^\\}]+\\})?)\\s*(-->|-.->|---|==>)(?:\\|([^|]+)\\|)?\\s*([A-Za-z0-9_.-]+(?:\\[[^\\]]+\\]|\\([^\\)]+\\)|\\{\\{[^\\}]+\\}\\}|\\{[^\\}]+\\})?)/);
            if (edgeMatch) {
              const parseNodePart = (raw) => {
                const m = raw.match(/^([A-Za-z0-9_.-]+)(?:\\[\"?([^\"]+?)\"?\\]|\\(\"?([^\"]+?)\"?\\)|\\{\"?([^\"]+?)\"?\\})?$/);
                if (m) {
                  const id = m[1];
                  const label = m[2] || m[3] || m[4] || id;
                  return { id, label };
                }
                return { id: raw, label: raw };
              };

              const from = parseNodePart(edgeMatch[1]);
              const connector = edgeMatch[2];
              const edgeLabel = edgeMatch[3] || '';
              const to = parseNodePart(edgeMatch[4]);

              ensureNode(from.id, from.label);
              ensureNode(to.id, to.label);
              edges.push({ from: from.id, to: to.id, label: edgeLabel, style: connector });
            } else {
              // Standalone node definition: ID["Label"] or ID[Label]
              const nodeMatch = line.match(/^([A-Za-z0-9_.-]+)(?:\\[\"?([^\"]+?)\"?\\]|\\(\"?([^\"]+?)\"?\\)|\\{\"?([^\"]+?)\"?\\})$/);
              if (nodeMatch) {
                const id = nodeMatch[1];
                const label = nodeMatch[2] || nodeMatch[3] || nodeMatch[4] || id;
                ensureNode(id, label);
              }
            }
          }

          if (nodes.size === 0) return null;

          // Rank / Layer assignment
          const inDegree = new Map();
          for (const id of nodes.keys()) inDegree.set(id, 0);
          for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);

          const levels = new Map();
          const queue = [];
          for (const [id, deg] of inDegree.entries()) {
            if (deg === 0) {
              levels.set(id, 0);
              queue.push(id);
            }
          }
          if (queue.length === 0 && nodes.size > 0) {
            const firstId = nodes.keys().next().value;
            levels.set(firstId, 0);
            queue.push(firstId);
          }

          while (queue.length > 0) {
            const curr = queue.shift();
            const currLevel = levels.get(curr) || 0;
            for (const e of edges) {
              if (e.from === curr) {
                const nextLevel = currLevel + 1;
                if (!levels.has(e.to) || levels.get(e.to) < nextLevel) {
                  levels.set(e.to, nextLevel);
                  queue.push(e.to);
                }
              }
            }
          }

          // Fallback for disconnected nodes
          for (const id of nodes.keys()) {
            if (!levels.has(id)) levels.set(id, 0);
          }

          // Group by level
          const maxLevel = Math.max(0, ...Array.from(levels.values()));
          const layers = [];
          for (let i = 0; i <= maxLevel; i++) layers.push([]);
          for (const [id, lvl] of levels.entries()) {
            layers[lvl].push(nodes.get(id));
          }

          // Compute coordinates
          const nodeW = 160;
          const nodeH = 46;
          const gapX = isLR ? 80 : 36;
          const gapY = isLR ? 28 : 64;

          const coords = new Map();
          let totalW = 0;
          let totalH = 0;

          if (!isLR) {
            // TD / TB layout
            const layerWidths = layers.map(layer => layer.length * nodeW + Math.max(0, layer.length - 1) * gapX);
            const maxWidth = Math.max(400, ...layerWidths) + 80;
            totalW = maxWidth;
            totalH = layers.length * (nodeH + gapY) + 40;

            layers.forEach((layer, lvlIdx) => {
              const y = 30 + lvlIdx * (nodeH + gapY);
              const layerW = layer.length * nodeW + Math.max(0, layer.length - 1) * gapX;
              const startX = (maxWidth - layerW) / 2;
              layer.forEach((node, idx) => {
                const x = startX + idx * (nodeW + gapX);
                coords.set(node.id, { x, y, w: nodeW, h: nodeH, cx: x + nodeW / 2, cy: y + nodeH / 2 });
              });
            });
          } else {
            // LR layout
            const layerHeights = layers.map(layer => layer.length * nodeH + Math.max(0, layer.length - 1) * gapY);
            const maxHeight = Math.max(200, ...layerHeights) + 60;
            totalH = maxHeight;
            totalW = layers.length * (nodeW + gapX) + 80;

            layers.forEach((layer, lvlIdx) => {
              const x = 40 + lvlIdx * (nodeW + gapX);
              const layerH = layer.length * nodeH + Math.max(0, layer.length - 1) * gapY;
              const startY = (maxHeight - layerH) / 2;
              layer.forEach((node, idx) => {
                const y = startY + idx * (nodeH + gapY);
                coords.set(node.id, { x, y, w: nodeW, h: nodeH, cx: x + nodeW / 2, cy: y + nodeH / 2 });
              });
            });
          }

          // Build SVG elements
          let svgContent = '';
          const markerId = 'arrow-' + Math.random().toString(36).slice(2, 7);

          svgContent += '<defs>';
          svgContent += '<marker id="' + markerId + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">';
          svgContent += '<path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--svg-edge-arrow, #38bdf8)"/>';
          svgContent += '</marker>';
          svgContent += '</defs>';

          // Draw edges
          edges.forEach((e) => {
            const fromC = coords.get(e.from);
            const toC = coords.get(e.to);
            if (!fromC || !toC) return;

            let pathD = '';
            if (!isLR) {
              const startX = fromC.cx;
              const startY = fromC.y + fromC.h;
              const endX = toC.cx;
              const endY = toC.y;
              const midY = (startY + endY) / 2;
              pathD = 'M ' + startX + ' ' + startY + ' C ' + startX + ' ' + midY + ', ' + endX + ' ' + midY + ', ' + endX + ' ' + endY;
            } else {
              const startX = fromC.x + fromC.w;
              const startY = fromC.cy;
              const endX = toC.x;
              const endY = toC.cy;
              const midX = (startX + endX) / 2;
              pathD = 'M ' + startX + ' ' + startY + ' C ' + midX + ' ' + startY + ', ' + midX + ' ' + endY + ', ' + endX + ' ' + endY;
            }

            const strokeDash = e.style === '-.->' ? 'stroke-dasharray="4,4"' : '';
            svgContent += '<path d="' + pathD + '" fill="none" stroke="var(--svg-edge-stroke, #64748b)" stroke-width="2" ' + strokeDash + ' marker-end="url(#' + markerId + ')"/>';

            if (e.label) {
              const midX = (fromC.cx + toC.cx) / 2;
              const midY = (fromC.cy + toC.cy) / 2;
              svgContent += '<rect x="' + (midX - 24) + '" y="' + (midY - 9) + '" width="48" height="18" rx="4" fill="var(--bg-surface, #0f151d)" stroke="var(--border-subtle, rgba(255,255,255,0.1))"/>';
              svgContent += '<text x="' + midX + '" y="' + (midY + 4) + '" text-anchor="middle" font-size="10.5" fill="var(--text-muted, #94a3b8)" font-family="var(--mac-font-sans)">' + escapeHtml(e.label) + '</text>';
            }
          });

          // Draw nodes
          coords.forEach((pos, id) => {
            const node = nodes.get(id);
            const label = node ? node.label : id;
            svgContent += '<g class="mermaid-node" transform="translate(' + pos.x + ',' + pos.y + ')">';
            svgContent += '<rect width="' + pos.w + '" height="' + pos.h + '" rx="8" ry="8" fill="var(--svg-node-fill, #151d27)" stroke="var(--svg-node-stroke, #38bdf8)" stroke-width="1.6"/>';
            svgContent += '<text x="' + (pos.w / 2) + '" y="' + (pos.h / 2 + 4.5) + '" text-anchor="middle" fill="var(--svg-node-text, #f1f5f9)" font-size="12" font-weight="600" font-family="var(--mac-font-sans)">' + escapeHtml(label.length > 22 ? label.slice(0, 20) + '…' : label) + '</text>';
            svgContent += '</g>';
          });

          return '<svg viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" class="mermaid-svg" xmlns="http://www.w3.org/2000/svg">' + svgContent + '</svg>';
        } catch (err) {
          return null;
        }
      }

      function renderMarkdown(md) {
        if (!md || typeof md !== 'string') return '';
        const lines = md.replace(/\\r\\n/g, '\\n').split('\\n');
        let html = '';
        let i = 0;

        while (i < lines.length) {
          const line = lines[i];

          // 1. Fenced Code Block
          if (line.trim().startsWith('\x60\x60\x60')) {
            const fence = line.trim();
            const lang = fence.slice(3).trim();
            i++;
            const codeLines = [];
            while (i < lines.length && !lines[i].trim().startsWith('\x60\x60\x60')) {
              codeLines.push(lines[i]);
              i++;
            }
            i++; // skip closing fence
            const rawCode = codeLines.join('\\n');

            if (lang.toLowerCase() === 'mermaid') {
              const svg = renderMermaidSvg(rawCode);
              const cardId = 'mermaid-' + Math.random().toString(36).slice(2, 8);
              html += '<div class="mermaid-card" id="' + cardId + '">';
              html += '<div class="mermaid-header">';
              html += '<div class="mermaid-header-title">';
              html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/></svg>';
              html += '<span>Diagrama de Flujo</span>';
              html += '</div>';
              html += '<button type="button" class="mermaid-toggle-btn" onclick="toggleMermaidCode(\\'' + cardId + '\\')">Ver código</button>';
              html += '</div>';
              html += '<div class="mermaid-viewport">';
              if (svg) {
                html += svg;
              } else {
                html += '<pre style="margin:0;font-size:12px;color:var(--text-secondary);">' + escapeHtml(rawCode) + '</pre>';
              }
              html += '</div>';
              html += '<pre class="mermaid-raw"><code>' + escapeHtml(rawCode) + '</code></pre>';
              html += '</div>';
            } else {
              const displayLang = lang || 'text';
              html += '<div class="code-block">';
              html += '<div class="code-header">';
              html += '<span class="code-lang-tag">' + escapeHtml(displayLang) + '</span>';
              html += '<button class="code-copy-btn" onclick="copyCode(this)">Copiar</button>';
              html += '</div>';
              html += '<pre><code class="language-' + escapeHtml(displayLang) + '">' + escapeHtml(rawCode) + '</code></pre>';
              html += '</div>';
            }
            continue;
          }

          // 2. GitHub-style Alert: > [!NOTE], > [!IMPORTANT], etc.
          const alertMatch = line.match(/^>\\s*\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\]/i);
          if (alertMatch) {
            const type = alertMatch[1].toLowerCase();
            const alertLines = [];
            i++;
            while (i < lines.length && lines[i].startsWith('>')) {
              alertLines.push(lines[i].replace(/^>\\s?/, ''));
              i++;
            }
            const alertBody = alertLines.map(l => renderInline(l)).join('<br>');
            html += '<div class="gh-alert gh-alert-' + type + '">';
            html += '<div class="gh-alert-title">';
            html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
            html += '<span>' + type.toUpperCase() + '</span>';
            html += '</div>';
            html += '<div class="gh-alert-content">' + alertBody + '</div>';
            html += '</div>';
            continue;
          }

          // 3. Regular Blockquote
          if (line.startsWith('>')) {
            const bqLines = [];
            while (i < lines.length && lines[i].startsWith('>')) {
              bqLines.push(lines[i].replace(/^>\\s?/, ''));
              i++;
            }
            html += '<blockquote>' + bqLines.map(l => renderInline(l)).join('<br>') + '</blockquote>';
            continue;
          }

          // 4. Markdown Table
          if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && /\\|\\s*:?-+:?\\s*\\|/.test(lines[i + 1])) {
            const headerRow = line.split('|').map(c => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''));
            i += 2; // skip header and delimiter
            const bodyRows = [];
            while (i < lines.length && lines[i].includes('|')) {
              const row = lines[i].split('|').map(c => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''));
              if (row.length > 0) bodyRows.push(row);
              i++;
            }

            html += '<div class="plan-table-container"><table class="plan-table"><thead><tr>';
            headerRow.forEach(h => { html += '<th>' + renderInline(h) + '</th>'; });
            html += '</tr></thead><tbody>';
            bodyRows.forEach(row => {
              html += '<tr>';
              row.forEach(cell => { html += '<td>' + renderInline(cell) + '</td>'; });
              html += '</tr>';
            });
            html += '</tbody></table></div>';
            continue;
          }

          // 5. Headings: #, ##, ###, ####
          const h1 = line.match(/^#\\s+(.+)$/);
          if (h1) { html += '<h1>' + renderInline(h1[1]) + '</h1>'; i++; continue; }
          const h2 = line.match(/^##\\s+(.+)$/);
          if (h2) { html += '<h2>' + renderInline(h2[1]) + '</h2>'; i++; continue; }
          const h3 = line.match(/^###\\s+(.+)$/);
          if (h3) { html += '<h3>' + renderInline(h3[1]) + '</h3>'; i++; continue; }
          const h4 = line.match(/^####\\s+(.+)$/);
          if (h4) { html += '<h4>' + renderInline(h4[1]) + '</h4>'; i++; continue; }

          // 6. Horizontal Rule: --- or ***
          if (/^(\\-\\-\\-|\\*\\*\\*|___)$/.test(line.trim())) {
            html += '<hr>';
            i++;
            continue;
          }

          // 7. Checkboxes & Lists
          if (/^\\s*[-*]\\s+\\[([ xX])\\]\\s+(.+)$/.test(line)) {
            html += '<ul class="task-list">';
            while (i < lines.length) {
              const taskMatch = lines[i].match(/^\\s*[-*]\\s+\\[([ xX])\\]\\s+(.+)$/);
              if (!taskMatch) break;
              const checked = taskMatch[1].toLowerCase() === 'x';
              html += '<li class="task-list-item">';
              html += '<input type="checkbox" ' + (checked ? 'checked' : '') + ' disabled>';
              html += '<span>' + renderInline(taskMatch[2]) + '</span>';
              html += '</li>';
              i++;
            }
            html += '</ul>';
            continue;
          }

          // 8. Standard Unordered List
          if (/^\\s*[-*]\\s+(.+)$/.test(line)) {
            html += '<ul>';
            while (i < lines.length) {
              const liMatch = lines[i].match(/^\\s*[-*]\\s+(.+)$/);
              if (!liMatch || /^\s*[-*]\s+\[[ xX]\]/.test(lines[i])) break;
              html += '<li>' + renderInline(liMatch[1]) + '</li>';
              i++;
            }
            html += '</ul>';
            continue;
          }

          // 9. Ordered List
          if (/^\\s*\\d+\\.\\s+(.+)$/.test(line)) {
            html += '<ol>';
            while (i < lines.length) {
              const olMatch = lines[i].match(/^\\s*\\d+\\.\\s+(.+)$/);
              if (!olMatch) break;
              html += '<li>' + renderInline(olMatch[1]) + '</li>';
              i++;
            }
            html += '</ol>';
            continue;
          }

          // 10. Paragraph
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            html += '<p>' + renderInline(trimmed) + '</p>';
          }
          i++;
        }

        return html;
      }

      // --- Global Helpers for Interactivity ---
      window.toggleMermaidCode = function(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;
        const raw = card.querySelector('.mermaid-raw');
        const btn = card.querySelector('.mermaid-toggle-btn');
        if (raw && btn) {
          const isVisible = raw.classList.toggle('visible');
          btn.textContent = isVisible ? 'Ocultar código' : 'Ver código';
        }
      };

      window.copyCode = function(btn) {
        const pre = btn.closest('.code-block').querySelector('code');
        if (pre) {
          navigator.clipboard.writeText(pre.innerText).then(() => {
            const original = btn.textContent;
            btn.textContent = '¡Copiado!';
            setTimeout(() => { btn.textContent = original; }, 1500);
          });
        }
      };

      // --- Plan Display & Switcher ---
      function displayPlan(plan) {
        if (!plan) {
          emptyStateEl.style.display = 'flex';
          planViewEl.style.display = 'none';
          activePlanId = null;
          return;
        }

        activePlanId = plan.id;
        emptyStateEl.style.display = 'none';
        planViewEl.style.display = 'block';

        planSegmentEl.textContent = plan.segment || 'plans';
        planTitleEl.textContent = plan.title || 'Plan de Implementación';
        planPathEl.textContent = plan.filePath || '~';

        const dt = plan.detectedAt ? new Date(plan.detectedAt) : new Date();
        planTimestampEl.textContent = dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + dt.toLocaleDateString('es-ES');

        planContentEl.innerHTML = renderMarkdown(plan.content || '');
      }

      function updatePlanSelector(plans, activeId) {
        planSelector.innerHTML = '';
        if (!plans || plans.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.disabled = true;
          opt.selected = true;
          opt.textContent = 'Esperando planes…';
          planSelector.appendChild(opt);
          return;
        }

        plans.forEach((p, idx) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = (idx === 0 ? '● ' : '') + (p.title || 'Plan sin título');
          if (p.id === activeId) opt.selected = true;
          planSelector.appendChild(opt);
        });
      }

      planSelector.addEventListener('change', (e) => {
        const id = e.target.value;
        const target = currentPlans.find(p => p.id === id);
        if (target) displayPlan(target);
      });

      // --- Data Fetching & Server-Sent Events (SSE) ---
      function loadInitialPlans() {
        fetch('/api/plans')
          .then(res => res.json())
          .then(data => {
            currentPlans = Array.isArray(data.plans) ? data.plans : [];
            const active = data.activePlan || currentPlans[0] || null;
            updatePlanSelector(currentPlans, active ? active.id : null);
            displayPlan(active);
          })
          .catch(() => {
            // Server might still be initializing
          });
      }

      function connectEvents() {
        const es = new EventSource('/api/events');

        es.onopen = () => {
          liveDot.classList.remove('disconnected');
          liveText.textContent = 'En vivo';
        };

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'init') {
              currentPlans = Array.isArray(data.plans) ? data.plans : [];
              const active = data.activePlan || currentPlans[0] || null;
              updatePlanSelector(currentPlans, active ? active.id : null);
              displayPlan(active);
            } else if (data.type === 'plan:created' || data.type === 'plan:updated') {
              const art = data.artifact;
              const idx = currentPlans.findIndex(p => p.id === art.id || p.filePath === art.filePath);
              if (idx >= 0) {
                currentPlans[idx] = art;
              } else {
                currentPlans.unshift(art);
              }
              updatePlanSelector(currentPlans, art.id);
              displayPlan(art);
            }
          } catch (e) {
            console.error('Error handling SSE event:', e);
          }
        };

        es.onerror = () => {
          liveDot.classList.add('disconnected');
          liveText.textContent = 'Reconectando…';
        };
      }

      // Initialize
      initTheme();
      loadInitialPlans();
      connectEvents();
    })();
  </script>
</body>
</html>`
}

export async function startUiServer(
  options?: UiServerOptions
): Promise<UiServerInstance> {
  const port = options?.port ?? 4321
  const host = options?.host ?? '127.0.0.1'
  const autoOpenOnPlan = options?.autoOpenOnPlan ?? false
  const openWindow = options?.openWindow ?? false
  const openBrowser = options?.openBrowser ?? false

  const vault = new SegmentedArtifactVault({
    vaultRoot: options?.vaultRoot,
  })

  // In-memory state: synchronized with vault
  let memoryPlans: DetectedArtifact[] = []
  try {
    memoryPlans = await vault.listArtifacts({ segment: 'plans' })
    // Also include any diagrams if present
    const diagrams = await vault.listArtifacts({ segment: 'diagrams' })
    memoryPlans.push(...diagrams)
  } catch {
    memoryPlans = []
  }

  // Sort newest first
  memoryPlans.sort(
    (a, b) =>
      new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
  )

  let activePlan: DetectedArtifact | null = memoryPlans[0] || null
  const sseClients = new Set<http.ServerResponse>()
  let lastWindowOpenAt = 0
  let actualUrl = `http://${host}:${port}`

  // Function to broadcast and record plans
  const publishPlan = async (
    artifact: DetectedArtifact,
    eventType: 'plan:created' | 'plan:updated' = 'plan:created',
    silent = false
  ): Promise<void> => {
    // 1. Save in vault
    try {
      await vault.saveArtifact(artifact)
    } catch {
      // Continue even if vault filesystem write encounters an issue
    }

    // 2. Update memory state
    const existingIndex = memoryPlans.findIndex(
      (p) => p.id === artifact.id || p.filePath === artifact.filePath
    )
    if (existingIndex >= 0) {
      memoryPlans[existingIndex] = artifact
    } else {
      memoryPlans.unshift(artifact)
    }
    activePlan = artifact

    // 3. Transmit via SSE to all active clients
    const payload = JSON.stringify({ type: eventType, artifact })
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`)
      } catch {
        sseClients.delete(client)
      }
    }

    // 4. Auto-open window if requested
    const now = Date.now()
    if (!silent && autoOpenOnPlan && sseClients.size === 0 && now - lastWindowOpenAt > 1500) {
      lastWindowOpenAt = now
      launchStandaloneDesktopWindow(actualUrl, openBrowser)
    }
  }

  // HTTP Request Handler
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host || host}`)
    const pathname = parsedUrl.pathname

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 1. GET / -> Minimalist Plan Viewer HTML
    if (req.method === 'GET' && pathname === '/') {
      const html = generateDeckUiHtml()
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      res.end(html)
      return
    }

    // 2. GET /styles/macos.css -> CSS Stylesheet
    if (req.method === 'GET' && pathname === '/styles/macos.css') {
      const cssPath = path.join(PACKAGE_ROOT, 'src', 'styles', 'macos.css')
      try {
        const css = await readFile(cssPath, 'utf8')
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        res.end(css)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Stylesheet not found')
      }
      return
    }

    // 3. GET /api/plans -> { plans, activePlan }
    if (req.method === 'GET' && pathname === '/api/plans') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      res.end(JSON.stringify({ plans: memoryPlans, activePlan }))
      return
    }

    // 4. GET /api/artifacts -> Array of plans (alias for backwards compatibility)
    if (req.method === 'GET' && pathname === '/api/artifacts') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      res.end(JSON.stringify(memoryPlans))
      return
    }

    // 5. POST /api/plans & POST /api/detect -> Submit/detect and publish a plan
    if (
      req.method === 'POST' &&
      (pathname === '/api/plans' || pathname === '/api/detect')
    ) {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', async () => {
        try {
          const json = body ? JSON.parse(body) : {}
          let content = json.content || json.text || ''
          const targetPath = json.filePath ? path.resolve(json.filePath) : ''

          if (!content && targetPath && existsSync(targetPath)) {
            content = await readFile(targetPath, 'utf8')
          }

          if (!content) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing content or valid filePath' }))
            return
          }

          let detected = detectPlanInStream(
            'ui-session',
            'active-project',
            content,
            targetPath || undefined
          )

          if (!detected) {
            // Build minimal DetectedArtifact directly if detectPlanInStream was strict
            const mermaidBlocks = extractMermaidBlocks(content)
            const title = json.title || 'Plan de Implementación'
            const segment = classifyArtifactSegment(targetPath || '', content)
            detected = {
              id: randomUUID(),
              sessionId: 'ui-session',
              projectSlug: 'active-project',
              segment,
              title,
              filePath: targetPath || path.join('plans', `${slugifyTitle(title)}.md`),
              content,
              mermaidBlocks,
              detectedAt: new Date().toISOString(),
              syncedToMemoseb: false,
            }
          }

          await publishPlan(detected, 'plan:created')

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detected, plan: detected }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: msg }))
        }
      })
      return
    }

    // 6. GET /api/events -> Server-Sent Events (SSE)
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      // Send initial snapshot
      const initPayload = JSON.stringify({
        type: 'init',
        activePlan,
        plans: memoryPlans,
      })
      res.write(`data: ${initPayload}\n\n`)

      sseClients.add(res)
      req.on('close', () => {
        sseClients.delete(res)
      })
      return
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  // Start HTTP Server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      resolve()
    })
  })

  const addr = server.address()
  const actualPort =
    typeof addr === 'object' && addr !== null ? addr.port : port
  actualUrl = `http://${host}:${actualPort}`

  // Process initialPlanFile if provided
  if (options?.initialPlanFile && existsSync(options.initialPlanFile)) {
    try {
      const fullPath = path.resolve(options.initialPlanFile)
      const raw = await readFile(fullPath, 'utf8')
      let initialArt = detectPlanInStream('cli-session', 'active-project', raw, fullPath)
      if (!initialArt) {
        const title = path.basename(fullPath, path.extname(fullPath))
        initialArt = {
          id: randomUUID(),
          sessionId: 'cli-session',
          projectSlug: 'active-project',
          segment: classifyArtifactSegment(fullPath, raw),
          title,
          filePath: fullPath,
          content: raw,
          mermaidBlocks: extractMermaidBlocks(raw),
          detectedAt: new Date().toISOString(),
          syncedToMemoseb: false,
        }
      }
      await publishPlan(initialArt, 'plan:created')
    } catch {
      // Continue gracefully
    }
  }

  // Open window at startup if explicitly requested
  if (openWindow && Date.now() - lastWindowOpenAt > 1500) {
    lastWindowOpenAt = Date.now()
    launchStandaloneDesktopWindow(actualUrl, openBrowser)
  }

  // --- Lightweight Plan Poller (600ms) ---
  const fileCache = new Map<string, { mtime: number; size: number }>()
  const candidateDirs = new Set<string>()
  const homeDir = options?.homeDir ?? os.homedir()
  const disableAutoPoll = options?.disableAutoPoll ?? false
  let isClosed = false
  let isInitialScan = true
  let activePollPromise: Promise<void> | null = null

  if (options?.watchDirs && Array.isArray(options.watchDirs)) {
    for (const d of options.watchDirs) candidateDirs.add(path.resolve(d))
  }
  candidateDirs.add(path.resolve(process.cwd(), 'plans'))
  candidateDirs.add(path.resolve(process.cwd(), 'docs', 'plans'))
  const antigravityBrain = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain')
  if (existsSync(antigravityBrain)) {
    candidateDirs.add(antigravityBrain)
  }

  interface CandidateFile {
    full: string
    mtime: number
    size: number
    isUpdate: boolean
  }

  const pollPlans = async (): Promise<void> => {
    if (isClosed || disableAutoPoll) return
    const candidates: CandidateFile[] = []

    for (const baseDir of candidateDirs) {
      if (isClosed) return
      if (!existsSync(baseDir)) continue

      const scanDirectory = (dir: string, depth = 0): void => {
        if (isClosed || depth > 2) return
        try {
          const entries = readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (isClosed) return
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (
                entry.name !== 'node_modules' &&
                entry.name !== '.git' &&
                entry.name !== 'dist'
              ) {
                scanDirectory(full, depth + 1)
              }
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
              try {
                const st = statSync(full)
                const cached = fileCache.get(full)
                if (!cached || cached.mtime !== st.mtimeMs || cached.size !== st.size) {
                  candidates.push({
                    full,
                    mtime: st.mtimeMs,
                    size: st.size,
                    isUpdate: Boolean(cached),
                  })
                }
              } catch {
                // Ignore transient file stat errors during concurrent agent writes
              }
            }
          }
        } catch {
          // Ignore directory read errors
        }
      }

      scanDirectory(baseDir, 0)
    }

    if (candidates.length === 0 || isClosed) {
      if (isInitialScan) isInitialScan = false
      return
    }

    // Sort ascending by mtimeMs so the most recently modified file is processed last and remains activePlan
    candidates.sort((a, b) => a.mtime - b.mtime)

    for (const candidate of candidates) {
      if (isClosed) return
      try {
        fileCache.set(candidate.full, { mtime: candidate.mtime, size: candidate.size })
        const content = readFileSync(candidate.full, 'utf8')
        const detected = detectPlanInStream(
          'watcher-session',
          'active-project',
          content,
          candidate.full
        )
        if (detected && !isClosed) {
          if (isInitialScan) {
            await publishPlan(detected, 'plan:created', true)
          } else {
            await publishPlan(
              detected,
              candidate.isUpdate ? 'plan:updated' : 'plan:created',
              false
            )
          }
        }
      } catch {
        // Ignore transient file read errors during concurrent agent writes
      }
    }

    if (isInitialScan) {
      isInitialScan = false
    }
  }

  let pollTimer: NodeJS.Timeout | null = null
  if (!disableAutoPoll) {
    activePollPromise = pollPlans().catch(() => {})
    pollTimer = setInterval(() => {
      if (!isClosed) {
        activePollPromise = pollPlans().catch(() => {})
      }
    }, 600)
    pollTimer.unref()
  }

  const instance: UiServerInstance = {
    server,
    port: actualPort,
    url: actualUrl,
    publishPlan,
    getPlans: () => [...memoryPlans],
    getActivePlan: () => activePlan,
    close: async () => {
      isClosed = true
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (activePollPromise) {
        await activePollPromise.catch(() => {})
      }
      for (const client of sseClients) {
        try {
          client.end()
        } catch {}
      }
      sseClients.clear()
      await new Promise<void>((res) => {
        server.close(() => res())
      })
    },
  }

  return instance
}
