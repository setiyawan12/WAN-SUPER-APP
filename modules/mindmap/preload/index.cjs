'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mindmapHost', {
  getFirebaseConfig: () => ipcRenderer.invoke('mindmap:getConfig'),
  reload: () => ipcRenderer.invoke('mindmap:reload'),
  showHub: () => ipcRenderer.invoke('super:showHub'),
  platform: process.platform,
  embedded: process.argv.includes('--wan-super-app-embed'),
});