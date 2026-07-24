const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("superApp", {
  getSettings: () => ipcRenderer.invoke("super:getSettings"),
  setSetting: (key, value) => ipcRenderer.invoke("super:setSetting", key, value),
  setSettings: (patch) => ipcRenderer.invoke("super:setSettings", patch),
  openModule: (id) => ipcRenderer.invoke("super:openModule", id),
  showHub: () => ipcRenderer.invoke("super:showHub"),
  moduleState: () => ipcRenderer.invoke("super:moduleState"),
  getVersion: () => ipcRenderer.invoke("super:getVersion"),
  getUpdateStatus: () => ipcRenderer.invoke("super:getUpdateStatus"),
  checkForUpdates: () => ipcRenderer.invoke("super:checkForUpdates"),
  downloadUpdate: () => ipcRenderer.invoke("super:downloadUpdate"),
  installUpdate: () => ipcRenderer.invoke("super:installUpdate"),
  onUpdateStatus: (cb) => {
    const handler = (_event, status) => {
      try {
        cb(status);
      } catch {
        /* ignore renderer callback errors */
      }
    };
    ipcRenderer.on("super:updateStatus", handler);
    return () => ipcRenderer.removeListener("super:updateStatus", handler);
  },
});
