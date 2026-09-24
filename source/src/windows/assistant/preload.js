const { contextBridge, ipcRenderer } = require('electron');
const { createElectronApi } = require('./preload/create-electron-api');
const {
  installRendererProfile,
  resolveRendererProfile
} = require('../../platform/renderer-profile');

console.log('Preload script loading...');

installRendererProfile(document, resolveRendererProfile());

try {
  contextBridge.exposeInMainWorld('electronAPI', createElectronApi(ipcRenderer));
  console.log('PreloadAPI: electronAPI exposed successfully');
} catch (error) {
  console.error('PreloadAPI: Failed to expose electronAPI:', error);
}

process.on('uncaughtException', (error) => {
  console.error('PreloadAPI: Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('PreloadAPI: Unhandled rejection at:', promise, 'reason:', reason);
});

console.log('PreloadAPI: Preload script loaded successfully');
