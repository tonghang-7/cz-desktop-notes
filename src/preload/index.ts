import { contextBridge, ipcRenderer } from 'electron';
import type { Note, NoteColor, NoteDb, Settings } from '../shared/types';

const api = {
  getDb: (): Promise<NoteDb> => ipcRenderer.invoke('db:get'),
  createNote: (text: string, color?: NoteColor): Promise<Note> =>
    ipcRenderer.invoke('note:create', text, color),
  updateNote: (id: string, patch: { text?: string; color?: NoteColor }): Promise<void> =>
    ipcRenderer.invoke('note:update', id, patch),
  completeNote: (id: string): Promise<void> => ipcRenderer.invoke('note:complete', id),
  restoreNote: (id: string): Promise<void> => ipcRenderer.invoke('note:restore', id),
  deleteArchived: (id: string): Promise<void> => ipcRenderer.invoke('archive:delete', id),
  clearArchive: (): Promise<void> => ipcRenderer.invoke('archive:clear'),
  reorderNotes: (ids: string[]): Promise<void> => ipcRenderer.invoke('notes:reorder', ids),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:update', patch),
  /** dueAt 传 null 表示清掉时限 */
  setDue: (id: string, dueAt: number | null): Promise<void> =>
    ipcRenderer.invoke('note:due', id, dueAt),
  /** 把图片写进附件目录，返回文件名 */
  saveImage: (data: ArrayBuffer, mime: string): Promise<string> =>
    ipcRenderer.invoke('image:save', data, mime),
  /** fileName 传 null 表示去掉这张卡的图 */
  setImage: (id: string, fileName: string | null): Promise<void> =>
    ipcRenderer.invoke('note:image', id, fileName),
  /** 读附件，拿 data URL（同源，canvas 能和 drawElementImage 一起抓） */
  readImage: (fileName: string): Promise<string | null> =>
    ipcRenderer.invoke('image:read', fileName),
  /** 用系统看图程序打开（返回错误信息，成功时是 null） */
  openImage: (fileName: string): Promise<string | null> =>
    ipcRenderer.invoke('image:open', fileName),
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
