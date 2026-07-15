'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewer', {
  onPhotos: (cb) => ipcRenderer.on('viewer-photos', (_e, data) => cb(data)),
});
