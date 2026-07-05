import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fastnote', {
  platform: process.platform,
  isElectron: true,
  getDataDirectory: () => ipcRenderer.invoke('fastnote:getDataDirectory') as Promise<string>,
  getDefaultDataDirectory: () => ipcRenderer.invoke('fastnote:getDefaultDataDirectory') as Promise<string>,
  setDataDirectory: (dir: string) => ipcRenderer.invoke('fastnote:setDataDirectory', dir) as Promise<string>,
  pickStorageDirectory: () => ipcRenderer.invoke('fastnote:pickStorageDirectory') as Promise<string | null>,
  getUserDataPath: () => ipcRenderer.invoke('fastnote:getUserDataPath') as Promise<string>,
  openUserDataFolder: () => ipcRenderer.invoke('fastnote:openUserDataFolder') as Promise<void>,
});
