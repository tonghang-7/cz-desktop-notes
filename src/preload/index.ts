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
  openManager: (): Promise<void> => ipcRenderer.invoke('ui:open-manager'),
  hideNotepad: (): Promise<void> => ipcRenderer.invoke('ui:hide-notepad'),
  showNotepad: (): Promise<void> => ipcRenderer.invoke('ui:show-notepad'),
  getHotkey: (): Promise<string> => ipcRenderer.invoke('ui:hotkey'),
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
