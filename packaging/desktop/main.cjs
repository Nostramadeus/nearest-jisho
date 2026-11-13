// Desktop shell for Nearest Jisho: serves the bundled web app on 127.0.0.1 and shows it in one window.
// The fixed port keeps the page origin stable, so settings, recent searches and downloaded data updates
// (all stored per origin) survive restarts.
'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const FIRST_PORT = 47831;
const LAST_PORT = 47840;
const root = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, 'app');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

// Same logic as tools/serve.mjs.
function handle(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'content-type': types[path.extname(file)] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < LAST_PORT) resolve(listen(port + 1));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

let win = null;

function openOutside(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

async function start() {
  const port = await listen(FIRST_PORT);
  const origin = `http://127.0.0.1:${port}`;
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    title: 'Nearest Jisho',
    icon: path.join(root, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin + '/')) win.loadURL(url);
    else openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin + '/')) { event.preventDefault(); openOutside(url); }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(origin + '/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start).catch((err) => {
    console.error(err);
    app.exit(1);
  });
}
