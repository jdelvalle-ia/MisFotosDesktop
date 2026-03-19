import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    ping: () => ipcRenderer.invoke('ping'),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    readImage: (filePath: string) => ipcRenderer.invoke('read-image', filePath),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
    getScannedDirectories: () => ipcRenderer.invoke('get-scanned-directories'),
    saveScannedDirectory: (dirPath: string) => ipcRenderer.invoke('save-scanned-directory', dirPath),
    scanDirectory: (dirPath: string) => ipcRenderer.invoke('scan-directory', dirPath),
    selectFiles: () => ipcRenderer.invoke('select-files'),
    saveCsv: (filePath: string, data: any) => ipcRenderer.invoke('save-csv', filePath, data),
    loadCsv: (filePath: string) => ipcRenderer.invoke('load-csv', filePath),
    analyzeImage: (filePath: string, prompt?: string) => ipcRenderer.invoke('analyze-image', filePath, prompt)
});
