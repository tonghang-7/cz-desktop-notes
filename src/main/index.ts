import { app, ipcMain, shell } from 'electron';
import path from 'node:path';
import * as store from './store';
import * as W from './windows';
import { rebindHotkey, unregisterAll, getActiveHotkey } from './hotkey';
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

  ipcMain.handle('ui:open-manager', () => W.showManager());
  ipcMain.handle('ui:hide-notepad', () => W.hideNotepad());
  ipcMain.handle('ui:show-notepad', () => W.showNotepad());
  ipcMain.handle('ui:hotkey', () => getActiveHotkey());
  ipcMain.handle('ui:quit', () => app.quit());
}

async function bootstrap() {
  trace('bootstrap start');
  store.initStore();
  trace('store ready');
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
