/* global Terminal, FitAddon, require, monaco */

// ============================================================================
// State
//
// The IDE holds several open *projects* at once (top project-tab bar). Each
// project keeps its own file tree, editor tabs, terminals, and Claude session
// — including the live conversation DOM. Only the active project's state is
// mirrored into the module-level globals below (rootFolder, openTabs, …); on
// project switch we snapshot the outgoing project and restore the incoming one.
// Chat state lives on the project object itself (never mirrored) because agent
// events can arrive for a background project at any time.
// ============================================================================
let rootFolder = null;
let monacoEditor = null;
let openTabs = []; // { path, name, kind: 'text'|'pdf'|'image', model?, url?, mime? }
let activeTabPath = null;

let terminals = []; // active project's terminals: { id, term, fit, el }
let activeTermId = null;
let termCounter = 0;

let gitState = { isRepo: false, branch: '', root: null, files: {} };
let expandedPaths = new Set(); // dir paths currently expanded (for rebuilds)

// ---- Project registry ------------------------------------------------------
let projects = []; // project state objects (see makeProject)
let activeProjectId = null;
let projectCounter = 0;

const SEP = navigator.platform.startsWith('Win') ? '\\' : '/';

const EMPTY_CHAT_HTML =
  '<div class="chat-empty"><div class="chat-empty-star">✳</div>' +
  '<p>Claude Code에게 무엇이든 물어보세요.</p>' +
  '<p class="chat-empty-sub">현재 폴더에서 파일을 읽고, 수정하고, 명령을 실행할 수 있어요.</p></div>';

const EMPTY_CODEX_HTML =
  '<div class="chat-empty"><div class="chat-empty-star codex">◆</div>' +
  '<p>OpenAI Codex에게 무엇이든 물어보세요.</p>' +
  '<p class="chat-empty-sub">협업 모드에서는 Claude의 계획을 검토하는 역할을 맡아요.</p></div>';

function projectById(id) {
  return projects.find((p) => p.id === id) || null;
}
function activeProject() {
  return projectById(activeProjectId);
}
function basename(f) {
  return f ? f.split(/[\\/]/).filter(Boolean).pop() : '';
}

// ============================================================================
// DOM refs
// ============================================================================
const welcomeEl = document.getElementById('welcome');
const monacoEl = document.getElementById('monaco');
const viewerEl = document.getElementById('binary-viewer');
const chatHost = document.getElementById('chat-messages');
const projectTabsEl = document.getElementById('project-tabs');

// ============================================================================
// Monaco setup
// ============================================================================
const VS_BASE = new URL('../node_modules/monaco-editor/min/vs', location.href)
  .href;

// Under file:// a plain `new Worker(file://...)` is blocked as cross-origin, so
// we hand Monaco a data: worker that importScripts the real worker.
window.MonacoEnvironment = {
  getWorkerUrl() {
    return (
      'data:text/javascript;charset=utf-8,' +
      encodeURIComponent(
        `self.MonacoEnvironment = { baseUrl: '${VS_BASE}' };` +
          `importScripts('${VS_BASE}/base/worker/workerMain.js');`
      )
    );
  },
};

require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });

require(['vs/editor/editor.main'], () => {
  monacoEditor = monaco.editor.create(monacoEl, {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    minimap: { enabled: true },
    padding: { top: 12 },
  });
  monacoEditor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    saveActiveFile
  );
});

const EXT_LANG = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
  php: 'php', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', sql: 'sql', toml: 'ini', ini: 'ini',
};
function langForFile(name) {
  return EXT_LANG[name.split('.').pop().toLowerCase()] || 'plaintext';
}

const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico',
]);
function fileKind(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'text';
}

// ============================================================================
// Git helpers
// ============================================================================
async function refreshGit() {
  gitState = await window.api.gitStatus(rootFolder);
  if (!gitState.files) gitState.files = {}; // non-repo folders omit it
  const bar = document.getElementById('git-bar');
  if (gitState.isRepo) {
    bar.classList.remove('hidden');
    document.getElementById('git-branch').textContent = gitState.branch || '—';
  } else {
    bar.classList.add('hidden');
  }
}

function mapStatus(code) {
  if (!code) return null;
  if (code.includes('?')) return { cls: 'git-U', badge: 'U' };
  if (code.includes('U')) return { cls: 'git-D', badge: '!' }; // conflict
  if (code.includes('A')) return { cls: 'git-A', badge: 'A' };
  if (code.includes('R')) return { cls: 'git-R', badge: 'R' };
  if (code.includes('D')) return { cls: 'git-D', badge: 'D' };
  if (code.includes('M')) return { cls: 'git-M', badge: 'M' };
  return { cls: 'git-M', badge: code.trim()[0] || 'M' };
}

function dirHasChanges(dirPath) {
  const prefix = dirPath + SEP;
  return Object.keys(gitState.files).some((p) => p.startsWith(prefix));
}

// ============================================================================
// Inline SVG icons (Lucide-style line icons — stroke follows CSS `color`)
// ============================================================================
const ICON_PATHS = {
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  'book-open':
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  pencil:
    '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  sparkles:
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'folder-open':
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  file:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  'file-plus':
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  'folder-plus':
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
};

function svgIcon(name) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (ICON_PATHS[name] || ICON_PATHS.wrench) +
    '</svg>'
  );
}

// ============================================================================
// File tree
// ============================================================================
const fileTreeEl = document.getElementById('file-tree');

async function rebuildTree() {
  fileTreeEl.innerHTML = '';
  if (!rootFolder) return;
  const container = document.createElement('div');
  container.dataset.dir = rootFolder;
  fileTreeEl.appendChild(container);
  await renderDir(rootFolder, container, 0);
}

async function renderDir(dirPath, container, depth) {
  let entries;
  try {
    entries = await window.api.readDir(dirPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    const node = document.createElement('div');
    node.className = 'tree-node';
    node.style.paddingLeft = 8 + depth * 14 + 'px';
    node.dataset.path = entry.path;
    node.dataset.isDir = entry.isDir ? '1' : '0';

    const twist = document.createElement('span');
    twist.className = 'twist';
    const icon = document.createElement('span');
    icon.className = 'ic';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;

    if (entry.isDir) {
      const expanded = expandedPaths.has(entry.path);
      twist.textContent = expanded ? '▼' : '▶';
      icon.innerHTML = svgIcon(expanded ? 'folder-open' : 'folder');
      // An untracked folder is collapsed by git to its own path, so check both
      // an exact match and any changed descendant.
      if (dirHasChanges(entry.path) || gitState.files[entry.path]) {
        const dot = document.createElement('span');
        dot.className = 'dir-dot';
        dot.textContent = '●';
        node.append(twist, icon, name, dot);
      } else {
        node.append(twist, icon, name);
      }
      container.appendChild(node);

      const childBox = document.createElement('div');
      childBox.dataset.dir = entry.path;
      childBox.style.display = expanded ? 'block' : 'none';
      container.appendChild(childBox);
      if (expanded) await renderDir(entry.path, childBox, depth + 1);

      node.addEventListener('click', async (e) => {
        e.stopPropagation();
        const open = childBox.style.display === 'none';
        childBox.style.display = open ? 'block' : 'none';
        twist.textContent = open ? '▼' : '▶';
        icon.innerHTML = svgIcon(open ? 'folder-open' : 'folder');
        if (open) {
          expandedPaths.add(entry.path);
          if (!childBox.hasChildNodes())
            await renderDir(entry.path, childBox, depth + 1);
        } else {
          expandedPaths.delete(entry.path);
        }
        selectTreeNode(node);
      });
    } else {
      icon.innerHTML = svgIcon('file');
      twist.textContent = '';
      const st = mapStatus(gitState.files[entry.path]);
      node.append(twist, icon, name);
      if (st) {
        node.classList.add(st.cls);
        const badge = document.createElement('span');
        badge.className = 'git-badge';
        badge.textContent = st.badge;
        node.appendChild(badge);
      }
      container.appendChild(node);

      node.addEventListener('click', (e) => {
        e.stopPropagation();
        selectTreeNode(node);
        openFile(entry.path, entry.name);
      });
    }

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectTreeNode(node);
      showContextMenu(e.clientX, e.clientY, entry);
    });
  }
}

function selectTreeNode(node) {
  document
    .querySelectorAll('.tree-node.selected')
    .forEach((n) => n.classList.remove('selected'));
  node.classList.add('selected');
}

// Right-clicking empty tree space targets the root folder.
fileTreeEl.addEventListener('contextmenu', (e) => {
  if (e.target === fileTreeEl || e.target.dataset.dir) {
    e.preventDefault();
    if (rootFolder)
      showContextMenu(e.clientX, e.clientY, {
        path: rootFolder,
        name: '',
        isDir: true,
      });
  }
});

// ============================================================================
// Context menu + file operations
// ============================================================================
const ctxMenu = document.getElementById('context-menu');

function showContextMenu(x, y, entry) {
  const parentDir = entry.isDir ? entry.path : dirname(entry.path);
  const items = [];

  items.push({
    icon: 'file-plus',
    label: '새 파일',
    action: () => createEntry(parentDir, false),
  });
  items.push({
    icon: 'folder-plus',
    label: '새 폴더',
    action: () => createEntry(parentDir, true),
  });

  if (entry.name) {
    items.push({ sep: true });
    items.push({ icon: 'pencil', label: '이름 변경', action: () => renameEntry(entry) });
    items.push({
      icon: 'trash',
      label: '삭제',
      danger: true,
      action: () => deleteEntry(entry),
    });
  }

  ctxMenu.innerHTML = '';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      ctxMenu.appendChild(s);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.danger ? ' danger' : '');
    el.innerHTML = svgIcon(it.icon) + esc(it.label);
    el.addEventListener('click', () => {
      hideContextMenu();
      it.action();
    });
    ctxMenu.appendChild(el);
  }

  ctxMenu.classList.remove('hidden');
  // Keep the menu on-screen.
  const rect = ctxMenu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  ctxMenu.style.left = px + 'px';
  ctxMenu.style.top = py + 'px';
}
function hideContextMenu() {
  ctxMenu.classList.add('hidden');
}
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);

function dirname(p) {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx === -1 ? p : p.slice(0, idx);
}

async function createEntry(parentDir, isFolder) {
  expandedPaths.add(parentDir); // reveal where the item lands
  const name = await promptInput(
    isFolder ? '새 폴더 이름' : '새 파일 이름',
    ''
  );
  if (!name) return;
  const res = isFolder
    ? await window.api.createFolder(parentDir, name)
    : await window.api.createFile(parentDir, name);
  if (res.error) return void showError(res.error);
  await refreshGit();
  await rebuildTree();
  if (!isFolder) openFile(res.path, name);
}

async function renameEntry(entry) {
  const name = await promptInput('이름 변경', entry.name);
  if (!name || name === entry.name) return;
  const res = await window.api.rename(entry.path, name);
  if (res.error) return void showError(res.error);
  // Update any open tab pointing at the old path.
  const tab = openTabs.find((t) => t.path === entry.path);
  if (tab) {
    tab.path = res.path;
    tab.name = name;
    if (activeTabPath === entry.path) activeTabPath = res.path;
    renderTabs();
  }
  await refreshGit();
  await rebuildTree();
}

async function deleteEntry(entry) {
  const ok = await confirmDialog(
    '삭제 확인',
    `"${entry.name}"을(를) 삭제할까요? 이 작업은 되돌릴 수 없습니다.`
  );
  if (!ok) return;
  const res = await window.api.delete(entry.path);
  if (res.error) return void showError(res.error);
  // Close any open tabs under the deleted path.
  for (const t of [...openTabs]) {
    if (t.path === entry.path || t.path.startsWith(entry.path + SEP))
      closeTab(t.path);
  }
  expandedPaths.delete(entry.path);
  await refreshGit();
  await rebuildTree();
}

// ============================================================================
// Editor tabs
// ============================================================================
const tabBar = document.getElementById('tab-bar');

async function openFile(filePath, name) {
  if (openTabs.find((t) => t.path === filePath)) return activateTab(filePath);

  const kind = fileKind(name);
  if (kind === 'text') {
    const res = await window.api.readFile(filePath);
    if (res.error) return void showError(res.error);
    const model = monaco.editor.createModel(res.content, langForFile(name));
    openTabs.push({ path: filePath, name, kind, model, savedContent: res.content });
  } else {
    const res = await window.api.readFileBinary(filePath);
    if (res.error) return void showError(res.error);
    const bin = atob(res.base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: res.mime });
    const url = URL.createObjectURL(blob);
    openTabs.push({ path: filePath, name, kind, url, mime: res.mime });
  }
  renderTabs();
  activateTab(filePath);
}

function activateTab(filePath) {
  activeTabPath = filePath;
  renderTabs();
  showActiveTabContent();
}

// Show whatever the active tab points at: Monaco for text, the binary viewer
// for PDF/images, or the welcome screen when nothing is open.
function showActiveTabContent() {
  const tab = openTabs.find((t) => t.path === activeTabPath);
  if (!tab) {
    welcomeEl.style.display = 'flex';
    monacoEl.style.display = 'none';
    viewerEl.style.display = 'none';
    viewerEl.innerHTML = '';
    if (monacoEditor) monacoEditor.setModel(null);
    return;
  }
  welcomeEl.style.display = 'none';
  if (tab.kind === 'text') {
    monacoEl.style.display = 'block';
    viewerEl.style.display = 'none';
    viewerEl.innerHTML = '';
    if (monacoEditor) monacoEditor.setModel(tab.model);
  } else {
    monacoEl.style.display = 'none';
    viewerEl.style.display = 'flex';
    viewerEl.innerHTML = '';
    if (tab.kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.src = tab.url;
      viewerEl.appendChild(frame);
    } else {
      const img = document.createElement('img');
      img.src = tab.url;
      viewerEl.appendChild(img);
    }
  }
}

function closeTab(filePath) {
  const idx = openTabs.findIndex((t) => t.path === filePath);
  if (idx === -1) return;
  const t = openTabs[idx];
  if (t.model) t.model.dispose();
  if (t.url) URL.revokeObjectURL(t.url);
  openTabs.splice(idx, 1);
  if (activeTabPath === filePath) {
    const next = openTabs[idx] || openTabs[idx - 1];
    activeTabPath = next ? next.path : null;
  }
  renderTabs();
  showActiveTabContent();
}

function renderTabs() {
  tabBar.innerHTML = '';
  for (const t of openTabs) {
    const tab = document.createElement('div');
    tab.className = 'editor-tab' + (t.path === activeTabPath ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = t.name;
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t.path);
    });
    tab.append(label, close);
    tab.addEventListener('click', () => activateTab(t.path));
    tabBar.appendChild(tab);
  }
}

async function saveActiveFile() {
  if (!activeTabPath) return;
  const tab = openTabs.find((t) => t.path === activeTabPath);
  if (!tab || tab.kind !== 'text') return; // binary tabs are read-only
  const content = tab.model.getValue();
  await window.api.writeFile(activeTabPath, content);
  tab.savedContent = content;
  await refreshGit();
  await rebuildTree();
}

// ============================================================================
// 파일 시스템 감시 — 외부(터미널, Claude 등)에서 파일이 생기거나 바뀌면
// 트리·git 배지를 자동 새로고침하고, 열린 탭도 (편집 중이 아닐 때만) 동기화.
// ============================================================================
let fsRefreshTimer = null;
let pendingFsPaths = new Set(); // 소문자 정규화된 변경 경로 누적

window.api.onFsChanged(({ folder, paths }) => {
  // 백그라운드 프로젝트는 switchProject → loadActive에서 전체 갱신되므로
  // 활성 프로젝트의 이벤트만 처리한다.
  if (folder !== rootFolder) return;
  for (const p of paths) pendingFsPaths.add(p.toLowerCase());
  clearTimeout(fsRefreshTimer);
  fsRefreshTimer = setTimeout(async () => {
    const changed = pendingFsPaths;
    pendingFsPaths = new Set();
    await refreshGit();
    await rebuildTree();
    await reloadChangedTabs(changed);
  }, 200);
});

// 디스크에서 바뀐 파일이 탭으로 열려 있으면 내용을 다시 읽어온다.
// 저장 안 한 편집이 있는 탭은 건드리지 않는다.
async function reloadChangedTabs(changedPaths) {
  for (const tab of openTabs) {
    if (tab.kind !== 'text' || !changedPaths.has(tab.path.toLowerCase())) continue;
    if (tab.model.getValue() !== tab.savedContent) continue; // 편집 중 → 보존
    const res = await window.api.readFile(tab.path);
    if (res.error || res.content === tab.savedContent) continue;
    const viewState =
      activeTabPath === tab.path && monacoEditor ? monacoEditor.saveViewState() : null;
    tab.model.setValue(res.content);
    tab.savedContent = res.content;
    if (viewState) monacoEditor.restoreViewState(viewState);
  }
}

// ============================================================================
// Terminal
// ============================================================================
const terminalHost = document.getElementById('terminal-host');
const terminalTabs = document.getElementById('terminal-tabs');

// pty data can target a terminal in any project (background sessions keep
// running), so search across every project.
function findTerminal(id) {
  for (const p of projects) {
    const t = p.terminals.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

function createTerminal({ autoRun }) {
  if (!activeProjectId) return; // terminals belong to a project
  const id = activeProjectId + '-term-' + ++termCounter;
  const el = document.createElement('div');
  el.className = 'term-instance';
  terminalHost.appendChild(el);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: { background: '#000000', foreground: '#e5e2da', cursor: '#d97757' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();

  terminals.push({ id, term, fit, el });

  window.api.ptySpawn({
    id,
    cwd: rootFolder || undefined,
    cols: term.cols,
    rows: term.rows,
    autoRun: !!autoRun,
  });

  term.onData((data) => window.api.ptyWrite(id, data));
  term.onResize(({ cols, rows }) => window.api.ptyResize(id, cols, rows));

  activateTerminal(id);
  renderTermTabs();
}

function activateTerminal(id) {
  activeTermId = id;
  for (const t of terminals) t.el.classList.toggle('hidden', t.id !== id);
  const active = terminals.find((t) => t.id === id);
  if (active)
    setTimeout(() => {
      active.fit.fit();
      active.term.focus();
    }, 0);
  renderTermTabs();
}

function renderTermTabs() {
  terminalTabs.innerHTML = '';
  terminals.forEach((t, i) => {
    const tab = document.createElement('div');
    tab.className = 'term-tab' + (t.id === activeTermId ? ' active' : '');
    tab.textContent = '터미널 ' + (i + 1);
    tab.addEventListener('click', () => activateTerminal(t.id));
    terminalTabs.appendChild(tab);
  });
}

window.api.onPtyData(({ id, data }) => {
  const t = findTerminal(id);
  if (t) t.term.write(data);
});
window.api.onPtyExit(({ id }) => {
  const t = findTerminal(id);
  if (t) t.term.write('\r\n[프로세스 종료됨]\r\n');
});

// ============================================================================
// Projects — snapshot / restore / switch / add / close
// ============================================================================
function makeProject(folder) {
  const chatEl = document.createElement('div');
  chatEl.className = 'chat-scroll hidden';
  chatEl.innerHTML = EMPTY_CHAT_HTML;
  chatHost.appendChild(chatEl);
  const codexChatEl = document.createElement('div');
  codexChatEl.className = 'chat-scroll codex-scroll hidden';
  codexChatEl.innerHTML = EMPTY_CODEX_HTML;
  chatHost.appendChild(codexChatEl);
  return {
    id: 'proj-' + ++projectCounter,
    folder,
    expandedPaths: new Set(),
    gitState: { isRepo: false, branch: '', root: null, files: {} },
    openTabs: [],
    activeTabPath: null,
    terminals: [],
    activeTermId: null,
    termCounter: 0,
    // chat state (not mirrored into globals)
    chatEl,
    chatBusy: false,
    currentAssistant: null,
    toolCards: {},
    chatModel: '',
    // codex chat state
    codexChatEl,
    codexBusy: false,
    codexCards: {}, // itemId -> { el, stateEl?, bodyEl?, textEl? }
    // which engine the panel shows for this project ('claude' | 'codex')
    activeEngine: 'claude',
    // a collab relay is currently running for this project
    collabRunning: false,
  };
}

// Write the active project's live globals back into its record.
function snapshotActive() {
  const p = activeProject();
  if (!p) return;
  p.folder = rootFolder;
  p.expandedPaths = expandedPaths;
  p.gitState = gitState;
  p.openTabs = openTabs;
  p.activeTabPath = activeTabPath;
  p.terminals = terminals;
  p.activeTermId = activeTermId;
  p.termCounter = termCounter;
}

// Load a project's record into the globals and re-render the whole UI.
async function loadActive() {
  // Hide every project's terminal and chat DOM first.
  for (const pr of projects) {
    for (const t of pr.terminals) t.el.classList.add('hidden');
    pr.chatEl.classList.add('hidden');
    pr.codexChatEl.classList.add('hidden');
  }

  const p = activeProject();
  if (!p) {
    rootFolder = null;
    expandedPaths = new Set();
    gitState = { isRepo: false, branch: '', root: null, files: {} };
    openTabs = [];
    activeTabPath = null;
    terminals = [];
    activeTermId = null;
    termCounter = 0;
    document.getElementById('sidebar-title').textContent = '탐색기';
    document.getElementById('git-bar').classList.add('hidden');
    document.getElementById('chat-model').textContent = '';
    fileTreeEl.innerHTML = '';
    renderTabs();
    showActiveTabContent();
    renderTermTabs();
    return;
  }

  rootFolder = p.folder;
  expandedPaths = p.expandedPaths;
  gitState = p.gitState;
  openTabs = p.openTabs;
  activeTabPath = p.activeTabPath;
  terminals = p.terminals;
  activeTermId = p.activeTermId;
  termCounter = p.termCounter;

  document.getElementById('sidebar-title').textContent =
    basename(p.folder) || '탐색기';

  await refreshGit();
  await rebuildTree();
  renderTabs();
  showActiveTabContent();

  // Terminals: show this project's active one.
  for (const t of terminals) t.el.classList.toggle('hidden', t.id !== activeTermId);
  renderTermTabs();
  refitActiveTerminal();

  // Chat — show the engine this project was last talking to.
  applyEngineUI(p);
  applyChatBusyUI(p);
  scrollChat(p, activeChatEl(p));
}

async function switchProject(id) {
  if (id === activeProjectId) return;
  snapshotActive();
  activeProjectId = id;
  await loadActive();
  renderProjectTabs();
  persistProjects();
}

async function addProject(folder) {
  const existing = projects.find((p) => p.folder === folder);
  if (existing) return switchProject(existing.id);

  snapshotActive();
  const p = makeProject(folder);
  projects.push(p);
  window.api.watchFolder(folder);
  activeProjectId = p.id;
  await loadActive(); // folder already set → tree renders
  createTerminal({ autoRun: false });
  renderProjectTabs();
  persistProjects();
}

async function closeProject(id) {
  const p = projectById(id);
  if (!p) return;

  // Tear down the project's resources.
  window.api.agentNew(id); // end its Claude session in the main process
  window.api.codexNew(id); // end its Codex thread too
  if (p.collabRunning) window.api.collabStop(id);
  for (const t of p.openTabs) {
    if (t.model) t.model.dispose();
    if (t.url) URL.revokeObjectURL(t.url);
  }
  for (const t of p.terminals) {
    try {
      window.api.ptyKill(t.id);
    } catch {
      /* ignore */
    }
    try {
      t.term.dispose();
    } catch {
      /* ignore */
    }
    t.el.remove();
  }
  p.chatEl.remove();
  p.codexChatEl.remove();
  if (p.folder) window.api.unwatchFolder(p.folder);

  const idx = projects.findIndex((x) => x.id === id);
  projects.splice(idx, 1);

  if (activeProjectId === id) {
    const next = projects[idx] || projects[idx - 1] || null;
    activeProjectId = next ? next.id : null;
    await loadActive();
  }
  renderProjectTabs();
  persistProjects();
}

function renderProjectTabs() {
  projectTabsEl.innerHTML = '';
  for (const p of projects) {
    const tab = document.createElement('div');
    tab.className = 'project-tab' + (p.id === activeProjectId ? ' active' : '');
    tab.title = p.folder || '';
    const dot = document.createElement('span');
    dot.className = 'p-dot';
    dot.textContent = '●';
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = basename(p.folder) || '(폴더 없음)';
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProject(p.id);
    });
    tab.append(dot, name, close);
    tab.addEventListener('click', () => switchProject(p.id));
    projectTabsEl.appendChild(tab);
  }
}

function persistProjects() {
  window.api.setConfig({
    openFolders: projects.map((p) => p.folder).filter(Boolean),
    activeFolder: activeProject()?.folder || null,
    lastFolder: activeProject()?.folder || null,
  });
}

async function pickAndAddProject() {
  const folder = await window.api.openFolder();
  if (folder) await addProject(folder);
}

// ============================================================================
// Layout toggles / activity bar
// ============================================================================
const sidebar = document.getElementById('sidebar');
const terminalPanel = document.getElementById('terminal-panel');
const btnExplorer = document.getElementById('btn-explorer');
const btnTerminal = document.getElementById('btn-terminal');

btnExplorer.addEventListener('click', () => {
  sidebar.classList.toggle('hidden');
  btnExplorer.classList.toggle('active', !sidebar.classList.contains('hidden'));
  refitActiveTerminal();
});
btnTerminal.addEventListener('click', () => {
  const hidden = terminalPanel.classList.toggle('hidden');
  btnTerminal.classList.toggle('active', !hidden);
  if (!hidden) refitActiveTerminal();
});
document.getElementById('btn-hide-term').addEventListener('click', () => {
  terminalPanel.classList.add('hidden');
  btnTerminal.classList.remove('active');
});
document.getElementById('btn-new-term').addEventListener('click', () =>
  createTerminal({ autoRun: false })
);
document.getElementById('btn-add-project').addEventListener('click', pickAndAddProject);
document.getElementById('btn-open-folder').addEventListener('click', pickAndAddProject);
document.getElementById('btn-refresh').addEventListener('click', async () => {
  await refreshGit();
  await rebuildTree();
});
document.getElementById('btn-new-file').addEventListener('click', () => {
  if (rootFolder) createEntry(rootFolder, false);
});
document.getElementById('btn-new-folder').addEventListener('click', () => {
  if (rootFolder) createEntry(rootFolder, true);
});

function refitActiveTerminal() {
  const active = terminals.find((t) => t.id === activeTermId);
  if (active) setTimeout(() => active.fit.fit(), 0);
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'b') {
    e.preventDefault();
    btnExplorer.click();
  }
  if (e.ctrlKey && e.key === '`') {
    e.preventDefault();
    btnTerminal.click();
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: cycle project tabs.
  if (e.ctrlKey && e.key === 'Tab' && projects.length > 1) {
    e.preventDefault();
    const i = projects.findIndex((p) => p.id === activeProjectId);
    const n = projects.length;
    const next = projects[(i + (e.shiftKey ? -1 : 1) + n) % n];
    switchProject(next.id);
  }
});

// ============================================================================
// Panel resizer
// ============================================================================
const resizer = document.getElementById('panel-resizer');
let resizing = false;
resizer.addEventListener('mousedown', (e) => {
  e.preventDefault(); // 드래그 중 텍스트 선택 방지
  resizing = true;
  document.body.style.cursor = 'ns-resize';
});
window.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const appHeight = document.getElementById('app').clientHeight;
  const clamped = Math.max(
    100,
    Math.min(appHeight - e.clientY, appHeight - 140)
  );
  terminalPanel.style.height = clamped + 'px';
  refitActiveTerminal();
});
window.addEventListener('mouseup', () => {
  if (resizing) {
    resizing = false;
    document.body.style.cursor = '';
    refitActiveTerminal();
  }
});
window.addEventListener('resize', refitActiveTerminal);

// ============================================================================
// Modals (input / confirm / error / settings)
// ============================================================================
const inputModal = document.getElementById('input-modal');
const inputField = document.getElementById('input-modal-field');
const inputTitle = document.getElementById('input-modal-title');
const inputError = document.getElementById('input-modal-error');
let inputResolve = null;

function promptInput(title, initial) {
  inputTitle.textContent = title;
  inputField.value = initial || '';
  inputError.textContent = '';
  inputModal.classList.remove('hidden');
  inputField.focus();
  inputField.select();
  return new Promise((resolve) => {
    inputResolve = resolve;
  });
}
function closeInput(value) {
  inputModal.classList.add('hidden');
  if (inputResolve) inputResolve(value);
  inputResolve = null;
}
document
  .getElementById('input-modal-ok')
  .addEventListener('click', () => closeInput(inputField.value.trim() || null));
document
  .getElementById('input-modal-cancel')
  .addEventListener('click', () => closeInput(null));
inputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeInput(inputField.value.trim() || null);
  if (e.key === 'Escape') closeInput(null);
});
function showError(msg) {
  if (!inputModal.classList.contains('hidden')) {
    inputError.textContent = msg;
  } else {
    alert(msg);
  }
}

const confirmModal = document.getElementById('confirm-modal');
let confirmResolve = null;
function confirmDialog(title, msg) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-msg').textContent = msg;
  confirmModal.classList.remove('hidden');
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
function closeConfirm(val) {
  confirmModal.classList.add('hidden');
  if (confirmResolve) confirmResolve(val);
  confirmResolve = null;
}
document
  .getElementById('confirm-modal-ok')
  .addEventListener('click', () => closeConfirm(true));
document
  .getElementById('confirm-modal-cancel')
  .addEventListener('click', () => closeConfirm(false));

// ============================================================================
// Claude chat (Agent SDK) — every function is scoped to a project object `p`
// so background projects keep rendering into their own chat container.
// ============================================================================
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatStop = document.getElementById('chat-stop');
const chatStatus = document.getElementById('chat-status');
const btnChat = document.getElementById('btn-chat');
const chatPanel = document.getElementById('chat-panel');
const chatResizer = document.getElementById('chat-resizer');
const modelSelect = document.getElementById('chat-model-select');
const codexModelSelect = document.getElementById('codex-model-select');
const effortSelect = document.getElementById('chat-effort-select');

// Chat model / reasoning-effort selection (applied to new sessions; model
// changes also apply live to a running session). '' model = CLI default.
let chatModel = '';
let codexChatModel = '';
let chatEffort = 'high';

modelSelect.addEventListener('change', () => {
  chatModel = modelSelect.value;
  window.api.setConfig({ chatModel });
  if (activeProjectId) window.api.agentSetModel(activeProjectId, chatModel);
});
// Codex 모델 변경은 다음 턴부터 적용 (main이 같은 대화를 새 모델로 이어감).
codexModelSelect.addEventListener('change', () => {
  codexChatModel = codexModelSelect.value;
  window.api.setConfig({ codexModel: codexChatModel });
  const p = activeProject();
  if (p && p.activeEngine === 'codex')
    document.getElementById('chat-model').textContent = codexChatModel;
});
effortSelect.addEventListener('change', () => {
  chatEffort = effortSelect.value;
  window.api.setConfig({ chatEffort });
});

// --- image attachments -----------------------------------------------------
const chatAttachBtn = document.getElementById('chat-attach');
const chatFileInput = document.getElementById('chat-file-input');
const chatAttachmentsEl = document.getElementById('chat-attachments');
const chatInputArea = document.getElementById('chat-input-area');
const chatWarnEl = document.getElementById('chat-warn');
const pendingImages = []; // { dataUrl, base64, mediaType, name }

// Anthropic caps each image at ~5MB; warn and skip anything larger.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
let warnTimer = null;
function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}
function showAttachWarn(msg) {
  chatWarnEl.textContent = msg;
  chatWarnEl.classList.remove('hidden');
  if (warnTimer) clearTimeout(warnTimer);
  warnTimer = setTimeout(() => chatWarnEl.classList.add('hidden'), 6000);
}
function clearAttachWarn() {
  chatWarnEl.classList.add('hidden');
}

function addImageFiles(files) {
  for (const file of files) {
    if (!file || !file.type || !file.type.startsWith('image/')) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      showAttachWarn(
        `"${file.name || '이미지'}"가 너무 큽니다 (${mb(file.size)}MB). 5MB 이하만 첨부할 수 있어요.`
      );
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      pendingImages.push({
        dataUrl,
        base64,
        mediaType: file.type,
        name: file.name || 'image',
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

function renderAttachments() {
  if (pendingImages.length) clearAttachWarn();
  chatAttachmentsEl.innerHTML = '';
  chatAttachmentsEl.classList.toggle('hidden', pendingImages.length === 0);
  pendingImages.forEach((img, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const im = document.createElement('img');
    im.src = img.dataUrl;
    im.title = img.name;
    const rm = document.createElement('span');
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    chip.append(im, rm);
    chatAttachmentsEl.appendChild(chip);
  });
}

function clearAttachments() {
  pendingImages.length = 0;
  renderAttachments();
}

chatAttachBtn.addEventListener('click', () => chatFileInput.click());
chatFileInput.addEventListener('change', () => {
  addImageFiles(chatFileInput.files);
  chatFileInput.value = '';
});
function addBase64Image(base64, mediaType, name) {
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    showAttachWarn(
      `붙여넣은 이미지가 너무 큽니다 (${mb(approxBytes)}MB). 5MB 이하만 첨부할 수 있어요.`
    );
    return;
  }
  pendingImages.push({
    dataUrl: 'data:' + mediaType + ';base64,' + base64,
    base64,
    mediaType,
    name: name || 'clipboard.png',
  });
  renderAttachments();
}

chatInput.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  const files = [];
  if (items) {
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length) {
    e.preventDefault();
    addImageFiles(files);
    return;
  }
  // The DOM paste API missed it — some apps (e.g. KakaoTalk) only place a
  // native bitmap on the clipboard. Fall back to Electron's clipboard.
  const hasText =
    e.clipboardData && e.clipboardData.getData('text/plain').length > 0;
  window.api.readClipboardImage().then((img) => {
    if (img && img.base64) addBase64Image(img.base64, img.mediaType);
  });
  // If there's no text to paste, suppress the (empty) default paste.
  if (!hasText) e.preventDefault();
});
['dragover', 'dragenter'].forEach((ev) =>
  chatInputArea.addEventListener(ev, (e) => e.preventDefault())
);
chatInputArea.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length)
    addImageFiles(e.dataTransfer.files);
});

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function renderMd(text) {
  let html = esc(text);
  html = html.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_, lang, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`
  );
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return html;
}
function clearEmpty(p, el) {
  const empty = (el || p.chatEl).querySelector('.chat-empty');
  if (empty) empty.remove();
}
function scrollChat(p, el) {
  const t = el || p.chatEl;
  t.scrollTop = t.scrollHeight;
}
function applyChatBusyUI(p) {
  if (p.collabRunning) {
    // 협업 중에는 입력을 살려둔다 — 보내면 다음 Claude 턴에 개입된다.
    chatSend.classList.remove('hidden');
    chatStop.classList.remove('hidden');
    chatStatus.classList.remove('hidden');
    chatStatus.innerHTML =
      '<span class="spinner"></span> 협업 진행 중… (메시지를 보내면 토론에 개입합니다)';
    return;
  }
  const busy = p.activeEngine === 'codex' ? p.codexBusy : p.chatBusy;
  chatSend.classList.toggle('hidden', busy);
  chatStop.classList.toggle('hidden', !busy);
  if (busy) {
    chatStatus.classList.remove('hidden');
    chatStatus.innerHTML =
      '<span class="spinner"></span> ' +
      (p.activeEngine === 'codex' ? 'Codex가 작업 중…' : 'Claude가 작업 중…');
  } else {
    chatStatus.classList.add('hidden');
  }
}
function setChatBusy(p, b) {
  p.chatBusy = b;
  if (p.id === activeProjectId) applyChatBusyUI(p);
}
function setCodexBusy(p, b) {
  p.codexBusy = b;
  if (p.id === activeProjectId) applyChatBusyUI(p);
}

// ---- engine tabs (Claude / Codex) ------------------------------------------
const engineClaude = document.getElementById('engine-claude');
const engineCodex = document.getElementById('engine-codex');
const chatEngineName = document.getElementById('chat-engine-name');

function activeChatEl(p) {
  return p.activeEngine === 'codex' ? p.codexChatEl : p.chatEl;
}
function applyEngineUI(p) {
  const codex = p.activeEngine === 'codex';
  engineClaude.classList.toggle('active', !codex);
  engineCodex.classList.toggle('active', codex);
  chatEngineName.textContent = codex ? 'Codex' : 'Claude';
  document.getElementById('chat-model').textContent =
    codex ? codexChatModel : p.chatModel || '';
  // 엔진에 맞는 모델 셀렉터만 노출.
  document.getElementById('claude-model-field').classList.toggle('hidden', codex);
  document.getElementById('codex-model-field').classList.toggle('hidden', !codex);
  p.chatEl.classList.toggle('hidden', codex);
  p.codexChatEl.classList.toggle('hidden', !codex);
}
function switchEngine(engine) {
  const p = activeProject();
  if (!p || p.activeEngine === engine) return;
  p.activeEngine = engine;
  applyEngineUI(p);
  applyChatBusyUI(p);
  scrollChat(p, activeChatEl(p));
  chatInput.focus();
}
engineClaude.addEventListener('click', () => switchEngine('claude'));
engineCodex.addEventListener('click', () => switchEngine('codex'));

// A hover "복사" button that copies `text` to the OS clipboard.
function addCopyBtn(msgEl, text) {
  if (!text) return;
  const btn = document.createElement('button');
  btn.className = 'msg-copy';
  btn.textContent = '복사';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.writeClipboardText(text);
    btn.textContent = '복사됨';
    setTimeout(() => {
      btn.textContent = '복사';
    }, 1200);
  });
  msgEl.appendChild(btn);
}

function addUserBubble(p, text, images, el) {
  el = el || p.chatEl;
  clearEmpty(p, el);
  const msg = document.createElement('div');
  msg.className = 'msg user';
  if (text) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    msg.appendChild(bubble);
  }
  if (images && images.length) {
    const strip = document.createElement('div');
    strip.className = 'msg-images';
    for (const img of images) {
      const im = document.createElement('img');
      im.src = img.dataUrl;
      im.title = img.name;
      strip.appendChild(im);
    }
    msg.appendChild(strip);
  }
  addCopyBtn(msg, text);
  el.appendChild(msg);
  scrollChat(p, el);
}

function ensureAssistant(p) {
  if (p.currentAssistant) return p.currentAssistant;
  clearEmpty(p);
  const msgEl = document.createElement('div');
  msgEl.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  msgEl.appendChild(bubble);
  p.chatEl.appendChild(msgEl);
  p.currentAssistant = { msgEl, textEl: bubble };
  return p.currentAssistant;
}

const TOOL_ICON = {
  Bash: svgIcon('terminal'),
  Read: svgIcon('book-open'),
  Edit: svgIcon('pencil'),
  Write: svgIcon('pencil'),
  MultiEdit: svgIcon('pencil'),
  Grep: svgIcon('search'),
  Glob: svgIcon('search'),
  WebFetch: svgIcon('globe'),
  WebSearch: svgIcon('globe'),
  Task: svgIcon('sparkles'),
};
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  return (
    input.file_path ||
    input.command ||
    input.path ||
    input.pattern ||
    input.url ||
    input.description ||
    JSON.stringify(input).slice(0, 90)
  );
}
function extractResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) =>
        b.type === 'text'
          ? b.text
          : b.type === 'image'
          ? '[이미지]'
          : JSON.stringify(b)
      )
      .join('\n');
  return JSON.stringify(content);
}

function renderToolCard(p, block) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML =
    `<span class="tool-ic">${TOOL_ICON[block.name] || svgIcon('wrench')}</span>` +
    `<span class="tool-name">${esc(block.name)}</span>` +
    `<span class="tool-sub">${esc(summarizeInput(block.input))}</span>` +
    `<span class="tool-state">실행 중…</span>`;
  const body = document.createElement('div');
  body.className = 'tool-body hidden';
  const pre = document.createElement('pre');
  pre.textContent = '입력:\n' + JSON.stringify(block.input, null, 2);
  body.appendChild(pre);
  head.addEventListener('click', () => body.classList.toggle('hidden'));
  card.append(head, body);
  p.toolCards[block.id] = {
    stateEl: head.querySelector('.tool-state'),
    bodyEl: body,
  };
  return card;
}

function finalizeAssistant(p, betaMessage) {
  const { msgEl } = ensureAssistant(p);
  msgEl.innerHTML = '';
  for (const block of betaMessage.content || []) {
    if (block.type === 'text') {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.innerHTML = renderMd(block.text);
      msgEl.appendChild(b);
    } else if (block.type === 'thinking') {
      const t = document.createElement('div');
      t.className = 'thinking';
      t.textContent = block.thinking || '';
      msgEl.appendChild(t);
    } else if (block.type === 'tool_use') {
      msgEl.appendChild(renderToolCard(p, block));
    }
  }
  const copyText = (betaMessage.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  addCopyBtn(msgEl, copyText);
  p.currentAssistant = null;
  scrollChat(p);
}

function handleToolResults(p, userMessage) {
  const content = userMessage.content || [];
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const entry = p.toolCards[block.tool_use_id];
    if (!entry) continue;
    entry.stateEl.classList.add(block.is_error ? 'err' : 'ok');
    entry.stateEl.innerHTML =
      svgIcon(block.is_error ? 'alert' : 'check') +
      (block.is_error ? ' 오류' : ' 완료');
    const text = extractResultText(block.content);
    const pre = document.createElement('pre');
    pre.textContent =
      '결과:\n' + (text.length > 4000 ? text.slice(0, 4000) + '\n…(생략)' : text);
    entry.bodyEl.appendChild(pre);
  }
}

function showChatResult(p, m) {
  const el = document.createElement('div');
  el.className = 'chat-result';
  const cost = (m.total_cost_usd || 0).toFixed(4);
  el.textContent = `${m.num_turns ?? '?'}턴 · $${cost}`;
  p.chatEl.appendChild(el);
  scrollChat(p);
}

// --- incoming agent events (routed to the owning project) ---
window.api.onAgentMessage(({ projectId, message: m }) => {
  const p = projectById(projectId);
  if (!p) return;
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init' && m.model) {
        p.chatModel = m.model;
        if (p.id === activeProjectId)
          document.getElementById('chat-model').textContent = m.model;
      }
      break;
    case 'stream_event': {
      const ev = m.event;
      if (
        ev &&
        ev.type === 'content_block_delta' &&
        ev.delta &&
        ev.delta.type === 'text_delta'
      ) {
        ensureAssistant(p).textEl.textContent += ev.delta.text;
        scrollChat(p);
      }
      break;
    }
    case 'assistant':
      finalizeAssistant(p, m.message);
      break;
    case 'user':
      handleToolResults(p, m.message);
      break;
    case 'result':
      showChatResult(p, m);
      setChatBusy(p, false);
      p.currentAssistant = null;
      break;
  }
});

// AskUserQuestion 선택지 카드 — 질문마다 옵션을 고르고(복수 선택 지원),
// '기타'로 직접 입력할 수도 있다. 선택 결과는 updatedInput.answers
// (질문 텍스트 → 선택 라벨)로 메인 프로세스에 전달된다.
function renderQuestionCard(pl) {
  const card = document.createElement('div');
  card.className = 'perm-card ask-card';
  const title = document.createElement('div');
  title.className = 'perm-title';
  title.textContent = 'Claude가 선택을 요청합니다';
  card.appendChild(title);

  let done = false;
  // 질문 텍스트 -> { labels: Set, other: boolean, otherInput: HTMLInput }
  const state = new Map();

  const submit = document.createElement('button');
  submit.className = 'allow';
  submit.textContent = '답변 보내기';

  const updateSubmit = () => {
    let ok = true;
    for (const s of state.values()) {
      if (s.other) {
        if (!s.otherInput.value.trim()) ok = false;
      } else if (!s.labels.size) ok = false;
    }
    submit.disabled = !ok;
  };

  for (const q of pl.input.questions) {
    const s = { labels: new Set(), other: false, otherInput: null };
    state.set(q.question, s);

    const qTitle = document.createElement('div');
    qTitle.className = 'ask-q-title';
    qTitle.textContent = (q.header ? `[${q.header}] ` : '') + q.question;
    card.appendChild(qTitle);

    const optBox = document.createElement('div');
    optBox.className = 'ask-opts';
    const optEls = [];

    const otherInput = document.createElement('input');
    otherInput.className = 'ask-other-input';
    otherInput.placeholder = '직접 입력…';
    otherInput.addEventListener('input', updateSubmit);
    s.otherInput = otherInput;

    const addOpt = (label, description, isOther) => {
      const el = document.createElement('div');
      el.className = 'ask-opt';
      el.innerHTML =
        `<div class="ask-opt-label">${esc(label)}</div>` +
        (description ? `<div class="ask-opt-desc">${esc(description)}</div>` : '');
      el.addEventListener('click', () => {
        if (done) return;
        if (isOther) {
          s.other = !s.other;
          if (s.other && !q.multiSelect) {
            s.labels.clear();
            for (const o of optEls) o.classList.remove('selected');
          }
          el.classList.toggle('selected', s.other);
          otherInput.style.display = s.other ? 'block' : 'none';
          if (s.other) otherInput.focus();
        } else {
          if (q.multiSelect) {
            if (s.labels.has(label)) s.labels.delete(label);
            else s.labels.add(label);
            el.classList.toggle('selected', s.labels.has(label));
          } else {
            s.labels.clear();
            s.labels.add(label);
            s.other = false;
            otherInput.style.display = 'none';
            for (const o of optEls) o.classList.toggle('selected', o === el);
          }
        }
        updateSubmit();
      });
      optEls.push(el);
      optBox.appendChild(el);
    };

    for (const opt of q.options || []) addOpt(opt.label, opt.description, false);
    addOpt('기타', '직접 입력합니다', true);
    optBox.appendChild(otherInput);
    card.appendChild(optBox);
  }

  const actions = document.createElement('div');
  actions.className = 'perm-actions';

  const finish = (text) => {
    done = true;
    card.classList.add('resolved');
    const tag = document.createElement('div');
    tag.className = 'perm-desc';
    tag.textContent = text;
    card.appendChild(tag);
  };

  submit.onclick = () => {
    if (done || submit.disabled) return;
    const answers = {};
    for (const [question, s] of state) {
      const parts = [...s.labels];
      if (s.other && s.otherInput.value.trim()) parts.push(s.otherInput.value.trim());
      answers[question] = parts.join(', ');
    }
    window.api.agentRespondPermission(pl.id, 'allow', undefined, answers);
    finish('→ ' + Object.values(answers).join(' / '));
  };

  const skip = document.createElement('button');
  skip.className = 'deny';
  skip.textContent = '건너뛰기';
  skip.onclick = () => {
    if (done) return;
    window.api.agentRespondPermission(pl.id, 'deny', '사용자가 질문을 건너뛰었습니다.');
    finish('→ 건너뜀');
  };

  updateSubmit();
  actions.append(submit, skip);
  card.appendChild(actions);
  return card;
}

window.api.onAgentPermission((pl) => {
  const p = projectById(pl.projectId);
  if (!p) return;
  clearEmpty(p);
  // AskUserQuestion은 허용/거부 카드가 아니라 선택지 카드로 렌더링한다.
  if (pl.toolName === 'AskUserQuestion' && pl.input && Array.isArray(pl.input.questions)) {
    p.chatEl.appendChild(renderQuestionCard(pl));
    scrollChat(p);
    return;
  }
  const card = document.createElement('div');
  card.className = 'perm-card';
  const title = document.createElement('div');
  title.className = 'perm-title';
  title.textContent =
    pl.title || `Claude가 ${pl.displayName || pl.toolName} 실행을 요청합니다`;
  const desc = document.createElement('div');
  desc.className = 'perm-desc';
  desc.textContent = pl.description || summarizeInput(pl.input);
  const actions = document.createElement('div');
  actions.className = 'perm-actions';

  const respond = (behavior) => {
    window.api.agentRespondPermission(pl.id, behavior);
    card.classList.add('resolved');
    const tag = document.createElement('div');
    tag.className = 'perm-desc';
    tag.textContent =
      behavior === 'deny'
        ? '→ 거부됨'
        : behavior === 'allow-always'
        ? '→ 항상 허용됨'
        : '→ 허용됨';
    card.appendChild(tag);
  };

  const allow = document.createElement('button');
  allow.className = 'allow';
  allow.textContent = '허용';
  allow.onclick = () => respond('allow');
  const always = document.createElement('button');
  always.textContent = '항상 허용';
  always.onclick = () => respond('allow-always');
  const deny = document.createElement('button');
  deny.className = 'deny';
  deny.textContent = '거부';
  deny.onclick = () => respond('deny');

  actions.append(allow, always, deny);
  card.append(title, desc, actions);
  p.chatEl.appendChild(card);
  scrollChat(p);
});

window.api.onAgentError((e) => {
  const p = projectById(e.projectId);
  if (!p) return;
  const el = document.createElement('div');
  el.className = 'chat-err';
  el.textContent = '오류: ' + e.message;
  p.chatEl.appendChild(el);
  setChatBusy(p, false);
  p.currentAssistant = null;
  scrollChat(p);
});

window.api.onAgentClosed((e) => {
  const p = projectById(e.projectId);
  if (!p) return;
  setChatBusy(p, false);
  p.currentAssistant = null;
});

// ============================================================================
// Codex chat rendering — Codex streams "items"(message/reasoning/command/…)
// that start, update, and complete; each item id maps to one DOM block.
// ============================================================================
const CODEX_ITEM_LABEL = {
  command_execution: '명령 실행',
  file_change: '파일 변경',
  mcp_tool_call: 'MCP 도구',
  web_search: '웹 검색',
  todo_list: '할 일',
};

function codexToolCard(p, item, icon, sub) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML =
    `<span class="tool-ic">${svgIcon(icon)}</span>` +
    `<span class="tool-name">${esc(CODEX_ITEM_LABEL[item.type] || item.type)}</span>` +
    `<span class="tool-sub">${esc(sub || '')}</span>` +
    `<span class="tool-state">실행 중…</span>`;
  const body = document.createElement('div');
  body.className = 'tool-body hidden';
  head.addEventListener('click', () => body.classList.toggle('hidden'));
  card.append(head, body);
  return {
    el: card,
    body,
    stateEl: head.querySelector('.tool-state'),
    subEl: head.querySelector('.tool-sub'),
  };
}

function setCodexCardState(entry, status) {
  if (!entry.stateEl) return;
  if (status === 'completed') {
    entry.stateEl.classList.add('ok');
    entry.stateEl.innerHTML = svgIcon('check') + ' 완료';
  } else if (status === 'failed') {
    entry.stateEl.classList.add('err');
    entry.stateEl.innerHTML = svgIcon('alert') + ' 오류';
  }
}

function renderCodexItem(p, item, done) {
  const el = p.codexChatEl;
  clearEmpty(p, el);
  let entry = p.codexCards[item.id];

  switch (item.type) {
    case 'agent_message': {
      if (!entry) {
        const msg = document.createElement('div');
        msg.className = 'msg assistant';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        msg.appendChild(bubble);
        el.appendChild(msg);
        entry = p.codexCards[item.id] = { el: msg, textEl: bubble };
      }
      if (done) {
        entry.textEl.innerHTML = renderMd(item.text || '');
        addCopyBtn(entry.el, item.text || '');
      } else {
        entry.textEl.textContent = item.text || '';
      }
      break;
    }
    case 'reasoning': {
      if (!entry) {
        const t = document.createElement('div');
        t.className = 'thinking';
        el.appendChild(t);
        entry = p.codexCards[item.id] = { el: t, textEl: t };
      }
      entry.textEl.textContent = item.text || '';
      break;
    }
    case 'command_execution': {
      if (!entry) {
        entry = p.codexCards[item.id] = codexToolCard(p, item, 'terminal', item.command);
        el.appendChild(entry.el);
      }
      entry.subEl.textContent = item.command || '';
      setCodexCardState(entry, item.status);
      if (done && !entry.gotOutput) {
        entry.gotOutput = true;
        const pre = document.createElement('pre');
        const out = item.aggregated_output || '(출력 없음)';
        pre.textContent =
          '결과:\n' + (out.length > 4000 ? out.slice(0, 4000) + '\n…(생략)' : out);
        entry.body.appendChild(pre);
      }
      break;
    }
    case 'file_change': {
      const sub = (item.changes || [])
        .map((ch) => (ch.kind === 'add' ? 'A' : ch.kind === 'delete' ? 'D' : 'M') + ' ' + ch.path)
        .join(' · ');
      if (!entry) {
        entry = p.codexCards[item.id] = codexToolCard(p, item, 'pencil', sub);
        el.appendChild(entry.el);
      }
      entry.subEl.textContent = sub;
      setCodexCardState(entry, item.status);
      break;
    }
    case 'mcp_tool_call': {
      const sub = `${item.server || ''}.${item.tool || ''}`;
      if (!entry) {
        entry = p.codexCards[item.id] = codexToolCard(p, item, 'wrench', sub);
        el.appendChild(entry.el);
      }
      setCodexCardState(entry, item.status);
      break;
    }
    case 'web_search': {
      if (!entry) {
        entry = p.codexCards[item.id] = codexToolCard(p, item, 'globe', item.query);
        el.appendChild(entry.el);
      }
      entry.subEl.textContent = item.query || '';
      if (done) setCodexCardState(entry, 'completed');
      break;
    }
    case 'todo_list': {
      const items = item.items || [];
      const doneCount = items.filter((t) => t.completed).length;
      if (!entry) {
        entry = p.codexCards[item.id] = codexToolCard(p, item, 'sparkles', '');
        el.appendChild(entry.el);
        entry.pre = document.createElement('pre');
        entry.body.appendChild(entry.pre);
      }
      entry.subEl.textContent = `${doneCount}/${items.length}`;
      entry.pre.textContent = items
        .map((t) => (t.completed ? '☑ ' : '☐ ') + t.text)
        .join('\n');
      if (done) setCodexCardState(entry, 'completed');
      break;
    }
    case 'error': {
      const d = document.createElement('div');
      d.className = 'chat-err';
      d.textContent = '오류: ' + (item.message || '');
      el.appendChild(d);
      break;
    }
  }
  scrollChat(p, el);
}

function codexErrLine(p, message) {
  const d = document.createElement('div');
  d.className = 'chat-err';
  d.textContent = '오류: ' + message;
  p.codexChatEl.appendChild(d);
  scrollChat(p, p.codexChatEl);
  setCodexBusy(p, false);
}

window.api.onCodexEvent(({ projectId, event: ev }) => {
  const p = projectById(projectId);
  if (!p) return;
  switch (ev.type) {
    case 'turn.started':
      setCodexBusy(p, true);
      break;
    case 'item.started':
    case 'item.updated':
      renderCodexItem(p, ev.item, false);
      break;
    case 'item.completed':
      renderCodexItem(p, ev.item, true);
      break;
    case 'turn.completed': {
      const u = ev.usage || {};
      const d = document.createElement('div');
      d.className = 'chat-result';
      d.textContent = `토큰 입력 ${u.input_tokens ?? '?'} · 출력 ${u.output_tokens ?? '?'}`;
      p.codexChatEl.appendChild(d);
      scrollChat(p, p.codexChatEl);
      setCodexBusy(p, false);
      break;
    }
    case 'turn.failed':
      codexErrLine(p, ev.error && ev.error.message ? ev.error.message : '턴 실패');
      break;
    case 'error':
      codexErrLine(p, ev.message || '알 수 없는 오류');
      break;
  }
});

window.api.onCodexError(({ projectId, message }) => {
  const p = projectById(projectId);
  if (p) codexErrLine(p, message);
});

// ============================================================================
// 협업 모드 — 상태 로그는 Claude 채팅에, 릴레이 말풍선은 수신자 채팅에 표시.
// ============================================================================
const collabToggle = document.getElementById('collab-toggle');
const collabRounds = document.getElementById('collab-rounds');
const collabManual = document.getElementById('collab-manual');

collabToggle.addEventListener('change', () =>
  window.api.setConfig({ collabEnabled: collabToggle.checked })
);
collabRounds.addEventListener('change', () =>
  window.api.setConfig({ collabRounds: collabRounds.value })
);
collabManual.addEventListener('change', () =>
  window.api.setConfig({ collabManual: collabManual.checked })
);

function collabNote(p, text) {
  clearEmpty(p, p.chatEl);
  const d = document.createElement('div');
  d.className = 'collab-status';
  d.textContent = '⇄ ' + text;
  p.chatEl.appendChild(d);
  scrollChat(p, p.chatEl);
}

window.api.onCollabStatus(({ projectId, text }) => {
  const p = projectById(projectId);
  if (!p) return;
  collabNote(p, text);
});

window.api.onCollabRelay(({ projectId, from, to, text, relayId }) => {
  const p = projectById(projectId);
  if (!p) return;
  const target = to === 'codex' ? p.codexChatEl : p.chatEl;
  clearEmpty(p, target);
  const wrap = document.createElement('div');
  wrap.className = 'relay-msg';
  const label = document.createElement('div');
  label.className = 'relay-label';
  label.textContent =
    (from === 'claude' ? '✳ Claude' : '◆ Codex') +
    ' → ' +
    (to === 'claude' ? '✳ Claude' : '◆ Codex');
  const body = document.createElement('div');
  body.className = 'relay-body';
  body.textContent = text;
  wrap.append(label, body);
  // 수동 릴레이: 승인해야 상대에게 전달된다.
  if (relayId) {
    const actions = document.createElement('div');
    actions.className = 'perm-actions';
    const respond = (approved) => {
      window.api.collabRelayApprove(relayId, approved);
      actions.remove();
      const tag = document.createElement('div');
      tag.className = 'relay-label';
      tag.textContent = approved ? '→ 전달됨' : '→ 중단됨';
      wrap.appendChild(tag);
    };
    const ok = document.createElement('button');
    ok.className = 'allow';
    ok.textContent = '전달';
    ok.onclick = () => respond(true);
    const no = document.createElement('button');
    no.className = 'deny';
    no.textContent = '중단';
    no.onclick = () => respond(false);
    actions.append(ok, no);
    wrap.appendChild(actions);
  }
  target.appendChild(wrap);
  scrollChat(p, target);
});

window.api.onCollabDone(({ projectId, text }) => {
  const p = projectById(projectId);
  if (!p) return;
  p.collabRunning = false;
  collabNote(p, '협업 종료 — ' + text);
  if (p.id === activeProjectId) applyChatBusyUI(p);
});

// --- sending ---
function sendChat() {
  const p = activeProject();
  const text = chatInput.value.trim();
  const images = pendingImages.slice();
  if ((!text && !images.length) || !p) return;

  // 협업 모드: 실행 중이면 개입 메시지, 아니면 새 협업 시작.
  if (p.collabRunning || (collabToggle.checked && text)) {
    if (images.length)
      return void showAttachWarn('협업 모드에서는 이미지 첨부를 지원하지 않습니다.');
    if (!text) return;
    chatInput.value = '';
    autosizeChatInput();
    if (p.collabRunning) {
      addUserBubble(p, '[개입] ' + text);
      window.api.collabInterject(p.id, text);
    } else {
      addUserBubble(p, text);
      p.collabRunning = true;
      applyChatBusyUI(p);
      window.api.collabStart({
        projectId: p.id,
        cwd: p.folder,
        text,
        maxRounds: parseInt(collabRounds.value, 10) || 2,
        manual: collabManual.checked,
        model: chatModel,
        effort: chatEffort,
        codexModel: codexChatModel,
      });
    }
    return;
  }

  // Codex 단독 채팅.
  if (p.activeEngine === 'codex') {
    if (p.codexBusy) return;
    if (images.length)
      return void showAttachWarn('Codex 채팅은 이미지 첨부를 아직 지원하지 않습니다.');
    if (!text) return;
    addUserBubble(p, text, [], p.codexChatEl);
    chatInput.value = '';
    autosizeChatInput();
    setCodexBusy(p, true);
    window.api.codexSend(p.id, p.folder, text, codexChatModel, chatEffort);
    return;
  }

  // Claude 단독 채팅 (기존 흐름).
  if (p.chatBusy) return;
  addUserBubble(p, text, images);

  // Build the message: plain string for text-only, else an array of content
  // blocks (base64 images first, then the text).
  let content;
  if (images.length) {
    content = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    }));
    if (text) content.push({ type: 'text', text });
  } else {
    content = text;
  }

  chatInput.value = '';
  autosizeChatInput();
  clearAttachments();
  setChatBusy(p, true);
  window.api.agentSend(content, p.folder, p.id, chatModel, chatEffort);
}
chatSend.addEventListener('click', sendChat);
chatStop.addEventListener('click', () => {
  const p = activeProject();
  if (!p) return;
  if (p.collabRunning) window.api.collabStop(p.id);
  else if (p.activeEngine === 'codex') window.api.codexInterrupt(p.id);
  else window.api.agentInterrupt(p.id);
});
document.getElementById('btn-chat-new').addEventListener('click', async () => {
  const p = activeProject();
  if (!p || p.collabRunning) return; // 협업 중에는 먼저 중단(■)부터
  if (p.activeEngine === 'codex') {
    await window.api.codexNew(p.id);
    p.codexChatEl.innerHTML = EMPTY_CODEX_HTML;
    p.codexCards = {};
    setCodexBusy(p, false);
    return;
  }
  await window.api.agentNew(p.id);
  p.chatEl.innerHTML = EMPTY_CHAT_HTML;
  p.toolCards = {};
  p.currentAssistant = null;
  setChatBusy(p, false);
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
function autosizeChatInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
}
chatInput.addEventListener('input', autosizeChatInput);

// --- panel toggle + resize ---
btnChat.addEventListener('click', () => {
  const hidden = chatPanel.classList.toggle('hidden');
  chatResizer.classList.toggle('hidden', hidden);
  btnChat.classList.toggle('active', !hidden);
  refitActiveTerminal(); // 패널 폭이 바뀌었으니 터미널 cols 재계산
  if (!hidden) chatInput.focus();
});
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault();
    if (chatPanel.classList.contains('hidden')) btnChat.click();
    else chatInput.focus();
  }
});

let resizingChat = false;
chatResizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  resizingChat = true;
  document.body.style.cursor = 'ew-resize';
});
window.addEventListener('mousemove', (e) => {
  if (!resizingChat) return;
  const w = Math.max(300, Math.min(window.innerWidth - e.clientX, 820));
  chatPanel.style.width = w + 'px';
  refitActiveTerminal();
});
window.addEventListener('mouseup', () => {
  if (resizingChat) {
    resizingChat = false;
    document.body.style.cursor = '';
    refitActiveTerminal();
  }
});

// ============================================================================
// Selection popup — copy the selected chat text, or quote it into the input
// as a follow-up question to Claude.
// ============================================================================
const selPop = document.getElementById('selection-pop');
const selCopyBtn = document.getElementById('sel-copy');
const selAskBtn = document.getElementById('sel-ask');
let selText = '';

function hideSelPop() {
  selPop.classList.add('hidden');
}

// Return the current selection only if it lies inside a chat message.
function getChatSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || !el.closest('.chat-scroll')) return null;
  return { text, range: sel.getRangeAt(0) };
}

chatHost.addEventListener('mouseup', () => {
  // Defer so the browser finalizes the selection first.
  setTimeout(() => {
    const s = getChatSelection();
    if (!s) return hideSelPop();
    selText = s.text;
    selPop.classList.remove('hidden');
    const rect = s.range.getBoundingClientRect();
    const pw = selPop.offsetWidth;
    const ph = selPop.offsetHeight;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = rect.top - ph - 8;
    if (top < 8) top = rect.bottom + 8;
    selPop.style.left = left + 'px';
    selPop.style.top = top + 'px';
  }, 0);
});

document.addEventListener('mousedown', (e) => {
  if (!selPop.contains(e.target)) hideSelPop();
});
chatHost.addEventListener('scroll', hideSelPop, true);

selCopyBtn.addEventListener('click', () => {
  window.api.writeClipboardText(selText);
  hideSelPop();
});
selAskBtn.addEventListener('click', () => {
  quoteToInput(selText);
  hideSelPop();
});

// Drop the selected text into the input as a quote, ready for a question.
function quoteToInput(text) {
  if (chatPanel.classList.contains('hidden')) btnChat.click();
  const quoted = text
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
  const cur = chatInput.value.trim();
  chatInput.value = (cur ? cur + '\n\n' : '') + quoted + '\n\n';
  autosizeChatInput();
  chatInput.focus();
  const end = chatInput.value.length;
  chatInput.setSelectionRange(end, end);
}

// ============================================================================
// Boot — reopen every previously-open project as a tab.
// ============================================================================
(async function boot() {
  const cfg = await window.api.getConfig();

  // Restore chat model / effort selection.
  chatModel = cfg.chatModel || '';
  codexChatModel = cfg.codexModel || '';
  chatEffort = cfg.chatEffort || 'high';
  modelSelect.value = chatModel;
  effortSelect.value = chatEffort;

  // Codex 모델 목록을 CLI 캐시에서 동적으로 채운다 (실패 시 HTML 기본 목록 유지).
  const codexModels = await window.api.codexModels();
  if (codexModels) {
    codexModelSelect.innerHTML = '<option value="">기본값</option>';
    for (const m of codexModels) {
      const opt = document.createElement('option');
      opt.value = m.slug;
      opt.textContent = m.name;
      codexModelSelect.appendChild(opt);
    }
  }
  codexModelSelect.value = codexChatModel;
  // 저장해둔 모델이 목록에서 사라졌으면 기본값으로 되돌린다.
  if (codexModelSelect.value !== codexChatModel) {
    codexChatModel = '';
    codexModelSelect.value = '';
  }

  // Restore 협업 모드 settings.
  collabToggle.checked = !!cfg.collabEnabled;
  collabRounds.value = cfg.collabRounds || '2';
  collabManual.checked = !!cfg.collabManual;

  const folders =
    cfg.openFolders && cfg.openFolders.length
      ? cfg.openFolders
      : cfg.lastFolder
      ? [cfg.lastFolder]
      : [];

  for (const folder of folders) {
    try {
      await addProject(folder);
    } catch {
      /* folder may no longer exist */
    }
  }

  // Restore which project was active.
  const target =
    projects.find((p) => p.folder === cfg.activeFolder) || projects[0];
  if (target && target.id !== activeProjectId) await switchProject(target.id);
})();
