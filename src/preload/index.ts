import { contextBridge, ipcRenderer } from 'electron';
import type { Note, NoteColor, NoteDb, Queue, Settings } from '../shared/types';

/**
 * 这一扇窗属于哪个队列。
 *
 * 便签窗的 URL 带 `?q=<queueId>`（主进程建窗时塞的），preload 在这里读一次，
 * 之后所有便签操作自动带上 —— 渲染层的调用点一行都不用改。
 * 管理窗没有 q（它要管所有队列），那边显式传。
 */
const pageQueue = (() => {
  try {
    return new URLSearchParams(location.search).get('q') ?? '';
  } catch {
    return '';
  }
})();

const pick = (explicit?: string) => explicit ?? pageQueue;

/**
 * 所有 IPC 调用的唯一出口。
 *
 * 渲染进程没有文件系统，失败的调用以前直接 reject 到调用点 —— 而调用点大多是
 * `void api.xxx()`，等于把错误当场扔掉。用户看到的现象就是「点了没反应」，
 * 事后一点现场都没有（打包版连控制台都没有）。
 *
 * 这里统一把失败送回主进程落日志（`logs/main.log`），再原样抛出去 ——
 * 不想处理的调用点不用改，想处理的照旧 catch，语义没变。
 */
function invoke<R>(channel: string, ...args: unknown[]): Promise<R> {
  return (ipcRenderer.invoke(channel, ...args) as Promise<R>).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? '') : '';
    // 跨进程传回来的 stack 常常就是 "Error: <message>"，别再记一遍 message。
    const detail = stack.includes(message) ? stack : stack ? `${message}\n${stack}` : message;
    // 上报自身失败必须吞掉：否则会在「错误处理」里再造一个未处理拒绝。
    void ipcRenderer.invoke('app:log', `ipc ${channel}`, detail).catch(() => {});
    throw err;
  });
}

const api = {
  getDb: (): Promise<NoteDb> => invoke('db:get'),
  /** queueId 省略时用本窗口自己的那个（见 pageQueue）。 */
  createNote: (text: string, color?: NoteColor, queueId?: string): Promise<Note | null> =>
    invoke('note:create', pick(queueId), text, color),
  updateNote: (
    id: string,
    patch: { title?: string; text?: string; color?: NoteColor; imageRatio?: number },
    queueId?: string
  ): Promise<void> => invoke('note:update', pick(queueId), id, patch),
  completeNote: (id: string, queueId?: string): Promise<void> =>
    invoke('note:complete', pick(queueId), id),
  restoreNote: (id: string, queueId?: string): Promise<void> =>
    invoke('note:restore', pick(queueId), id),
  deleteArchived: (id: string, queueId?: string): Promise<void> =>
    invoke('archive:delete', pick(queueId), id),
  clearArchive: (queueId?: string): Promise<void> =>
    invoke('archive:clear', pick(queueId)),
  reorderNotes: (ids: string[], queueId?: string): Promise<void> =>
    invoke('notes:reorder', pick(queueId), ids),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    invoke('settings:update', patch),
  /** 本窗口所属的队列 id（便签窗用；管理窗是空串） */
  myQueueId: (): string => pageQueue,
  createQueue: (name: string): Promise<Queue> => invoke('queue:create', name),
  renameQueue: (id: string, name: string): Promise<void> =>
    invoke('queue:rename', id, name),
  deleteQueue: (id: string): Promise<{ ok: boolean; reason?: string }> =>
    invoke('queue:delete', id),
  setQueueBounds: (
    id: string,
    patch: { cardWidth?: number; cardHeight?: number }
  ): Promise<Queue | null> => invoke('queue:bounds', id, patch),
  /** dueAt 传 null 表示清掉时限 */
  setDue: (id: string, dueAt: number | null, queueId?: string): Promise<void> =>
    invoke('note:due', pick(queueId), id, dueAt),
  /** 把图片写进附件目录，返回文件名 */
  saveImage: (data: ArrayBuffer, mime: string): Promise<string> =>
    invoke('image:save', data, mime),
  /** fileName 传 null 表示去掉这张卡的图 */
  setImage: (id: string, fileName: string | null, queueId?: string): Promise<void> =>
    invoke('note:image', pick(queueId), id, fileName),
  /** 读附件，拿 data URL（同源，canvas 能和 drawElementImage 一起抓） */
  readImage: (fileName: string): Promise<string | null> =>
    invoke('image:read', fileName),
  /** 铺满屏幕看这张图（单独一扇窗，点任意处关闭） */
  previewImage: (fileName: string): Promise<void> => invoke('image:preview', fileName),
  /** 用系统看图程序打开（返回错误信息，成功时是 null） */
  openImage: (fileName: string): Promise<string | null> =>
    invoke('image:open', fileName),
  /** 选一张图当皮肤背景，返回原图的 data URL（压缩由渲染进程做） */
  pickSkinImage: (): Promise<{ dataUrl: string } | { error: string } | null> =>
    invoke('skin:pick'),
  /** 存压好的背景图，返回文件名 */
  saveSkinImage: (dataUrl: string): Promise<{ ok: boolean; name?: string; reason?: string }> =>
    invoke('skin:save', dataUrl),
  clearSkinImage: (): Promise<{ ok: boolean }> => invoke('skin:clear'),
  /** 拖蒙版滑杆时的实时预览，只到便签窗，不写盘。调用方负责节流。 */
  previewSkinVeil: (veil: number): Promise<void> => invoke('skin:preview-veil', veil),
  onSkinPreview: (cb: (veil: number) => void) => {
    const listener = (_e: unknown, veil: number) => cb(veil);
    ipcRenderer.on('skin:preview-veil', listener);
    return () => ipcRenderer.off('skin:preview-veil', listener);
  },
  /** 拖图片高度滑杆时的实时预览，只到便签窗，不写盘。调用方负责节流。 */
  previewImageRatio: (noteId: string, ratio: number): Promise<void> =>
    invoke('note:preview-ratio', noteId, ratio),
  onPreviewImageRatio: (cb: (noteId: string, ratio: number) => void) => {
    const listener = (_e: unknown, noteId: string, ratio: number) => cb(noteId, ratio);
    ipcRenderer.on('note:preview-ratio', listener);
    return () => ipcRenderer.off('note:preview-ratio', listener);
  },
  notify: (title: string, body: string): Promise<void> =>
    invoke('ui:notify', title, body),
  /** 当前版本号，比如 0.5.0 */
  getVersion: (): Promise<string> => invoke('app:version'),
  /** 用默认浏览器打开最新 Release 页（下完整包用） */
  openReleases: (): Promise<void> => invoke('app:openReleases'),
  /** 查有没有新版（走 GitHub API，只在点的时候调用） */
  checkUpdate: (): Promise<{
    ok: boolean;
    current: string;
    info?: {
      version: string;
      size: number;
      url: string;
      sha256: string;
      electronVersion: string;
      notes: string;
    } | null;
    error?: string;
  }> => invoke('update:check'),
  /** 下载增量包到本地并校验（不替换） */
  downloadUpdate: (info: unknown): Promise<{ ok: boolean; error?: string }> =>
    invoke('update:download', info),
  /** 已经下好、等重启生效的版本 */
  pendingUpdate: (): Promise<{ version: string; at: number } | null> =>
    invoke('update:pending'),
  /** 上次安装失败的原因（打包版没控制台，只能靠这个回传） */
  lastUpdateError: (): Promise<string | null> => invoke('update:lastError'),
  /** 重启应用（安装更新后由用户点） */
  relaunchApp: (): Promise<void> => invoke('update:relaunch'),
  /** fromCard=true：从便签窗点卡片/新建进来，管理窗打开后直接把光标放进编辑器 */
  openManager: (fromCard?: boolean): Promise<void> =>
    invoke('ui:open-manager', fromCard),
  onFocusEditor: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('manager:focus-editor', listener);
    return () => ipcRenderer.off('manager:focus-editor', listener);
  },
  openSkinWindow: (): Promise<void> => invoke('ui:open-skin'),
  hideNotepad: (): Promise<void> => invoke('ui:hide-notepad'),
  showNotepad: (): Promise<void> => invoke('ui:show-notepad'),
  getHotkey: (): Promise<string> => invoke('ui:hotkey'),
  setHotkey: (accel: string): Promise<{ ok: boolean; active: string; reason?: string }> =>
    invoke('hotkey:set', accel),
  getAutoLaunch: (): Promise<boolean> => invoke('app:get-autolaunch'),
  setAutoLaunch: (on: boolean): Promise<boolean> => invoke('app:set-autolaunch', on),
  getDataDir: (): Promise<string> => invoke('data:get-dir'),
  /** 传 null 表示回到默认位置 */
  setDataDir: (dir: string | null): Promise<{ ok: boolean; dir: string; reason?: string }> =>
    invoke('data:set-dir', dir),
  chooseDataDir: (): Promise<string | null> => invoke('data:choose-dir'),
  quit: (): Promise<void> => invoke('ui:quit'),
  onDbChanged: (cb: (db: NoteDb) => void) => {
    const listener = (_e: unknown, db: NoteDb) => cb(db);
    ipcRenderer.on('db:changed', listener);
    return () => ipcRenderer.off('db:changed', listener);
  },
  onShown: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('notepad:shown', listener);
    return () => ipcRenderer.off('notepad:shown', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
