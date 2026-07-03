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
  // Model alias ('opus'/'sonnet'/'haiku'/'fable') — omit to use the CLI default.
  if (opts.model) options.model = opts.model;
  // Reasoning effort ('low'|'medium'|'high'|'xhigh'|'max').
  if (opts.effort) options.effort = opts.effort;

  const q = query({ prompt: input, options });
  chats.set(projectId, { query: q, input });

  (async () => {
    try {
      for await (const m of q) send('agent:message', { projectId, message: m });
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
    }
  })();
}

// `content` is either a plain string or an array of content blocks (text +
// base64 image blocks) so the renderer can attach images to a message.
ipcMain.handle('agent:send', async (_e, { content, cwd, projectId, model, effort }) => {
  if (!chats.has(projectId)) await startChat(cwd, projectId, { model, effort });
  chats.get(projectId).input.push({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  });
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
