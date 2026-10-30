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

const api = {
  getDb: (): Promise<NoteDb> => ipcRenderer.invoke('db:get'),
  /** queueId 省略时用本窗口自己的那个（见 pageQueue）。 */
  createNote: (text: string, color?: NoteColor, queueId?: string): Promise<Note | null> =>
    ipcRenderer.invoke('note:create', pick(queueId), text, color),
  updateNote: (
    id: string,
    patch: { text?: string; color?: NoteColor },
    queueId?: string
  ): Promise<void> => ipcRenderer.invoke('note:update', pick(queueId), id, patch),
  completeNote: (id: string, queueId?: string): Promise<void> =>
    ipcRenderer.invoke('note:complete', pick(queueId), id),
  restoreNote: (id: string, queueId?: string): Promise<void> =>
    ipcRenderer.invoke('note:restore', pick(queueId), id),
  deleteArchived: (id: string, queueId?: string): Promise<void> =>
    ipcRenderer.invoke('archive:delete', pick(queueId), id),
  clearArchive: (queueId?: string): Promise<void> =>
    ipcRenderer.invoke('archive:clear', pick(queueId)),
  reorderNotes: (ids: string[], queueId?: string): Promise<void> =>
    ipcRenderer.invoke('notes:reorder', pick(queueId), ids),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:update', patch),
  /** 本窗口所属的队列 id（便签窗用；管理窗是空串） */
  myQueueId: (): string => pageQueue,
  createQueue: (name: string): Promise<Queue> => ipcRenderer.invoke('queue:create', name),
  renameQueue: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke('queue:rename', id, name),
  deleteQueue: (id: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('queue:delete', id),
  setQueueBounds: (
    id: string,
    patch: { cardWidth?: number; cardHeight?: number }
  ): Promise<Queue | null> => ipcRenderer.invoke('queue:bounds', id, patch),
  /** dueAt 传 null 表示清掉时限 */
  setDue: (id: string, dueAt: number | null, queueId?: string): Promise<void> =>
    ipcRenderer.invoke('note:due', pick(queueId), id, dueAt),
  /** 把图片写进附件目录，返回文件名 */
  saveImage: (data: ArrayBuffer, mime: string): Promise<string> =>
    ipcRenderer.invoke('image:save', data, mime),
  /** fileName 传 null 表示去掉这张卡的图 */
  setImage: (id: string, fileName: string | null, queueId?: string): Promise<void> =>
    ipcRenderer.invoke('note:image', pick(queueId), id, fileName),
  /** 读附件，拿 data URL（同源，canvas 能和 drawElementImage 一起抓） */
  readImage: (fileName: string): Promise<string | null> =>
    ipcRenderer.invoke('image:read', fileName),
  /** 用系统看图程序打开（返回错误信息，成功时是 null） */
  openImage: (fileName: string): Promise<string | null> =>
    ipcRenderer.invoke('image:open', fileName),
  /** 选一张图当皮肤背景，返回原图的 data URL（压缩由渲染进程做） */
  pickSkinImage: (): Promise<{ dataUrl: string } | { error: string } | null> =>
    ipcRenderer.invoke('skin:pick'),
  /** 存压好的背景图，返回文件名 */
  saveSkinImage: (dataUrl: string): Promise<{ ok: boolean; name?: string; reason?: string }> =>
    ipcRenderer.invoke('skin:save', dataUrl),
  clearSkinImage: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('skin:clear'),
  /** 拖蒙版滑杆时的实时预览，只到便签窗，不写盘。调用方负责节流。 */
  previewSkinVeil: (veil: number): Promise<void> => ipcRenderer.invoke('skin:preview-veil', veil),
  onSkinPreview: (cb: (veil: number) => void) => {
    const listener = (_e: unknown, veil: number) => cb(veil);
    ipcRenderer.on('skin:preview-veil', listener);
    return () => ipcRenderer.off('skin:preview-veil', listener);
  },
  notify: (title: string, body: string): Promise<void> =>
    ipcRenderer.invoke('ui:notify', title, body),
  /** 当前版本号，比如 0.5.0 */
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** 用默认浏览器打开最新 Release 页（下完整包用） */
  openReleases: (): Promise<void> => ipcRenderer.invoke('app:openReleases'),
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
  }> => ipcRenderer.invoke('update:check'),
  /** 下载增量包到本地并校验（不替换） */
  downloadUpdate: (info: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('update:download', info),
  /** 已经下好、等重启生效的版本 */
  pendingUpdate: (): Promise<{ version: string; at: number } | null> =>
    ipcRenderer.invoke('update:pending'),
  /** 上次安装失败的原因（打包版没控制台，只能靠这个回传） */
  lastUpdateError: (): Promise<string | null> => ipcRenderer.invoke('update:lastError'),
  /** 重启应用（安装更新后由用户点） */
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('update:relaunch'),
  /** fromCard=true：从便签窗点卡片/新建进来，管理窗打开后直接把光标放进编辑器 */
  openManager: (fromCard?: boolean): Promise<void> =>
    ipcRenderer.invoke('ui:open-manager', fromCard),
  onFocusEditor: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('manager:focus-editor', listener);
    return () => ipcRenderer.off('manager:focus-editor', listener);
  },
  openSkinWindow: (): Promise<void> => ipcRenderer.invoke('ui:open-skin'),
  hideNotepad: (): Promise<void> => ipcRenderer.invoke('ui:hide-notepad'),
  showNotepad: (): Promise<void> => ipcRenderer.invoke('ui:show-notepad'),
  getHotkey: (): Promise<string> => ipcRenderer.invoke('ui:hotkey'),
  setHotkey: (accel: string): Promise<{ ok: boolean; active: string; reason?: string }> =>
    ipcRenderer.invoke('hotkey:set', accel),
  getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke('app:get-autolaunch'),
  setAutoLaunch: (on: boolean): Promise<boolean> => ipcRenderer.invoke('app:set-autolaunch', on),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('data:get-dir'),
  /** 传 null 表示回到默认位置 */
  setDataDir: (dir: string | null): Promise<{ ok: boolean; dir: string; reason?: string }> =>
    ipcRenderer.invoke('data:set-dir', dir),
  chooseDataDir: (): Promise<string | null> => ipcRenderer.invoke('data:choose-dir'),
  quit: (): Promise<void> => ipcRenderer.invoke('ui:quit'),
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
