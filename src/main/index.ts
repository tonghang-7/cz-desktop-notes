import { app, clipboard, dialog, globalShortcut, ipcMain, Notification, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as store from './store';
import { DB_VERSION } from './db-format';
import * as W from './windows';
import { rebindHotkey, unregisterAll, getActiveHotkey, setHotkey } from './hotkey';
import { createTray, destroyTray, refreshTray, type TrayHandlers } from './tray';
import { trace } from './perf';
import type { NoteColor, Settings } from '../shared/types';

app.setAppUserModelId('dev.cangze.czdesktopnotes');

/**
 * 附件图片用 data URL 交给渲染进程，不走自定义协议。
 *
 * 走过一次 czattach:// 的弯路：自定义协议被 Chromium 当成跨源，canvas 一读像素就 taint，
 * 于是 drawElementImage 抓图时那张图直接被跳过 —— 折纸抓到的是没有图片的空白纸。
 * data: URL 是同源的，不会 taint，能抓。
 */
function mimeOf(name: string) {
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.webp$/i.test(name)) return 'image/webp';
  return 'image/png';
}

/** 捕获热键。选 V 是因为带「粘贴 / 捕获」的语义，也不和呼出热键的候选撞车。 */
const CAPTURE_ACCEL = 'Control+Alt+V';

/**
 * 把剪贴板变成一张置顶便签。图优先，没图就读文字，两样都没有就什么都不做。
 *
 * 图空的时候要重试几次：Win+Shift+S 刚把图写进剪贴板就按热键是常见操作，
 * 读太早会拿到空图，用户那边的感受就是「按了没反应」。
 */
async function captureFromClipboard() {
  // Electron 45 的 clipboard 换成了 W3C 那套异步 API：
  // clipboard.read() → ClipboardItem[] → item.getType(mime) → Blob。
  // 老的 readImage()/writeImage() 已经没有了，别照旧文档写。
  const readItems = async (): Promise<Electron.ClipboardItem[]> => {
    try {
      return await clipboard.read();
    } catch {
      return [];
    }
  };
  const hasImage = (items: Electron.ClipboardItem[]) =>
    items.some((it) => it.types.some((t) => t.startsWith('image/')));

  let items = await readItems();
  // 截图刚写进剪贴板就读，偶尔还是空的 —— Win+Shift+S 之后立刻按热键很常见
  for (let i = 0; i < 3 && !hasImage(items); i++) {
    await new Promise((r) => setTimeout(r, 90));
    items = await readItems();
  }

  for (const item of items) {
    const imgType = item.types.find((t) => t.startsWith('image/'));
    if (!imgType) continue;
    const payload = await item.getType(imgType);
    if (!(payload instanceof Blob)) continue;

    const ext = imgType === 'image/jpeg' ? 'jpg' : imgType === 'image/webp' ? 'webp' : 'png';
    const name = `${randomUUID()}.${ext}`;
    const dir = store.attachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.from(await payload.arrayBuffer()));

    const note = store.createNote({}, true);
    store.setNoteImage(note.id, name);
    W.showNotepad();
    W.broadcastDb();
    return;
  }

  const text = (await clipboard.readText()).trim();
  if (!text) return;
  store.createNote({ text }, true);
  W.showNotepad();
  W.broadcastDb();
}

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
  capture: () => void captureFromClipboard(),
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

  ipcMain.handle('note:due', (_e, id: string, dueAt: number | null) => {
    store.setNoteDue(id, dueAt);
    W.broadcastDb();
  });

  /** 把粘贴进来的图片写进附件目录，返回文件名（不是路径 —— 数据目录会变）。 */
  ipcMain.handle('image:save', (_e, data: ArrayBuffer, mime: string) => {
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const name = `${randomUUID()}.${ext}`;
    const dir = store.attachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.from(data));
    return name;
  });

  ipcMain.handle('note:image', (_e, id: string, fileName: string | null) => {
    store.setNoteImage(id, fileName);
    W.broadcastDb();
  });

  /**
   * 交给系统看图程序打开附件。
   * 320×145 的小框里看不出截图里的字，缩放、翻页这些能力系统工具已经有，没必要重做。
   */
  ipcMain.handle('image:open', async (_e, fileName: string) => {
    const file = path.join(store.attachmentsDir(), path.basename(fileName));
    const err = await shell.openPath(file);
    return err || null;
  });

  /** 读附件，返回 data URL。读不到返回 null（文件被人手动删了也不该崩）。 */
  ipcMain.handle('image:read', (_e, fileName: string) => {
    try {
      const buf = fs.readFileSync(path.join(store.attachmentsDir(), path.basename(fileName)));
      return `data:${mimeOf(fileName)};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('ui:notify', (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
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

  // 捕获热键：Ctrl+Alt+V 把剪贴板直接变成一张便签。
  // 被占用就跳过 —— 一个次要功能不该阻塞启动。
  try {
    const ok = globalShortcut.register(CAPTURE_ACCEL, () => void captureFromClipboard());
    if (!ok) console.warn(`[capture] ${CAPTURE_ACCEL} 已被别的程序占用，剪贴板捕获不可用`);
  } catch {
    console.warn(`[capture] ${CAPTURE_ACCEL} 注册失败`);
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
