import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app, dialog, shell, BrowserWindow } from 'electron';

const SETTINGS_FILE = 'settings.json';

interface AppSettings {
  dataDirectory?: string;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function readSettings(): AppSettings {
  const file = settingsPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AppSettings;
  } catch {
    return {};
  }
}

function writeSettings(data: AppSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
}

function defaultDataDirectory(): string {
  return path.join(app.getPath('documents'), 'FastNote');
}

export const desktopSettings = {
  getDataDirectory(): string {
    return readSettings().dataDirectory?.trim() || defaultDataDirectory();
  },

  getDefaultDataDirectory(): string {
    return defaultDataDirectory();
  },

  setDataDirectory(dir: string): string {
    const normalized = dir.trim();
    mkdirSync(normalized, { recursive: true });
    writeSettings({ dataDirectory: normalized });
    return normalized;
  },

  async pickStorageDirectory(): Promise<string | null> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择 FastNote 数据保存目录',
      defaultPath: desktopSettings.getDataDirectory(),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return desktopSettings.setDataDirectory(result.filePaths[0]);
  },

  /**
   * The folder browsable/selectable above (`dataDirectory`) is only ever
   * used as a *label* to derive the IndexedDB database name — nothing is
   * ever written into it, which is exactly why users find it empty. The
   * actual encrypted note/chat/attachment data physically lives inside
   * Electron's per-profile storage under `userData` (Chromium's IndexedDB
   * backing store), regardless of which label/vault is selected. Surfacing
   * this real path lets users locate/back up the real data.
   */
  getUserDataPath(): string {
    return app.getPath('userData');
  },

  openUserDataFolder(): void {
    void shell.openPath(app.getPath('userData'));
  },
};
