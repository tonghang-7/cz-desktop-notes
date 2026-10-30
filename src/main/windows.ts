import { BrowserWindow, screen, shell } from 'electron';
import path from 'node:path';
import { getDb, setQueueBounds } from './store';
import { windowSizeFor, type Queue } from '../shared/types';
import { trace } from './perf';

/** 一个队列一扇便签窗。多个队列 = 多条任务线并行，窗口互不干扰。 */
const notepads = new Map<string, BrowserWindow>();
let manager: BrowserWindow | null = null;
let skinWin: BrowserWindow | null = null;
let quitting = false;
/** 最后聚焦的那个便签窗。剪贴板捕获要贴进「用户正在看的那一叠」。 */
let lastActiveQueueId = '';

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

function queueById(id: string): Queue | null {
  return getDb().queues.find((q) => q.id === id) ?? null;
}

function initialPosition(q: Queue, width: number, height: number) {
  if (
    q.windowX !== null &&
    q.windowY !== null &&
    isVisibleOnSomeDisplay(q.windowX, q.windowY, width, height)
  ) {
    return { x: q.windowX, y: q.windowY };
  }
  const area = screen.getPrimaryDisplay().workArea;
  // 没记录过位置的队列按已有窗口数错开摆 —— 否则新开的那扇正好压在旧窗口上，
  // 用户会以为「怎么点了没反应」。
  const step = notepads.size * 30;
  return {
    x: Math.round(area.x + area.width - width - 48 - step),
    y: Math.round(area.y + (area.height - height) / 2 - step),
  };
}

export function createQueueWindow(queueId: string): BrowserWindow | null {
  const existing = notepads.get(queueId);
  if (existing && !existing.isDestroyed()) return existing;

  const q = queueById(queueId);
  if (!q) return null;

  const { width, height } = windowSizeFor(q.cardWidth, q.cardHeight);
  const pos = initialPosition(q, width, height);

  const win = new BrowserWindow({
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
    title: `苍泽便签 · ${q.name}`,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  notepads.set(queueId, win);
  if (!lastActiveQueueId) lastActiveQueueId = queueId;

  win.setAlwaysOnTop(true, 'floating');
  // query 里的 q 就是这一扇窗的身份：preload 读它，之后所有便签操作都自动带上，
  // 渲染层的调用点一行都不用改。
  win.loadFile(path.join(__dirname, '../renderer/notepad.html'), { query: { q: queueId } });
  trace('notepad window created', `${q.name} ${width}x${height}`);

  win.webContents.on('did-finish-load', () => trace('notepad DOM ready', q.name));
  win.webContents.on('console-message', (event) => {
    const raw = event as unknown as { message?: string; level?: string };
    console.log(`[renderer:${q.name}]`, raw.level ?? '', raw.message ?? '');
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    console.error('[preload-error]', file, err);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', details.reason, 'exit=', details.exitCode);
  });

  win.on('focus', () => {
    lastActiveQueueId = queueId;
  });

  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // 位置按队列各记一份 —— 放在全局的话两个窗口会互相把对方拽到同一个点上
  win.on('moved', () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    setQueueBounds(queueId, { windowX: b.x, windowY: b.y });
  });

  win.on('closed', () => {
    notepads.delete(queueId);
    if (lastActiveQueueId === queueId) {
      lastActiveQueueId = [...notepads.keys()][0] ?? '';
    }
  });

  return win;
}

/** 所有便签窗一起出现。多开的意义就是「同时进行」—— 一起看、一起收。 */
export function showNotepad() {
  const t0 = performance.now();
  const queues = getDb().queues;
  for (const q of queues) {
    const win = createQueueWindow(q.id);
    if (!win) continue;
    const reveal = () => {
      if (win.isDestroyed()) return;
      if (!win.isVisible()) win.show();
      win.webContents.send('notepad:shown');
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
    else reveal();
  }

  const focusTarget = notepads.get(lastActiveQueueId) ?? [...notepads.values()][0];
  if (focusTarget && !focusTarget.isDestroyed()) focusTarget.focus();
  trace('notepad revealed', `call->paint ${(performance.now() - t0).toFixed(1)}ms`);
}

export function hideNotepad() {
  for (const win of notepads.values()) {
    if (!win.isDestroyed()) win.hide();
  }
}

export function toggleNotepad() {
  const wins = [...notepads.values()].filter((w) => !w.isDestroyed());
  const anyVisible = wins.some((w) => w.isVisible());
  if (anyVisible && wins.some((w) => w.isFocused())) {
    hideNotepad();
    return;
  }
  showNotepad();
}

/** 新建队列后单独开它，不惊动已经在看的那几扇。 */
export function openQueueWindow(queueId: string) {
  const win = createQueueWindow(queueId);
  if (!win) return;
  lastActiveQueueId = queueId;
  const reveal = () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.send('notepad:shown');
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

export function closeQueueWindow(queueId: string) {
  const win = notepads.get(queueId);
  if (win && !win.isDestroyed()) win.destroy();
  notepads.delete(queueId);
}

export function retitleQueueWindow(queueId: string) {
  const win = notepads.get(queueId);
  const q = queueById(queueId);
  if (win && !win.isDestroyed() && q) win.setTitle(`苍泽便签 · ${q.name}`);
}

/** 某一叠的卡片尺寸变了，只调整它自己那扇窗。 */
export function applyQueueSize(queueId: string) {
  const win = notepads.get(queueId);
  const q = queueById(queueId);
  if (!win || win.isDestroyed() || !q) return;
  const { width, height } = windowSizeFor(q.cardWidth, q.cardHeight);
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width, height });
}

/** 皮肤 / 背景图这类全局视觉变了：所有便签窗重算尺寸没必要，但要让它们重画。 */
export function applyCardSize() {
  for (const [id, win] of notepads) {
    if (!win.isDestroyed()) applyQueueSize(id);
  }
}

export function lastActiveQueue() {
  return lastActiveQueueId || null;
}

export function queueIdOfWindow(win: BrowserWindow | null): string | null {
  if (!win) return null;
  for (const [id, w] of notepads) if (w === win) return id;
  return null;
}

export function isNotepadVisible() {
  for (const win of notepads.values()) {
    if (!win.isDestroyed() && win.isVisible()) return true;
  }
  return false;
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
  for (const win of notepads.values()) {
    if (!win.isDestroyed()) win.webContents.send('skin:preview-veil', veil);
  }
}

export function broadcastDb() {
  const db = getDb();
  const all: (BrowserWindow | null)[] = [...notepads.values(), manager, skinWin];
  for (const win of all) {
    if (win && !win.isDestroyed()) win.webContents.send('db:changed', db);
  }
}

export function destroyAll() {
  for (const win of [...notepads.values(), manager, skinWin]) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  notepads.clear();
  manager = null;
  skinWin = null;
}
