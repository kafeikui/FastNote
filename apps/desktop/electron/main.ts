import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { desktopSettings } from './settings';

process.on('uncaughtException', (err) => {
  console.error('[FastNote] uncaughtException:', err);
});

// FastNote never needs camera/mic/geolocation/notifications access; deny
// every permission request outright instead of prompting the user.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
});

// Notes/chat content can contain links. Never let them navigate the app
// window itself or spawn a new BrowserWindow/webview — open http(s) links in
// the user's default browser instead, and drop everything else (custom
// protocol handlers, data:, file:, etc. are common phishing/exfiltration
// vectors).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (navEvent, url) => {
    if (url === contents.getURL()) return;
    navEvent.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (navEvent) => navEvent.preventDefault());
});

function fixMacOsHitTest(win: BrowserWindow) {
  if (process.platform !== 'darwin') return;
  const [w, h] = win.getSize();
  win.setSize(w + 1, h);
  win.setSize(w, h);
  win.focus();
  win.webContents.focus();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl).then(() => {
      setTimeout(() => fixMacOsHitTest(win), 50);
    });
    if (process.env.FASTNOTE_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function registerSettingsIpc() {
  ipcMain.handle('fastnote:getDataDirectory', () => desktopSettings.getDataDirectory());
  ipcMain.handle('fastnote:getDefaultDataDirectory', () => desktopSettings.getDefaultDataDirectory());
  ipcMain.handle('fastnote:setDataDirectory', (_e, dir: string) => desktopSettings.setDataDirectory(dir));
  ipcMain.handle('fastnote:pickStorageDirectory', () => desktopSettings.pickStorageDirectory());
  ipcMain.handle('fastnote:getUserDataPath', () => desktopSettings.getUserDataPath());
  ipcMain.handle('fastnote:openUserDataFolder', () => desktopSettings.openUserDataFolder());
}

registerSettingsIpc();

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
