'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wanNet', {
  startTunnel     : (port, opts) => ipcRenderer.invoke('start-tunnel', port, opts),
  stopTunnel      : (port)       => ipcRenderer.invoke('stop-tunnel', port),
  deleteTunnel    : (port)       => ipcRenderer.invoke('delete-tunnel', port),
  deleteAllTunnels: ()           => ipcRenderer.invoke('delete-all-tunnels'),
  listTunnels     : ()           => ipcRenderer.invoke('list-tunnels'),
  getInspPort     : ()           => ipcRenderer.invoke('get-insp-port'),
  getVersion      : ()           => ipcRenderer.invoke('get-version'),
  openInspector   : ()           => ipcRenderer.invoke('open-inspector'),
  openExternal    : (url)        => ipcRenderer.invoke('open-external', url),
  openSettings    : ()           => ipcRenderer.invoke('open-settings'),
  copyText        : (text)       => ipcRenderer.invoke('copy-text', text),
  showNotification: (title, body)=> ipcRenderer.invoke('show-notification', title, body),
  generateQR      : (url)        => ipcRenderer.invoke('generate-qr', url),
  setLabel        : (port, label)        => ipcRenderer.invoke('set-label', port, label),
  toggleAutoStart : (port)               => ipcRenderer.invoke('toggle-autostart', port),
  setRateLimit    : (key, maxReq, winMs) => ipcRenderer.invoke('set-rate-limit', key, maxReq, winMs),

  // Cloudflare login & named tunnel
  cfLoginStatus    : ()        => ipcRenderer.invoke('cf:login-status'),
  cfLogin          : ()        => ipcRenderer.invoke('cf:login'),
  cfLoginCancel    : ()        => ipcRenderer.invoke('cf:login-cancel'),
  cfLoginApiToken  : (opts)    => ipcRenderer.invoke('cf:login-api-token', opts),
  cfLogout         : ()        => ipcRenderer.invoke('cf:logout'),
  cfTunnelList  : ()                     => ipcRenderer.invoke('cf:tunnel-list'),
  cfDeleteDomain: (port)                 => ipcRenderer.invoke('cf:delete-domain', port),
  cfCreateTunnel    : (name)                           => ipcRenderer.invoke('cf:create-tunnel', name),
  cfAddDNSRoute     : (tunnelName, hostname)           => ipcRenderer.invoke('cf:add-dns-route', tunnelName, hostname),
  cfGetRoutes       : ()                               => ipcRenderer.invoke('cf:get-routes'),
  cfAddRoute        : (opts)                           => ipcRenderer.invoke('cf:add-route', opts),
  cfRemoveRoute     : (hostname)                       => ipcRenderer.invoke('cf:remove-route', hostname),
  cfDeleteTunnelNamed: (name)                          => ipcRenderer.invoke('cf:delete-tunnel-named', name),

  // Cloudflare API (DNS / CNAME)
  cfGetApiConfig  : ()       => ipcRenderer.invoke('cf:get-api-config'),
  cfSaveApiConfig : (opts)   => ipcRenderer.invoke('cf:save-api-config', opts),
  cfListDnsRecords: ()       => ipcRenderer.invoke('cf:list-dns-records'),
  cfAddCname      : (opts)   => ipcRenderer.invoke('cf:add-cname', opts),
  cfDeleteCname   : (opts)   => ipcRenderer.invoke('cf:delete-cname', opts),

  onTunnelUpdate: (cb) => {
    ipcRenderer.on('tunnel-update', (_evt, tunnels) => cb(tunnels));
  },
  checkForUpdate        : ()   => ipcRenderer.invoke('check-for-update'),
  startDownloadUpdate   : ()   => ipcRenderer.invoke('start-download-update'),
  onUpdateAvailable     : (cb) => ipcRenderer.on('update-available',      (_e, info) => cb(info)),
  onUpdateNotAvailable  : (cb) => ipcRenderer.on('update-not-available',  (_e)       => cb()),
  onDownloadProgress    : (cb) => ipcRenderer.on('download-progress',     (_e, prog) => cb(prog)),
  onUpdateDownloaded    : (cb) => ipcRenderer.on('update-downloaded',     (_e, info) => cb(info)),
  onUpdateError         : (cb) => ipcRenderer.on('update-error',          (_e, err)  => cb(err)),
  onTriggerCheckUpdate  : (cb) => ipcRenderer.on('trigger-check-update',  ()         => cb()),
  installUpdate         : ()   => ipcRenderer.invoke('install-update'),
});

// Super App hub bridge (optional)
try {
  contextBridge.exposeInMainWorld('superApp', {
    showHub: () => ipcRenderer.invoke('super:showHub'),
    openModule: (id) => ipcRenderer.invoke('super:openModule', id),
  });
} catch {
  /* already exposed */
}
