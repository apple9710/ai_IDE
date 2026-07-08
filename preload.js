const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // folder / files
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  readFileBinary: (filePath) =>
    ipcRenderer.invoke('fs:readFileBinary', filePath),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:readImage'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  writeFile: (filePath, content) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),
  createFile: (dir, name) => ipcRenderer.invoke('fs:createFile', dir, name),
  createFolder: (dir, name) => ipcRenderer.invoke('fs:createFolder', dir, name),
  rename: (oldPath, newName) => ipcRenderer.invoke('fs:rename', oldPath, newName),
  delete: (targetPath) => ipcRenderer.invoke('fs:delete', targetPath),

  // git
  gitStatus: (folder) => ipcRenderer.invoke('git:status', folder),

  // terminal (pty)
  ptySpawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) =>
    ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: (cb) =>
    ipcRenderer.on('pty:data', (_e, payload) => cb(payload)),
  onPtyExit: (cb) =>
    ipcRenderer.on('pty:exit', (_e, payload) => cb(payload)),

  // Claude Agent SDK (chat) — scoped per project
  agentSend: (content, cwd, projectId, model, effort) =>
    ipcRenderer.invoke('agent:send', { content, cwd, projectId, model, effort }),
  agentInterrupt: (projectId) =>
    ipcRenderer.invoke('agent:interrupt', { projectId }),
  agentNew: (projectId) => ipcRenderer.invoke('agent:new', { projectId }),
  agentSetModel: (projectId, model) =>
    ipcRenderer.invoke('agent:set-model', { projectId, model }),
  agentRespondPermission: (id, behavior, message) =>
    ipcRenderer.send('agent:permission-response', { id, behavior, message }),
  onAgentMessage: (cb) =>
    ipcRenderer.on('agent:message', (_e, m) => cb(m)),
  onAgentPermission: (cb) =>
    ipcRenderer.on('agent:permission', (_e, p) => cb(p)),
  onAgentError: (cb) => ipcRenderer.on('agent:error', (_e, p) => cb(p)),
  onAgentClosed: (cb) => ipcRenderer.on('agent:closed', (_e, p) => cb(p)),

  // OpenAI Codex SDK (chat) — scoped per project
  codexSend: (projectId, cwd, text, model, effort, sandbox) =>
    ipcRenderer.invoke('codex:send', { projectId, cwd, text, model, effort, sandbox }),
  codexInterrupt: (projectId) =>
    ipcRenderer.invoke('codex:interrupt', { projectId }),
  codexNew: (projectId) => ipcRenderer.invoke('codex:new', { projectId }),
  codexModels: () => ipcRenderer.invoke('codex:models'),
  onCodexEvent: (cb) => ipcRenderer.on('codex:event', (_e, p) => cb(p)),
  onCodexError: (cb) => ipcRenderer.on('codex:error', (_e, p) => cb(p)),

  // 협업 모드 (Claude ⇄ Codex orchestrator)
  collabStart: (opts) => ipcRenderer.invoke('collab:start', opts),
  collabStop: (projectId) => ipcRenderer.invoke('collab:stop', { projectId }),
  collabInterject: (projectId, text) =>
    ipcRenderer.invoke('collab:interject', { projectId, text }),
  collabRelayApprove: (relayId, approved) =>
    ipcRenderer.send('collab:relay-approve', { relayId, approved }),
  onCollabStatus: (cb) => ipcRenderer.on('collab:status', (_e, p) => cb(p)),
  onCollabRelay: (cb) => ipcRenderer.on('collab:relay', (_e, p) => cb(p)),
  onCollabDone: (cb) => ipcRenderer.on('collab:done', (_e, p) => cb(p)),
});
