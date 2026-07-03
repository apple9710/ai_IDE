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
});
