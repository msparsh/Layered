// This preload script does not expose any Node.js functionality to the renderer,
// but it is required when contextIsolation is true. It maintains the default
// web APIs like localStorage, fetch, etc., while keeping the renderer isolated.

// No need to add any contextBridge exposure because the HTML uses only standard web APIs.
// The script is present to satisfy Electron's contextIsolation requirements.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    readJson: (relativePath) => ipcRenderer.invoke('read-json', relativePath),
    writeJsonAtomic: (relativePath, data) => ipcRenderer.invoke('write-json-atomic', relativePath, data),
    trashJson: (relativePath) => ipcRenderer.invoke('trash-json', relativePath) // 👈 New!
});
console.log("Preload script loaded (no extra APIs exposed)");
