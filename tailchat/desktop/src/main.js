// Tailchat for Windows: opens your Tailchat server's web app in its own
// window. The first run asks for the server's address and remembers it.
'use strict';

const {
  app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, ipcMain, nativeImage, session, shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ID = 'net.tailchat.desktop';
const DARK = '#1f1e1e';
const ASSETS = path.join(__dirname, 'assets');
const SETUP_PAGE = path.join(__dirname, 'setup.html');
const SETUP_URL = pathToFileURL(SETUP_PAGE).href;

// Pages may use these, and only when they come from the Tailchat machine.
const ALLOWED_PERMISSIONS = new Set([
  'media', 'notifications', 'geolocation', 'fullscreen', 'display-capture',
  'clipboard-read', 'clipboard-sanitized-write', 'speaker-selection',
]);

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) app.quit();

// ---------- settings ----------

const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

let config = {};

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch {
    // a read-only profile only means the settings aren't kept
  }
}

// Accepts "tailchat.example.ts.net" or a full https:// URL and returns its origin.
function normalizeServer(input) {
  let text = String(input || '').trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Pages on the Tailchat machine, on any port so the call service works too.
function onServer(url) {
  if (!config.server) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === new URL(config.server).hostname.toLowerCase();
  } catch {
    return false;
  }
}

const isSetupPage = (url) => typeof url === 'string' && url.split(/[?#]/)[0] === SETUP_URL;

function openOutside(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') shell.openExternal(url);
  } catch {
    // not a link we hand to the system
  }
}

// ---------- the window ----------

let win = null;
let tray = null;
let quitting = false;
let unread = 0;

function showSetup(mode) {
  const query = { mode };
  if (config.server) query.server = config.server;
  win.loadFile(SETUP_PAGE, { query });
}

function openServer() {
  if (config.server) win.loadURL(`${config.server}/`);
  else showSetup('form');
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function guard(contents) {
  contents.on('will-navigate', (event, url) => {
    if (onServer(url) || isSetupPage(url)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // "Open the call in its own window" stays in the app.
    if (onServer(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 700,
          backgroundColor: DARK,
          autoHideMenuBar: true,
          icon: path.join(ASSETS, 'icon.png'),
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('context-menu', (_event, params) => contextMenu(contents, params));
}

function contextMenu(contents, params) {
  const items = [];
  if (params.misspelledWord) {
    for (const word of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: word, click: () => contents.replaceMisspelling(word) });
    }
    if (items.length) items.push({ type: 'separator' });
  }
  if (params.linkURL && /^https?:/.test(params.linkURL)) {
    items.push({ label: 'Open link in browser', click: () => openOutside(params.linkURL) });
    items.push({ label: 'Copy link', click: () => require('electron').clipboard.writeText(params.linkURL) });
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  } else if (params.selectionText) {
    items.push({ role: 'copy' });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) });
}

function createWindow() {
  const bounds = config.bounds || {};
  win = new BrowserWindow({
    width: bounds.width || 1200,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 380,
    minHeight: 500,
    title: 'Tailchat',
    backgroundColor: DARK,
    autoHideMenuBar: true,
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (config.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    // -3 is a navigation that was replaced by another one, not a failure.
    if (!isMainFrame || code === -3 || isSetupPage(url)) return;
    showSetup('error');
  });

  // The web app puts the number of unread chats in the title: "(3) Tailchat".
  win.on('page-title-updated', (_event, title) => {
    const n = Number((/^\((\d+)\)/.exec(title) || [])[1] || 0);
    if (n > unread && !win.isFocused()) win.flashFrame(true);
    unread = n;
    showUnread();
  });
  win.on('focus', () => win.flashFrame(false));

  const keepBounds = () => {
    if (win.isMinimized()) return;
    config.maximized = win.isMaximized();
    if (!config.maximized) config.bounds = win.getBounds();
  };
  win.on('resize', keepBounds);
  win.on('move', keepBounds);

  // Closing the window keeps Tailchat running in the tray so messages still
  // arrive; quit from the tray or the menu.
  win.on('close', (event) => {
    saveConfig();
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
  });

  openServer();
}

function showUnread() {
  const label = unread ? `${unread} unread chat${unread === 1 ? '' : 's'}` : '';
  if (process.platform === 'win32' && win) {
    win.setOverlayIcon(unread ? nativeImage.createFromPath(path.join(ASSETS, 'badge.png')) : null, label);
  } else {
    app.setBadgeCount(unread);
  }
  if (tray) tray.setToolTip(unread ? `Tailchat (${label})` : 'Tailchat');
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('Tailchat');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Tailchat', click: showWindow },
    { label: 'Change server…', click: () => { showWindow(); showSetup('form'); } },
    { type: 'separator' },
    { label: 'Quit Tailchat', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Tailchat',
      submenu: [
        { label: 'Change server…', click: () => { showWindow(); showSetup('form'); } },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => openServer() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// ---------- permissions and screen sharing ----------

function setUpSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && onServer(details.requestingUrl || ''));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && onServer(origin || ''));

  // "Share screen" in a call: ask which screen or window to share.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const origin = request.securityOrigin || request.frame?.url || '';
    if (!onServer(origin)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const choices = sources.slice(0, 12);
      if (!choices.length) return callback({});
      const screens = choices.filter((s) => s.id.startsWith('screen:')).length;
      const names = choices.map((s, i) => (s.id.startsWith('screen:')
        ? screens > 1 ? `Screen ${i + 1}` : 'Entire screen'
        : s.name || 'Window'));
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Share screen',
        message: 'What do you want to share?',
        buttons: [...names, 'Cancel'],
        cancelId: names.length,
        noLink: false,
      });
      const pick = choices[response];
      if (!pick) return callback({});
      callback({ video: pick, audio: process.platform === 'win32' && pick.id.startsWith('screen:') ? 'loopback' : undefined });
    } catch {
      callback({});
    }
  });
}

// ---------- messages from the setup page and the web app ----------

function fromSetup(event) {
  return isSetupPage(event.senderFrame?.url);
}

ipcMain.handle('setup:info', (event) => {
  if (!fromSetup(event)) return null;
  return { server: config.server || '' };
});

ipcMain.handle('setup:connect', (event, input) => {
  if (!fromSetup(event)) return { ok: false };
  const origin = normalizeServer(input);
  if (!origin) return { ok: false, error: 'Enter your server address, like https://tailchat.your-tailnet.ts.net' };
  config.server = origin;
  saveConfig();
  openServer();
  return { ok: true };
});

ipcMain.handle('setup:retry', (event) => {
  if (fromSetup(event)) openServer();
});

// Clicking a notification calls window.focus(), which only brings the
// window forward when the app does it.
ipcMain.on('page:focus', (event) => {
  if (onServer(event.senderFrame?.url || '')) showWindow();
});

// ---------- start ----------

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
// Every page, including call windows, gets the same link and navigation rules.
app.on('web-contents-created', (_event, contents) => guard(contents));

app.whenReady().then(() => {
  config = readConfig();
  setUpSession();
  createMenu();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showWindow();
});
