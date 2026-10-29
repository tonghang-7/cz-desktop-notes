import { BrowserWindow, screen, shell } from 'electron';
import path from 'node:path';
import { getDb, updateSettings } from './store';
import { windowSizeFor } from '../shared/types';
import { trace } from './perf';

let notepad: BrowserWindow | null = null;
let manager: BrowserWindow | null = null;
let skinWin: BrowserWindow | null = null;
let quitting = false;

const preloadPath = () => path.join(__dirname, '../preload/index.js');

export function setQuitting(v: boolean) {
  quitting = v;
}

function isVisibleOnSomeDisplay(x: number, y: number, w: number, h: number) {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const a = d.workArea;
    const overlapX = Math.min(x + w, a.x + a.width) - Math.max(x, a.x);
    const overlapY = Math.min(y + h, a.y + a.height) - Math.max(y, a.y);
    return overlapX > 80 && overlapY > 80;
  });
}

function initialPosition(width: number, height: number) {
  const { settings } = getDb();
  if (
    settings.windowX !== null &&
    settings.windowY !== null &&
    isVisibleOnSomeDisplay(settings.windowX, settings.windowY, width, height)
  ) {
    return { x: settings.windowX, y: settings.windowY };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - width - 48),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

export function createNotepad(): BrowserWindow {
  if (notepad && !notepad.isDestroyed()) return notepad;

  const { settings } = getDb();
  const { width, height } = windowSizeFor(settings.cardWidth, settings.cardHeight);
  const pos = initialPosition(width, height);

  notepad = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  notepad.setAlwaysOnTop(true, 'floating');
  notepad.loadFile(path.join(__dirname, '../renderer/notepad.html'));
  trace('notepad window created', `${width}x${height}`);

  notepad.webContents.on('did-finish-load', () => trace('notepad DOM ready'));

  notepad.webContents.on('console-message', (event) => {
    const raw = event as unknown as { message?: string; level?: string };
    console.log('[renderer]', raw.level ?? '', raw.message ?? '');
  });
  notepad.webContents.on('preload-error', (_e, file, err) => {
    console.error('[preload-error]', file, err);
  });
  notepad.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });
  notepad.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', details.reason, 'exit=', details.exitCode);
  });

  notepad.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    notepad?.hide();
  });

  notepad.on('moved', () => {
    if (!notepad || notepad.isDestroyed()) return;
    const b = notepad.getBounds();
    updateSettings({ windowX: b.x, windowY: b.y });
  });

  notepad.on('closed', () => {
    notepad = null;
  });

  return notepad;
}

export function showNotepad() {
  const t0 = performance.now();
  const win = createNotepad();
  const reveal = () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.send('notepad:shown');
    trace('notepad revealed', `call->paint ${(performance.now() - t0).toFixed(1)}ms`);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', reveal);
  } else {
    reveal();
  }
}

export function hideNotepad() {
  if (notepad && !notepad.isDestroyed()) notepad.hide();
}

export function toggleNotepad() {
  const win = createNotepad();
  if (win.isVisible() && win.isFocused()) {
    win.hide();
    return;
  }
  showNotepad();
}

export function isNotepadVisible() {
  return !!notepad && !notepad.isDestroyed() && notepad.isVisible();
}

export function applyCardSize() {
  if (!notepad || notepad.isDestroyed()) return;
  const { settings } = getDb();
  const { width, height } = windowSizeFor(settings.cardWidth, settings.cardHeight);
  const b = notepad.getBounds();
  notepad.setBounds({ x: b.x, y: b.y, width, height });
}

export function createManager(): BrowserWindow {
  if (manager && !manager.isDestroyed()) return manager;

  manager = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 620,
    minHeight: 480,
    title: '苍泽便签 · 管理',
    backgroundColor: '#f6f5f2',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  manager.loadFile(path.join(__dirname, '../renderer/manager.html'));

  manager.webContents.on('console-message', (event) => {
    const raw = event as unknown as { message?: string };
    console.log('[manager]', raw.message ?? '');
  });

  manager.once('ready-to-show', () => manager?.show());

  manager.on('closed', () => {
    manager = null;
  });

  manager.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return manager;
}

export function showManager(focusEditor = false) {
  const win = createManager();
  if (!win.isVisible()) win.show();
  win.focus();
  if (!focusEditor) return;
  // 从便签窗点卡片/新建进来的：意图是「改这一张」，把光标直接放进编辑器。
  // 工具栏「管理」按钮进来不传这个标志 —— 那时用户可能只想翻列表。
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => win.webContents.send('manager:focus-editor'));
  } else {
    win.webContents.send('manager:focus-editor');
  }
}

/**
 * 皮肤管理窗。按需打开、关掉即销毁 —— 它不像便签那样常驻，
 * 所以「一个窗口一个渲染进程」的成本只在开着的时候付（约 50MB）。
 */
export function createSkinWindow(): BrowserWindow {
  if (skinWin && !skinWin.isDestroyed()) return skinWin;

  skinWin = new BrowserWindow({
    width: 760,
    height: 420,
    minWidth: 620,
    minHeight: 360,
    title: '皮肤管理 · 苍泽便签',
    backgroundColor: '#f6f5f2',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  skinWin.loadFile(path.join(__dirname, '../renderer/skin.html'));
  skinWin.once('ready-to-show', () => skinWin?.show());
  skinWin.on('closed', () => {
    skinWin = null;
    // 拖到一半直接关窗：便签窗还停在那个没存过的预览值上，复位回已保存的。
    // 放在主进程而不是渲染进程的 beforeunload —— 那边窗口正在销毁，IPC 可能被丢掉。
    previewVeil(getDb().settings.skinVeil);
  });
  skinWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return skinWin;
}

export function showSkinWindow() {
  const win = createSkinWindow();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * 蒙版浓度拖动时的实时预览：只推给便签窗，不写盘、不广播。
 *
 * 皮肤窗和便签窗是两个渲染进程，改自己 DOM 上的 CSS 变量够不着对方，
 * 所以单独开一条通道。调用方必须节流 —— 一次拖动就是几十次往返。
 */
export function previewVeil(veil: number) {
  if (notepad && !notepad.isDestroyed()) {
    notepad.webContents.send('skin:preview-veil', veil);
  }
}

export function broadcastDb() {
  const db = getDb();
  for (const win of [notepad, manager, skinWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('db:changed', db);
  }
}

export function destroyAll() {
  for (const win of [notepad, manager, skinWin]) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  notepad = null;
  manager = null;
  skinWin = null;
}
