'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * preload.js — exposes a safe IPC bridge to the settings window renderer.
 * Only the settings window loads this preload; the main inspector window
 * uses no preload (it's a regular web page served over HTTP).
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /** Get the current saved config: { ports: number[], pass: string } */
  getConfig: () => ipcRenderer.invoke('get-config'),

  /** Save new config. Returns { ok: boolean, restart: boolean } */
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  /** Get runtime status: { inspPort, uptime, tunnels[] } */
  getStatus: () => ipcRenderer.invoke('get-status'),
});
