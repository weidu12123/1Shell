'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__ONESHELL_RUNTIME__', 'desktop');
contextBridge.exposeInMainWorld('oneShellDesktop', {
  runtime: 'desktop',
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  setAutostartEnabled: enabled => ipcRenderer.invoke('desktop:set-autostart-enabled', Boolean(enabled)),
  setBackgroundEnabled: enabled => ipcRenderer.invoke('desktop:set-background-enabled', Boolean(enabled)),
});
