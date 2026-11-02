// Runs before each page in the main window. The setup page gets a small API
// to save the server address; Tailchat's own pages only get a way to bring
// the window forward when a notification is clicked.
'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('setup', {
    info: () => ipcRenderer.invoke('setup:info'),
    connect: (server) => ipcRenderer.invoke('setup:connect', String(server)),
    retry: () => ipcRenderer.invoke('setup:retry'),
  });
} else {
  contextBridge.exposeInMainWorld('tailchatDesktop', {
    focus: () => ipcRenderer.send('page:focus'),
  });
  webFrame.executeJavaScript(
    'window.focus = function () { window.tailchatDesktop.focus(); };',
  ).catch(() => {});
}
