'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const exifr = require('exifr');

// Minimal content-type map for files served over appfile:// (needed when we build
// our own Range responses for video seeking — net.fetch sets these for us otherwise).
function mimeForPath(p) {
  const ext = path.extname(p).toLowerCase();
  return ({
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.tif': 'image/tiff', '.tiff': 'image/tiff',
  })[ext] || 'application/octet-stream';
}

// appfile:// serves files from directories the user explicitly opens.
// Roots are namespaced PER WINDOW so multiple sessions (New window) don't clash:
// keys are "model-<webContentsId>" / "photos-<webContentsId>". The URL hostname carries
// that id, e.g. appfile://photos-3/DJI_0001.JPG.
const roots = {};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appfile',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

let win; // most-recently-created window (fallback dialog parent)

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const w = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1116',
    title: 'Route View — offline route viewer',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win = w;
  const wcId = w.webContents.id; // capture now; webContents is destroyed by the time 'closed' fires
  // Windows/Linux: hide the menu bar (keeps the chrome-free look). macOS keeps its
  // global application menu — see setupMenu() — which is required for clipboard shortcuts.
  if (process.platform !== 'darwin') w.removeMenu();
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Free this window's file roots when it closes.
  w.on('closed', () => {
    delete roots[`model-${wcId}`];
    delete roots[`photos-${wcId}`];
    const vw = imageViewers.get(wcId); // close this window's image-viewer popup too
    if (vw && !vw.isDestroyed()) vw.close();
    imageViewers.delete(wcId);
    if (win === w) win = BrowserWindow.getAllWindows()[0] || null;
  });
  return w;
}

// Pick the BrowserWindow that sent an IPC message (for dialog parenting), falling back
// to the most recent window.
function winOf(e) { return BrowserWindow.fromWebContents(e.sender) || win; }

// Application menu. On macOS a real menu is required for standard shortcuts to work,
// including Cmd+C/V/X/A/Z inside text fields (route-name + image search) and Cmd+Q/W.
// On Windows/Linux we install no menu, preserving the original chrome-free UI.
function setupMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },   // About / Hide / Quit (Cmd+Q)
    { role: 'editMenu' },  // Undo/Redo/Cut/Copy/Paste/Select All (Cmd+Z/X/C/V/A)
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom', accelerator: 'Cmd+0' },
        { role: 'zoomIn', accelerator: 'Cmd+Plus' },
        { role: 'zoomOut', accelerator: 'Cmd+-' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' }, // Minimize (Cmd+M), Close Window (Cmd+W)
  ]));
}

app.whenReady().then(() => {
  setupMenu();
  // Serve files only from within an opened root, with traversal protection.
  protocol.handle('appfile', async (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname; // "model" | "photos"
      const root = roots[host];
      if (!root) return new Response('No root opened', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = path.resolve(root, rel);
      if (target !== root && !target.startsWith(root + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }

      // Honor HTTP Range requests so <video> seeking works. The browser sends
      // "Range: bytes=START-END"; we must reply 206 with that exact byte slice and
      // advertise Accept-Ranges, or the scrubber can't jump. (net.fetch of a file URL
      // returns the whole file as 200, which disables seeking.)
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const stat = await fsp.stat(target);
        const size = stat.size;
        const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= size) end = size - 1;
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        const nodeStream = fs.createReadStream(target, { start, end });
        return new Response(Readable.toWeb(nodeStream), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': mimeForPath(target),
          },
        });
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: KMZ open / save
// ---------------------------------------------------------------------------

ipcMain.handle('open-kmz', async (_e) => {
  const r = await dialog.showOpenDialog(winOf(_e), {
    title: 'Open route',
    filters: [{ name: 'DJI route', extensions: ['kmz'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  const buf = await fsp.readFile(filePath);
  await addRecent('routes', filePath, path.basename(filePath, path.extname(filePath)));
  return {
    path: filePath,
    name: path.basename(filePath, path.extname(filePath)),
    // transfer the bytes to the renderer
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
});

ipcMain.handle('save-kmz', async (_e, { buffer, suggestedName }) => {
  const r = await dialog.showSaveDialog(winOf(_e), {
    title: 'Export route for FlightHub 2',
    defaultPath: `${suggestedName || 'route-edited'}.kmz`,
    filters: [{ name: 'DJI route', extensions: ['kmz'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fsp.writeFile(r.filePath, Buffer.from(buffer));
  return { path: r.filePath };
});

// ---------------------------------------------------------------------------
// Helpers: model scan and photo load (shared by dialog-based and session-based paths)
// ---------------------------------------------------------------------------

async function scanModelFromDir(dir, wcId) {
  const host = `model-${wcId}`;
  roots[host] = path.resolve(dir);
  const walk = async (d, depth, hits) => {
    if (depth > 3) return hits;
    let items = [];
    try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return hits; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) { await walk(full, depth + 1, hits); }
      else {
        const lower = it.name.toLowerCase();
        if (lower === 'tileset.json') hits.tileset.push(full);
        else if (/\.(glb|gltf)$/.test(lower)) hits.mesh.push(full);
        else if (/\.obj$/.test(lower)) hits.obj.push(full);
      }
    }
    return hits;
  };
  const hits = await walk(dir, 0, { tileset: [], mesh: [], obj: [] });
  const toHostUrl = (full) =>
    `appfile://${host}/` + path.relative(dir, full).split(path.sep).map(encodeURIComponent).join('/');
  const depthOf = (full) => path.relative(dir, full).split(path.sep).length;
  const referencesChildTilesets = (json) => {
    try {
      const obj = JSON.parse(json);
      const uris = [];
      const collect = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.content && typeof n.content.uri === 'string') uris.push(n.content.uri);
        if (Array.isArray(n.children)) n.children.forEach(collect);
      };
      collect(obj.root);
      return uris.some((u) => /tileset\.json$/i.test(u));
    } catch { return false; }
  };
  const pickRootTileset = async (candidates) => {
    const sorted = candidates.slice().sort((a, b) => depthOf(a) - depthOf(b) || a.length - b.length);
    for (const c of sorted) {
      let txt = '';
      try { txt = await fsp.readFile(c, 'utf8'); } catch { continue; }
      if (referencesChildTilesets(txt)) return c;
    }
    return sorted[0];
  };
  let entry = null, kind = null;
  if (hits.tileset.length) { entry = toHostUrl(await pickRootTileset(hits.tileset)); kind = '3dtiles'; }
  else if (hits.mesh.length) { entry = toHostUrl(hits.mesh[0]); kind = 'gltf'; }
  else if (hits.obj.length) { entry = toHostUrl(hits.obj[0]); kind = 'obj'; }
  return { dir, entry, kind, counts: { tileset: hits.tileset.length, mesh: hits.mesh.length, obj: hits.obj.length } };
}

async function loadPhotosFromDir(dir, wcId) {
  const host = `photos-${wcId}`;
  roots[host] = path.resolve(dir);
  const base = `appfile://${host}/`;
  const all = (await fsp.readdir(dir)).filter((f) => /\.(jpe?g|png|tiff?|mp4|mov|avi|mkv)$/i.test(f)).sort();
  const photos = [];
  for (const name of all) {
    const full = path.join(dir, name);
    let lat = null, lng = null, time = null, thumb = null, gimbalYaw = null, gimbalPitch = null;
    try {
      const meta = await exifr.gps(full).catch(() => null);
      if (meta) { lat = meta.latitude; lng = meta.longitude; }
      // DateTimeOriginal (EXIF) + DJI gimbal angles (XMP). DJI stores the actual captured aim as
      // drone-dji:GimbalYawDegree / GimbalPitchDegree in the XMP block. NOTE: exifr's `pick` drops
      // XMP-parsed keys, so parse the block fully (mergeOutput) and read the fields off the result.
      const md = await exifr.parse(full, { xmp: true, mergeOutput: true }).catch(() => null);
      if (md) {
        if (md.DateTimeOriginal) time = new Date(md.DateTimeOriginal).getTime();
        const y = parseFloat(md.GimbalYawDegree), p = parseFloat(md.GimbalPitchDegree);
        if (!isNaN(y)) gimbalYaw = y;
        if (!isNaN(p)) gimbalPitch = p;
      }
      const t = await exifr.thumbnail(full).catch(() => null);
      if (t) thumb = 'data:image/jpeg;base64,' + Buffer.from(t).toString('base64');
    } catch { /* ignore unreadable EXIF */ }
    const noExt = name.replace(/\.[^.]+$/, '');
    const isVideo = /\.(mp4|mov|avi|mkv)$/i.test(name);
    if (isVideo) {
      const band = /_T[._]/i.test(noExt) || /_T$/i.test(noExt) ? 'ir'
        : /_(V|W)[._]/i.test(noExt) || /_(V|W)$/i.test(noExt) ? 'wide' : null;
      photos.push({
        name, url: base + encodeURIComponent(name),
        thumb: null, lat: null, lng: null, time: null,
        band, seqNum: null, photoActionName: null, type: 'video',
      });
      continue;
    }
    // Panoramic frames come out as PANO_0001.JPG (no DJI seqNum/band/action name).
    // They all belong to the same panoShot waypoint; flag + number them for ordering.
    const panoMatch = noExt.match(/^PANO_0*(\d+)$/i);
    if (panoMatch) {
      photos.push({
        name, url: base + encodeURIComponent(name),
        thumb: thumb || (base + encodeURIComponent(name)),
        lat, lng, time, band: 'pano', seqNum: null, photoActionName: null,
        gimbalYaw, gimbalPitch,
        isPano: true, panoFrame: parseInt(panoMatch[1], 10),
      });
      continue;
    }
    const band = /_T_/i.test(noExt) || /_T$/i.test(noExt) ? 'ir'
      : /_Z_/i.test(noExt) || /_Z$/i.test(noExt) ? 'zoom'
      : /_(W|V)_/i.test(noExt) || /_(W|V)$/i.test(noExt) ? 'wide' : null;
    // Sequence number: 4-digit counter after the timestamp, before the band char.
    // e.g. DJI_20260618115310_0005_T_ActionName → seqNum=5
    const seqMatch = noExt.match(/_0*(\d{1,4})_[TWZV]/i);
    const seqNum = seqMatch ? parseInt(seqMatch[1], 10) : null;
    // Custom action name: the part of the filename after the band character.
    // e.g. DJI_20260618124348_0162_T_F37207-HTEXT → actionName='F37207-HTEXT'
    const actionMatch = noExt.match(/_[TWZV]_(.+)$/i);
    const photoActionName = actionMatch ? actionMatch[1].trim() : null;
    photos.push({
      name, url: base + encodeURIComponent(name),
      thumb: thumb || (base + encodeURIComponent(name)),
      lat, lng, time, band, seqNum, photoActionName,
      gimbalYaw, gimbalPitch,
    });
  }
  // Attach folder creation time (best-effort)
  let folderCreatedAt = null;
  try { folderCreatedAt = (await fsp.stat(dir)).birthtime.toISOString(); } catch {}
  return { dir, photos, folderCreatedAt };
}

// ---------------------------------------------------------------------------
// IPC: 3D model folder
// ---------------------------------------------------------------------------

ipcMain.handle('open-model', async (_e) => {
  const r = await dialog.showOpenDialog(winOf(_e), {
    title: 'Open 3D model folder (exported from FlightHub)',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const res = await scanModelFromDir(r.filePaths[0], _e.sender.id);
  if (res && res.entry) await addRecent('models', r.filePaths[0], path.basename(r.filePaths[0]));
  return res;
});

// ---------------------------------------------------------------------------
// IPC: mission photo folder
// ---------------------------------------------------------------------------

ipcMain.handle('open-photos', async (_e) => {
  const r = await dialog.showOpenDialog(winOf(_e), {
    title: 'Open captured-image folder from the flown mission',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const res = await loadPhotosFromDir(r.filePaths[0], _e.sender.id);
  if (res) await addRecent('photos', r.filePaths[0], path.basename(r.filePaths[0]));
  return res;
});

// Open a brand-new independent session window.
ipcMain.handle('new-session', async () => { createWindow(); });

// ---------------------------------------------------------------------------
// IPC: Session persistence — stored in Electron userData directory
// ---------------------------------------------------------------------------

function sessionsFile() { return path.join(app.getPath('userData'), 'wayedit-sessions.json'); }
async function readSessions() {
  try { return JSON.parse(await fsp.readFile(sessionsFile(), 'utf8')); } catch { return []; }
}

ipcMain.handle('save-session', async (_e, { routePath, modelDir, photosDir, photosFolderName, photosDirCreatedAt }) => {
  const sessions = await readSessions();
  const session = {
    id: Date.now().toString(),
    savedAt: new Date().toISOString(),
    routePath, modelDir, photosDir,
    routeName: path.basename(routePath || '', path.extname(routePath || '')),
    photosFolderName: photosFolderName || path.basename(photosDir || ''),
    photosDirCreatedAt: photosDirCreatedAt || null,
  };
  // Deduplicate by route + photos dir; keep 20 most recent.
  const deduped = sessions.filter(s => !(s.routePath === routePath && s.photosDir === photosDir));
  deduped.unshift(session);
  await fsp.writeFile(sessionsFile(), JSON.stringify(deduped.slice(0, 20), null, 2));
  return session;
});

ipcMain.handle('load-sessions', async () => readSessions());

ipcMain.handle('delete-session', async (_e, id) => {
  const sessions = (await readSessions()).filter(s => s.id !== id);
  await fsp.writeFile(sessionsFile(), JSON.stringify(sessions, null, 2));
  return sessions;
});

ipcMain.handle('load-session-data', async (_e, session) => {
  try {
    const buf = await fsp.readFile(session.routePath);
    const kmz = {
      path: session.routePath,
      name: path.basename(session.routePath, path.extname(session.routePath)),
      buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
    const model = session.modelDir ? await scanModelFromDir(session.modelDir, _e.sender.id).catch(() => null) : null;
    const photos = await loadPhotosFromDir(session.photosDir, _e.sender.id);
    return { kmz, model, photos };
  } catch (e) {
    return { error: e.message };
  }
});

// ---------------------------------------------------------------------------
// IPC: Recent files — remember individually-loaded routes / 3D models / photo sets
// so they can be re-loaded from a list without browsing folders again.
// ---------------------------------------------------------------------------
function recentsFile() { return path.join(app.getPath('userData'), 'wayedit-recents.json'); }
async function readRecents() {
  try { return JSON.parse(await fsp.readFile(recentsFile(), 'utf8')); }
  catch { return { routes: [], models: [], photos: [] }; }
}
async function addRecent(kind, p, name) {
  if (!p) return;
  const r = await readRecents();
  if (!r[kind]) r[kind] = [];
  r[kind] = r[kind].filter((x) => x.path !== p);          // dedupe by path
  r[kind].unshift({ path: p, name: name || path.basename(p), at: new Date().toISOString() });
  r[kind] = r[kind].slice(0, 15);                          // keep 15 most recent
  try { await fsp.writeFile(recentsFile(), JSON.stringify(r, null, 2)); } catch {}
}
ipcMain.handle('get-recents', async () => readRecents());

ipcMain.handle('remove-recent', async (_e, { kind, path: p }) => {
  const r = await readRecents();
  if (r[kind]) r[kind] = r[kind].filter((x) => x.path !== p);
  try { await fsp.writeFile(recentsFile(), JSON.stringify(r, null, 2)); } catch {}
  return r;
});

ipcMain.handle('load-recent-model', async (_e, dir) => {
  const res = await scanModelFromDir(dir, _e.sender.id).catch(() => null);
  if (res && res.entry) await addRecent('models', dir, path.basename(dir));
  return res;
});
ipcMain.handle('load-recent-photos', async (_e, dir) => {
  const res = await loadPhotosFromDir(dir, _e.sender.id).catch(() => null);
  if (res) await addRecent('photos', dir, path.basename(dir));
  return res;
});
ipcMain.handle('load-recent-route', async (_e, filePath) => {
  try {
    const buf = await fsp.readFile(filePath);
    await addRecent('routes', filePath, path.basename(filePath, path.extname(filePath)));
    return { path: filePath, name: path.basename(filePath, path.extname(filePath)),
      buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (e) { return { error: e.message }; }
});

// ---------------------------------------------------------------------------
// IPC: Image viewer popup window
// ---------------------------------------------------------------------------

// One image-viewer popup PER main window (keyed by the opener's webContents id), so two
// open sessions can each keep their own viewer for side-by-side comparison.
const imageViewers = new Map();

ipcMain.handle('open-image-viewer', async (_e, { photos, index, filter, scope }) => {
  const ownerId = _e.sender.id;
  const existing = imageViewers.get(ownerId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    existing.webContents.send('viewer-photos', { photos, index, filter, scope });
    return;
  }
  const vw = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 400,
    minHeight: 320,
    backgroundColor: '#07090d',
    title: 'Image Viewer — Route View',
    webPreferences: {
      preload: path.join(__dirname, 'image-viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  imageViewers.set(ownerId, vw);
  vw.removeMenu();
  await vw.loadFile(path.join(__dirname, '..', 'renderer', 'image-viewer.html'));
  vw.webContents.send('viewer-photos', { photos, index, filter, scope });
  vw.on('closed', () => { if (imageViewers.get(ownerId) === vw) imageViewers.delete(ownerId); });
});

// Rename a photo on disk, within the opened photo folder only. Guards against
// path traversal and refuses to overwrite an existing file.
ipcMain.handle('rename-photo', async (_e, { oldName, newName }) => {
  const photosRoot = roots[`photos-${_e.sender.id}`];
  if (!photosRoot) return { error: 'No photo folder is open.' };
  const bad = (n) => !n || typeof n !== 'string' || /[\\/]/.test(n) || n.includes('..') || /[<>:"|?*]/.test(n);
  if (bad(oldName) || bad(newName)) return { error: 'Invalid file name.' };
  const from = path.resolve(photosRoot, oldName);
  const to = path.resolve(photosRoot, newName);
  if (from !== path.join(photosRoot, oldName) || to !== path.join(photosRoot, newName)) {
    return { error: 'Refusing to write outside the photo folder.' };
  }
  let exists = true;
  try { await fsp.access(to); } catch { exists = false; }
  if (exists) return { error: 'A file named "' + newName + '" already exists.' };
  try {
    await fsp.rename(from, to);
    return { ok: true, name: newName };
  } catch (e) { return { error: e.message }; }
});
