const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("superApp", {
  getSettings: () => ipcRenderer.invoke("super:getSettings"),
  setSetting: (key, value) => ipcRenderer.invoke("super:setSetting", key, value),
  setSettings: (patch) => ipcRenderer.invoke("super:setSettings", patch),
  openModule: (id) => ipcRenderer.invoke("super:openModule", id),
  showHub: () => ipcRenderer.invoke("super:showHub"),
  moduleState: () => ipcRenderer.invoke("super:moduleState"),
  getVersion: () => ipcRenderer.invoke("super:getVersion"),
});
