'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openKmz:          () => ipcRenderer.invoke('open-kmz'),
  saveKmz:          (buffer, suggestedName) => ipcRenderer.invoke('save-kmz', { buffer, suggestedName }),
  openModel:        () => ipcRenderer.invoke('open-model'),
  openPhotos:       () => ipcRenderer.invoke('open-photos'),
  renamePhoto:      (oldName, newName) => ipcRenderer.invoke('rename-photo', { oldName, newName }),
  // Sessions
  saveSession:      (data) => ipcRenderer.invoke('save-session', data),
  loadSessions:     () => ipcRenderer.invoke('load-sessions'),
  deleteSession:    (id) => ipcRenderer.invoke('delete-session', id),
  loadSessionData:  (session) => ipcRenderer.invoke('load-session-data', session),
  setZoomFactor:    (f) => webFrame.setZoomFactor(f),
  getZoomFactor:    () => webFrame.getZoomFactor(),
  openImageViewer:  (photos, index, filter, scope) => ipcRenderer.invoke('open-image-viewer', { photos, index, filter, scope }),
  newSession:       () => ipcRenderer.invoke('new-session'),
  // Recent files (load individually without re-browsing)
  getRecents:       () => ipcRenderer.invoke('get-recents'),
  removeRecent:     (kind, path) => ipcRenderer.invoke('remove-recent', { kind, path }),
  loadRecentModel:  (dir) => ipcRenderer.invoke('load-recent-model', dir),
  loadRecentPhotos: (dir) => ipcRenderer.invoke('load-recent-photos', dir),
  loadRecentRoute:  (filePath) => ipcRenderer.invoke('load-recent-route', filePath),
});
