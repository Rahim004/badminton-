'use strict';
/**
 * Волан для компьютера (Windows .exe / Linux AppImage): окно Electron, игра лежит рядом в app-web/
 * (копия файлов сайта: node ../tools/stage-web.mjs app-web) и открывается по volan://game/ —
 * свой «сайт» нужен, чтобы работали ES-модули, localStorage профиля и онлайн-режим (WebSocket/WebRTC).
 */
const { app, BrowserWindow, Menu, protocol, net, session, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, 'app-web');
const ORIGIN = 'volan://game';

protocol.registerSchemesAsPrivileged([
  { scheme: 'volan', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // звук без отдельного клика
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');   // AppImage на Ubuntu 24+ иначе не стартует
// По этой метке игра узнаёт, что запущена в приложении (скрывает «Скачать», не ставит service worker).
app.userAgentFallback = `${app.userAgentFallback || ''} VolanApp/${app.getVersion()} Desktop`.trim();

let win = null;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 720, minWidth: 640, minHeight: 360,
    backgroundColor: '#17134a', title: 'Волан', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  // Внешние ссылки — в браузере по умолчанию, внутри окна только игра.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN)) return;
    e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.loadURL(`${ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('volan', req => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const full = path.normalize(path.join(ROOT, p));
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(full).toString());
  });
  // Онлайн-режим использует только RTCDataChannel — камера/микрофон/геолокация не нужны.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'fullscreen'));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
