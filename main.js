const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('@lydell/node-pty');

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ---- Config (auto-run command, last folder) --------------------------------
const CONFIG_PATH = path.join(app.getPath('userData'), 'claude-ide-config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { autoRunCommand: 'claude', lastFolder: null };
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

let config = loadConfig();

// ---- Window ----------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    title: 'Claude IDE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true, // enable Chromium's built-in PDF viewer
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Forward renderer console + crashes to the main-process stdout for debugging.
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    console.log('[renderer]', message);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log('[render-process-gone]', JSON.stringify(details));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- Config IPC ------------------------------------------------------------
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e, patch) => {
  config = { ...config, ...patch };
  saveConfig(config);
  return config;
});

// ---- Folder / file IPC -----------------------------------------------------
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folder = result.filePaths[0];
  config = { ...config, lastFolder: folder };
  saveConfig(config);
  return folder;
});

// Read a directory (one level). Returns sorted [{name, path, isDir}]
ipcMain.handle('fs:readDir', async (_e, dirPath) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const result = entries
    .filter((d) => d.name !== '.git' || true) // keep everything; hidden shown too
    .map((d) => ({
      name: d.name,
      path: path.join(dirPath, d.name),
      isDir: d.isDirectory(),
    }));
  result.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
});

// Read a file's text content. Guards against huge/binary files.
ipcMain.handle('fs:readFile', async (_e, filePath) => {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > 5 * 1024 * 1024) {
    return { error: 'File too large to display (> 5 MB).' };
  }
  const buf = await fs.promises.readFile(filePath);
  // Simple binary detection: NUL byte in first chunk.
  const sample = buf.subarray(0, 8000);
  if (sample.includes(0)) {
    return { error: 'Binary file — cannot display as text.' };
  }
  return { content: buf.toString('utf8'), path: filePath };
});

// Read a file as base64 for in-editor viewing of binary formats (PDF, images).
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};
function mimeForPath(p) {
  return MIME_BY_EXT[p.split('.').pop().toLowerCase()] || 'application/octet-stream';
}
ipcMain.handle('fs:readFileBinary', async (_e, filePath) => {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 100 * 1024 * 1024) {
      return { error: 'File too large to display (> 100 MB).' };
    }
    const buf = await fs.promises.readFile(filePath);
    return { base64: buf.toString('base64'), mime: mimeForPath(filePath) };
  } catch (e) {
    return { error: e.message };
  }
});

// Read an image sitting on the OS clipboard as a native bitmap (e.g. copied
// from KakaoTalk via right-click > copy). The DOM paste event doesn't surface
// CF_DIB/CF_BITMAP, so the renderer falls back to this.
ipcMain.handle('clipboard:readImage', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    return { base64: img.toPNG().toString('base64'), mediaType: 'image/png' };
  } catch {
    return null;
  }
});

// Write text to the OS clipboard (used by chat message "copy" actions —
// avoids navigator.clipboard secure-context caveats under file://).
ipcMain.handle('clipboard:writeText', (_e, text) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
  } catch {
    /* ignore */
  }
  return { ok: true };
});

ipcMain.handle('fs:writeFile', async (_e, filePath, content) => {
  await fs.promises.writeFile(filePath, content, 'utf8');
  return { ok: true };
});

// Create a new empty file. `dir` is the parent, `name` the filename.
ipcMain.handle('fs:createFile', async (_e, dir, name) => {
  const target = path.join(dir, name);
  try {
    await fs.promises.access(target);
    return { error: '이미 같은 이름의 항목이 있습니다.' };
  } catch {
    /* does not exist — good */
  }
  await fs.promises.writeFile(target, '', { flag: 'wx' });
  return { ok: true, path: target };
});

ipcMain.handle('fs:createFolder', async (_e, dir, name) => {
  const target = path.join(dir, name);
  try {
    await fs.promises.mkdir(target);
  } catch (e) {
    return { error: e.code === 'EEXIST' ? '이미 존재합니다.' : e.message };
  }
  return { ok: true, path: target };
});

ipcMain.handle('fs:rename', async (_e, oldPath, newName) => {
  const target = path.join(path.dirname(oldPath), newName);
  try {
    await fs.promises.rename(oldPath, target);
  } catch (e) {
    return { error: e.message };
  }
  return { ok: true, path: target };
});

// Delete a file or folder (recursive). Uses the OS trash-safe recursive rm.
ipcMain.handle('fs:delete', async (_e, targetPath) => {
  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
  } catch (e) {
    return { error: e.message };
  }
  return { ok: true };
});

// ---- Git IPC ---------------------------------------------------------------
// Returns { isRepo, branch, root, files: { absolutePath: statusCode } }.
ipcMain.handle('git:status', async (_e, folder) => {
  if (!folder) return { isRepo: false };
  let root;
  try {
    root = (await runGit(['rev-parse', '--show-toplevel'], folder)).trim();
  } catch {
    return { isRepo: false };
  }

  let branch = '';
  try {
    branch = (await runGit(['branch', '--show-current'], folder)).trim();
    if (!branch) {
      // Detached HEAD — show short sha.
      branch = '(' + (await runGit(['rev-parse', '--short', 'HEAD'], folder)).trim() + ')';
    }
  } catch {
    branch = '';
  }

  const files = {};
  try {
    const out = await runGit(['status', '--porcelain'], folder);
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      let p = line.slice(3);
      // Rename/copy lines look like "old -> new"; keep the new path.
      const arrow = p.indexOf(' -> ');
      if (arrow !== -1) p = p.slice(arrow + 4);
      // Porcelain may quote paths with special chars; strip surrounding quotes.
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      const abs = path.resolve(root, p);
      files[abs] = code.trim() || code;
    }
  } catch {
    /* ignore */
  }

  return { isRepo: true, branch, root, files };
});

// ---- PTY (terminal) IPC ----------------------------------------------------
const terminals = new Map(); // id -> pty process

function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || 'bash';
}

ipcMain.handle('pty:spawn', (event, { id, cwd, cols, rows, autoRun }) => {
  const shell = defaultShell();
  const shellArgs =
    process.platform === 'win32' ? [] : ['-l'];

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: process.env,
  });

  terminals.set(id, ptyProcess);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode });
    }
    terminals.delete(id);
  });

  return { ok: true };
});

ipcMain.on('pty:write', (_e, { id, data }) => {
  const proc = terminals.get(id);
  if (proc) proc.write(data);
});

ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  const proc = terminals.get(id);
  if (proc) {
    try {
      proc.resize(cols, rows);
    } catch {
      /* ignore resize race */
    }
  }
});

ipcMain.on('pty:kill', (_e, { id }) => {
  const proc = terminals.get(id);
  if (proc) {
    proc.kill();
    terminals.delete(id);
  }
});

// ---- Claude Agent SDK (chat) ----------------------------------------------
// The SDK is ESM-only; load it lazily via dynamic import from CommonJS.
let sdkModule = null;
async function getSdk() {
  if (!sdkModule) sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  return sdkModule;
}

// Locate the platform-native `claude` binary the SDK ships with. When packaged
// it lives inside `app.asar`, which the OS cannot execute — electron-builder
// unpacks it (see asarUnpack), so rewrite the path to `app.asar.unpacked`.
function claudeExecutablePath() {
  const bin = 'claude' + (process.platform === 'win32' ? '.exe' : '');
  try {
    const p = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${bin}`
    );
    return p.replace(
      `app.asar${path.sep}`,
      `app.asar.unpacked${path.sep}`
    );
  } catch {
    return undefined; // fall back to the SDK's own resolution (dev / global CLI)
  }
}

// Each open project keeps its own Claude session so switching project tabs
// preserves the running conversation. Keyed by the renderer's projectId.
const chats = new Map(); // projectId -> { query, input }
const pendingPermissions = new Map(); // permId -> { resolve, suggestions, projectId }
let permCounter = 0;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, payload);
}

// A push-able async iterable used as the streaming prompt for one chat session.
function makeInputStream() {
  const queue = [];
  let waiter = null;
  let ended = false;
  return {
    push(msg) {
      if (waiter) {
        waiter({ value: msg, done: false });
        waiter = null;
      } else queue.push(msg);
    },
    end() {
      ended = true;
      if (waiter) {
        waiter({ value: undefined, done: true });
        waiter = null;
      }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (ended) return;
        const r = await new Promise((res) => (waiter = res));
        if (r.done) return;
        yield r.value;
      }
    },
  };
}

async function startChat(cwd, projectId, opts) {
  const { query } = await getSdk();
  const input = makeInputStream();
  opts = opts || {};

  // Permission prompt: forward to the renderer and await the user's choice.
  const canUseTool = (toolName, toolInput, opts) =>
    new Promise((resolve) => {
      const id = 'perm-' + ++permCounter;
      pendingPermissions.set(id, {
        resolve,
        suggestions: opts.suggestions,
        projectId,
      });
      send('agent:permission', {
        projectId,
        id,
        toolName,
        input: toolInput,
        title: opts.title,
        displayName: opts.displayName,
        description: opts.description,
      });
    });

  const options = {
    cwd: cwd || config.lastFolder || os.homedir(),
    permissionMode: 'default',
    canUseTool,
    includePartialMessages: true,
    stderr: (d) => console.error('[claude]', d),
  };
  // Point the SDK at the unpacked native binary (required in a packaged build).
  const exe = claudeExecutablePath();
  if (exe) options.pathToClaudeCodeExecutable = exe;
  // Model alias ('opus'/'sonnet'/'haiku'/'fable') — omit to use the CLI default.
  if (opts.model) options.model = opts.model;
  // Reasoning effort ('low'|'medium'|'high'|'xhigh'|'max').
  if (opts.effort) options.effort = opts.effort;

  const q = query({ prompt: input, options });
  chats.set(projectId, { query: q, input });

  (async () => {
    try {
      for await (const m of q) {
        send('agent:message', { projectId, message: m });
        // Let the collab orchestrator (or any waiter) observe turn completion.
        if (m.type === 'result') resolveClaudeTurn(projectId, m);
      }
    } catch (e) {
      send('agent:error', {
        projectId,
        message: String(e && e.message ? e.message : e),
      });
    } finally {
      // Reject any dangling permission prompts for this project so its UI
      // doesn't hang; leave other projects' prompts untouched.
      for (const [pid, entry] of [...pendingPermissions.entries()]) {
        if (entry.projectId !== projectId) continue;
        entry.resolve({ behavior: 'deny', message: 'session ended' });
        pendingPermissions.delete(pid);
      }
      send('agent:closed', { projectId });
      chats.delete(projectId);
      resolveClaudeTurn(projectId, null); // unblock a collab waiting on this session
    }
  })();
}

// Turn waiters: the collab orchestrator needs to know when a Claude turn ends.
// Normal chat traffic resolves with no waiters registered (no-op).
const claudeTurnWaiters = new Map(); // projectId -> [resolve]
function awaitClaudeResult(projectId) {
  return new Promise((resolve) => {
    const arr = claudeTurnWaiters.get(projectId) || [];
    arr.push(resolve);
    claudeTurnWaiters.set(projectId, arr);
  });
}
function resolveClaudeTurn(projectId, m) {
  const arr = claudeTurnWaiters.get(projectId);
  if (!arr) return;
  claudeTurnWaiters.delete(projectId);
  for (const r of arr) r(m);
}

async function sendToClaude(projectId, cwd, content, opts) {
  if (!chats.has(projectId)) await startChat(cwd, projectId, opts || {});
  chats.get(projectId).input.push({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  });
}

// `content` is either a plain string or an array of content blocks (text +
// base64 image blocks) so the renderer can attach images to a message.
ipcMain.handle('agent:send', async (_e, { content, cwd, projectId, model, effort }) => {
  await sendToClaude(projectId, cwd, content, { model, effort });
  return { ok: true };
});

ipcMain.handle('agent:interrupt', async (_e, { projectId }) => {
  const chat = chats.get(projectId);
  if (chat && chat.query) {
    try {
      await chat.query.interrupt();
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
});

ipcMain.handle('agent:new', async (_e, { projectId }) => {
  const chat = chats.get(projectId);
  if (chat) {
    chat.input.end();
    try {
      await chat.query.interrupt();
    } catch {
      /* ignore */
    }
    chats.delete(projectId);
  }
  return { ok: true };
});

// Change the model of an already-running session (applies to the next turn).
ipcMain.handle('agent:set-model', async (_e, { projectId, model }) => {
  const chat = chats.get(projectId);
  if (chat && chat.query && typeof chat.query.setModel === 'function') {
    try {
      await chat.query.setModel(model || undefined);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
});

ipcMain.on('agent:permission-response', (_e, { id, behavior, message }) => {
  const entry = pendingPermissions.get(id);
  if (!entry) return;
  pendingPermissions.delete(id);
  if (behavior === 'allow') {
    entry.resolve({ behavior: 'allow' });
  } else if (behavior === 'allow-always') {
    entry.resolve({
      behavior: 'allow',
      updatedPermissions: entry.suggestions || undefined,
    });
  } else {
    entry.resolve({
      behavior: 'deny',
      message: message || '사용자가 거부했습니다.',
    });
  }
});

// ---- OpenAI Codex SDK (chat) ------------------------------------------------
// Same ESM story as the Claude SDK: load lazily via dynamic import.
let codexSdkModule = null;
async function getCodexSdk() {
  if (!codexSdkModule) codexSdkModule = await import('@openai/codex-sdk');
  return codexSdkModule;
}

// Same asar story as claudeExecutablePath: the platform package ships a native
// codex.exe that cannot run from inside app.asar — point the SDK at the
// unpacked copy (see asarUnpack in package.json).
function codexExecutablePath() {
  const bin = 'codex' + (process.platform === 'win32' ? '.exe' : '');
  try {
    const pkgJson = require.resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`
    );
    const root = path
      .dirname(pkgJson)
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const vendor = path.join(root, 'vendor');
    for (const triple of fs.readdirSync(vendor)) {
      const p = path.join(vendor, triple, 'bin', bin);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* fall back to the SDK's own resolution (dev) */
  }
  return undefined;
}

// Codex reasoning effort has no 'max'; Claude-side 'max' maps to 'xhigh'.
const CODEX_EFFORT = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

// One Codex thread per project, like `chats` for Claude. Sandbox is fixed at
// thread creation: standalone chat gets workspace-write, a collab-created
// reviewer thread gets read-only.
const codexChats = new Map(); // projectId -> { thread, threadOpts, model, abort, busy }

async function ensureCodexThread(projectId, cwd, opts) {
  opts = opts || {};
  const { Codex } = await getCodexSdk();
  const codexOpts = {};
  const exe = codexExecutablePath();
  if (exe) codexOpts.codexPathOverride = exe;

  const wantModel = opts.model || '';
  let entry = codexChats.get(projectId);
  if (entry) {
    // 모델이 바뀌면 같은 대화를 새 모델로 이어간다 (~/.codex/sessions 영속화).
    if (wantModel !== entry.model && !entry.busy) {
      const threadOpts = { ...entry.threadOpts };
      if (wantModel) threadOpts.model = wantModel;
      else delete threadOpts.model;
      entry.thread = entry.thread.id
        ? new Codex(codexOpts).resumeThread(entry.thread.id, threadOpts)
        : new Codex(codexOpts).startThread(threadOpts);
      entry.threadOpts = threadOpts;
      entry.model = wantModel;
    }
    return entry;
  }

  const threadOpts = {
    workingDirectory: cwd || config.lastFolder || os.homedir(),
    sandboxMode: opts.sandbox || 'workspace-write',
    skipGitRepoCheck: true,
    ...(wantModel ? { model: wantModel } : {}),
    ...(opts.effort
      ? { modelReasoningEffort: CODEX_EFFORT[opts.effort] || 'high' }
      : {}),
  };
  entry = {
    thread: new Codex(codexOpts).startThread(threadOpts),
    threadOpts,
    model: wantModel,
    abort: null,
    busy: false,
  };
  codexChats.set(projectId, entry);
  return entry;
}

// Run one streamed Codex turn, forwarding every event to the renderer.
// Resolves with the final agent text, or null on failure/abort/busy.
async function runCodexTurn(projectId, cwd, text, opts) {
  const entry = await ensureCodexThread(projectId, cwd, opts);
  if (entry.busy) return null;
  entry.busy = true;
  entry.abort = new AbortController();
  let finalText = '';
  try {
    const { events } = await entry.thread.runStreamed(text, {
      signal: entry.abort.signal,
    });
    for await (const ev of events) {
      send('codex:event', { projectId, event: ev });
      if (ev.type === 'item.completed' && ev.item.type === 'agent_message')
        finalText = ev.item.text;
      if (ev.type === 'turn.failed' || ev.type === 'error') finalText = null;
    }
  } catch (e) {
    send('codex:error', {
      projectId,
      message: String(e && e.message ? e.message : e),
    });
    finalText = null;
  } finally {
    entry.busy = false;
    entry.abort = null;
  }
  return finalText;
}

ipcMain.handle('codex:send', (_e, { projectId, cwd, text, model, effort, sandbox }) => {
  // Fire and forget — events stream back via codex:event.
  runCodexTurn(projectId, cwd, text, { model, effort, sandbox });
  return { ok: true };
});

ipcMain.handle('codex:interrupt', (_e, { projectId }) => {
  const entry = codexChats.get(projectId);
  if (entry && entry.abort) entry.abort.abort();
  return { ok: true };
});

ipcMain.handle('codex:new', (_e, { projectId }) => {
  const entry = codexChats.get(projectId);
  if (entry && entry.abort) entry.abort.abort();
  codexChats.delete(projectId);
  return { ok: true };
});

// 사용 가능한 Codex 모델 목록 — CLI가 서버에서 받아 캐시한 파일을 읽는다.
// 계정에 새 모델이 열리면 다음 실행 때 드롭다운에 자동 반영된다.
ipcMain.handle('codex:models', async () => {
  try {
    const raw = await fs.promises.readFile(
      path.join(os.homedir(), '.codex', 'models_cache.json'),
      'utf8'
    );
    const models = (JSON.parse(raw).models || [])
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ slug: m.slug, name: m.display_name || m.slug }));
    return models.length ? models : null;
  } catch {
    return null; // 캐시 없음 — 렌더러는 HTML의 기본 목록을 유지
  }
});

// ---- 협업 모드 (Claude ⇄ Codex orchestrator) --------------------------------
// Relay loop: Claude drafts a plan → Codex (read-only) reviews → Claude revises
// — up to maxRounds or until Claude emits the [합의완료] marker — then Claude
// executes through the normal permission-card flow.
const collabs = new Map(); // projectId -> { cancelled, manual, interjections }
const pendingRelays = new Map(); // relayId -> { projectId, resolve }
let relayCounter = 0;

function collabStatus(projectId, text) {
  send('collab:status', { projectId, text });
}

// Show the handoff in the target chat; in manual mode wait for the user to
// approve it. Resolves false when denied or the collab was cancelled.
function relayGate(projectId, from, to, text) {
  const c = collabs.get(projectId);
  if (!c || c.cancelled) return Promise.resolve(false);
  if (!c.manual) {
    send('collab:relay', { projectId, from, to, text });
    return Promise.resolve(true);
  }
  const id = 'relay-' + ++relayCounter;
  send('collab:relay', { projectId, from, to, text, relayId: id });
  return new Promise((resolve) =>
    pendingRelays.set(id, { projectId, resolve })
  );
}

function finishCollab(projectId, text) {
  collabs.delete(projectId);
  for (const [id, entry] of [...pendingRelays.entries()]) {
    if (entry.projectId !== projectId) continue;
    entry.resolve(false);
    pendingRelays.delete(id);
  }
  send('collab:done', { projectId, text });
}

async function runCollab(projectId, cwd, userText, opts) {
  const c = { cancelled: false, manual: !!opts.manual, interjections: [] };
  collabs.set(projectId, c);
  const maxRounds = Math.max(1, Math.min(5, opts.maxRounds || 2));
  const claudeOpts = { model: opts.model, effort: opts.effort };

  // One Claude turn: send prompt (+ any queued user interjections), await result.
  const askClaude = async (prompt) => {
    if (c.cancelled) return null;
    const inter = c.interjections.splice(0);
    const full = inter.length
      ? prompt + '\n\n[사용자 개입 — 최우선으로 반영하라]\n' + inter.join('\n')
      : prompt;
    const waited = awaitClaudeResult(projectId);
    await sendToClaude(projectId, cwd, full, claudeOpts);
    const m = await waited;
    if (!m || m.subtype !== 'success' || c.cancelled) return null;
    return m.result || '';
  };

  try {
    collabStatus(
      projectId,
      `협업 시작 — Claude가 계획을 정리합니다 (최대 ${maxRounds}라운드)`
    );
    let claudeText = await askClaude(
      '[협업 모드] 너는 OpenAI Codex와 협업해 작업을 진행 중이다. 아래 사용자 요청을 분석해 구현 계획을 정리하라.\n' +
        '- 이 단계에서는 파일을 수정하거나 상태를 바꾸는 명령을 실행하지 마라 (읽기/탐색은 허용).\n' +
        '- 답변은 Codex에게 그대로 전달된다. 검토받을 계획과 근거를 명확하게 써라.\n\n' +
        '[사용자 요청]\n' +
        userText
    );
    if (claudeText == null) return finishCollab(projectId, '중단됨');

    let agreed = false;
    for (let round = 1; round <= maxRounds && !agreed; round++) {
      if (!(await relayGate(projectId, 'claude', 'codex', claudeText)))
        return finishCollab(projectId, '릴레이가 거부되어 중단됨');
      collabStatus(projectId, `라운드 ${round}/${maxRounds} — Codex가 검토 중…`);
      const codexText = await runCodexTurn(
        projectId,
        cwd,
        '[협업 모드] 너는 검토자다. Claude가 제안한 아래 계획을 검토해 동의하는 점, 문제점, 개선 제안을 간결하게 답하라.\n' +
          '파일은 읽기만 하라. 코드를 직접 수정하지 마라.\n\n[Claude의 계획]\n' +
          claudeText,
        { sandbox: 'read-only', effort: opts.effort, model: opts.codexModel }
      );
      if (codexText == null || c.cancelled)
        return finishCollab(projectId, '중단됨');

      if (!(await relayGate(projectId, 'codex', 'claude', codexText)))
        return finishCollab(projectId, '릴레이가 거부되어 중단됨');
      collabStatus(
        projectId,
        `라운드 ${round}/${maxRounds} — Claude가 의견을 반영 중…`
      );
      claudeText = await askClaude(
        '[협업 모드] Codex의 검토 의견이다. 타당한 지적은 반영하고, 동의하지 않으면 근거를 들어 반박하라.\n' +
          '합의에 도달했다고 판단하면 답변에 "[합의완료]"를 포함하고 최종 계획을 정리하라.\n\n[Codex 의견]\n' +
          codexText
      );
      if (claudeText == null) return finishCollab(projectId, '중단됨');
      agreed = claudeText.includes('[합의완료]');
    }

    collabStatus(
      projectId,
      agreed
        ? '합의 완료 — Claude가 작업을 실행합니다'
        : '라운드 상한 도달 — 현재 계획으로 작업을 실행합니다'
    );
    const result = await askClaude(
      '[협업 모드 — 실행 단계] 토론에서 정리한 최종 계획대로 이제 실제 작업을 수행하라. 필요한 파일 수정과 명령 실행을 진행하라.'
    );
    finishCollab(projectId, result == null ? '중단됨' : '작업 완료');
  } catch (e) {
    finishCollab(projectId, '오류: ' + String(e && e.message ? e.message : e));
  }
}

ipcMain.handle(
  'collab:start',
  (_e, { projectId, cwd, text, maxRounds, manual, model, effort, codexModel }) => {
    if (collabs.has(projectId))
      return { error: '이미 협업이 진행 중입니다.' };
    runCollab(projectId, cwd, text, { maxRounds, manual, model, effort, codexModel });
    return { ok: true };
  }
);

ipcMain.handle('collab:stop', (_e, { projectId }) => {
  const c = collabs.get(projectId);
  if (c) c.cancelled = true;
  // Interrupt whichever agent is mid-turn.
  const chat = chats.get(projectId);
  if (chat && chat.query) chat.query.interrupt().catch(() => {});
  const codex = codexChats.get(projectId);
  if (codex && codex.abort) codex.abort.abort();
  // Release a pending manual-relay gate so the loop can exit.
  for (const [id, entry] of [...pendingRelays.entries()]) {
    if (entry.projectId !== projectId) continue;
    entry.resolve(false);
    pendingRelays.delete(id);
  }
  return { ok: true };
});

// User typed a message while a collab is running — queue it for the next
// Claude turn instead of derailing the relay.
ipcMain.handle('collab:interject', (_e, { projectId, text }) => {
  const c = collabs.get(projectId);
  if (c) c.interjections.push(text);
  return { ok: !!c };
});

ipcMain.on('collab:relay-approve', (_e, { relayId, approved }) => {
  const entry = pendingRelays.get(relayId);
  if (!entry) return;
  pendingRelays.delete(relayId);
  entry.resolve(!!approved);
});
