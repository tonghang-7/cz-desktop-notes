import { app, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import * as store from './store';
import { DB_VERSION } from './db-format';
import * as W from './windows';
import { rebindHotkey, unregisterAll, getActiveHotkey, setHotkey } from './hotkey';
import { createTray, destroyTray, refreshTray, type TrayHandlers } from './tray';
import { trace } from './perf';
import type { NoteColor, Settings } from '../shared/types';

app.setAppUserModelId('dev.cangze.czdesktopnotes');

app.commandLine.appendSwitch('enable-features', 'CanvasDrawElement');

if (process.env.NOTES_GPU !== '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('in-process-gpu');
}

const trayHandlers: TrayHandlers = {
  toggle: () => W.toggleNotepad(),
  openManager: () => W.showManager(),
  openDataFolder: () => {
    const file = store.getDataFile();
    shell.openPath(file ? path.dirname(file) : app.getPath('userData'));
  },
  quit: () => app.quit(),
};

function registerIpc() {
  ipcMain.handle('db:get', () => store.getDb());

  ipcMain.handle('note:create', (_e, text: string, color?: NoteColor) => {
    const note = store.createNote({ text, color });
    W.broadcastDb();
    return note;
  });

  ipcMain.handle('note:update', (_e, id: string, patch: { text?: string; color?: NoteColor }) => {
    store.updateNote(id, patch);
    W.broadcastDb();
  });

  ipcMain.handle('note:complete', (_e, id: string) => {
    store.completeNote(id);
    W.broadcastDb();
  });

  ipcMain.handle('note:restore', (_e, id: string) => {
    store.restoreNote(id);
    W.broadcastDb();
  });

  ipcMain.handle('archive:delete', (_e, id: string) => {
    store.deleteArchived(id);
    W.broadcastDb();
  });

  ipcMain.handle('archive:clear', () => {
    store.clearArchive();
    W.broadcastDb();
  });

  ipcMain.handle('notes:reorder', (_e, ids: string[]) => {
    store.reorderNotes(ids);
    W.broadcastDb();
  });

  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    const before = store.getDb().settings;
    store.updateSettings(patch);
    const after = store.getDb().settings;

    if (after.cardWidth !== before.cardWidth || after.cardHeight !== before.cardHeight) {
      W.applyCardSize();
    }
    if (after.hotkey !== before.hotkey && after.hotkey) {
      const bound = rebindHotkey(() => W.toggleNotepad());
      if (bound !== after.hotkey) store.updateSettings({ hotkey: bound || after.hotkey });
      refreshTray(trayHandlers);
    }
    W.broadcastDb();
    return store.getDb().settings;
  });

  ipcMain.handle('ui:open-manager', (_e, fromCard?: boolean) => W.showManager(!!fromCard));
  ipcMain.handle('ui:hide-notepad', () => W.hideNotepad());
  ipcMain.handle('ui:show-notepad', () => W.showNotepad());
  ipcMain.handle('ui:hotkey', () => getActiveHotkey());

  ipcMain.handle('hotkey:set', (_e, accel: string) => {
    const result = setHotkey(accel, () => W.toggleNotepad());
    refreshTray(trayHandlers);
    return result;
  });

  ipcMain.handle('app:get-autolaunch', () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle('app:set-autolaunch', (_e, on: boolean) => {
    // 没打包时 execPath 是 electron.exe，写进登录项只会开机拉起一个空壳。
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on });
    store.updateSettings({ autoLaunch: !!on });
    W.broadcastDb();
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('data:get-dir', () => store.getDataDir());

  ipcMain.handle('data:set-dir', (_e, dir: string | null) => store.setDataDir(dir));

  ipcMain.handle('data:choose-dir', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择便签数据存放的目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  ipcMain.handle('ui:quit', () => app.quit());
}

/**
 * 数据文件出问题时的开场白。原则：宁可停下来问用户，也不要替他决定丢数据。
 * 返回 false 表示用户选择退出，程序不该继续往下走。
 */
function handleLoadState(): boolean {
  const state = store.getLoadState();

  if (state.kind === 'corrupt') {
    const backup = store.getLastBackup();
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '数据文件读不出来',
      message: 'data.json 解析失败，程序没有覆盖它，原文件已另存一份备份。',
      detail: [
        `原因：${state.reason}`,
        backup ? `备份位置：${backup}` : '备份失败，请手动去数据目录把 data.json 改名留档。',
        '',
        '选「以空库启动」会用一份空数据继续，原始内容保留在上面的备份里。',
      ].join('\n'),
      buttons: ['以空库启动', '退出程序'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return choice === 0;
  }

  if (state.kind === 'future') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: '数据文件来自更新版本',
      message: `这份 data.json 是 v${state.version} 写的，当前程序只支持 v${DB_VERSION}。`,
      detail: '为避免破坏数据，程序不会写入这个文件。升级到最新版再打开即可。',
      buttons: ['只读启动', '退出程序'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return choice === 0;
  }

  return true;
}

async function bootstrap() {
  trace('bootstrap start');
  store.initStore();
  trace('store ready');

  // 自启可能在别处被改过（系统设置、旧版本残留），启动时以配置为准同步一次。
  if (store.getDb().settings.autoLaunch && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  if (!handleLoadState()) {
    app.quit();
    return;
  }

  registerIpc();

  const pad = W.createNotepad();
  pad.webContents.on('render-process-gone', (_e, details) => {
    console.error('[boot] renderer gone:', details.reason);
  });

  const bound = rebindHotkey(() => W.toggleNotepad());
  if (bound) {
    trace('hotkey bound', bound);
  } else {
    console.warn('[boot] all candidate accelerators are taken');
  }

  createTray(trayHandlers);
  trace('tray ready');

  W.showNotepad();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (store.getDataFile()) W.showNotepad();
  });

  app.whenReady().then(bootstrap);

  app.on('window-all-closed', () => {
    // Keep running in the tray. Quit is explicit via tray menu.
  });

  app.on('before-quit', () => {
    W.setQuitting(true);
    unregisterAll();
    store.flushSync();
    destroyTray();
  });

  app.on('will-quit', () => {
    unregisterAll();
    store.flushSync();
  });
}
