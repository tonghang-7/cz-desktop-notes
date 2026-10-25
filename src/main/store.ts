import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  clampCardSize,
  type Note,
  type NoteColor,
  type NoteDb,
  type Settings,
} from '../shared/types';

const COLORS: NoteColor[] = ['amber', 'rose', 'sky', 'mint', 'violet'];

let db: NoteDb = emptyDb();
let dataFile = '';
let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;

function emptyDb(): NoteDb {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, notes: [], archive: [] };
}

function newId() {
  return randomUUID();
}

function isColor(v: unknown): v is NoteColor {
  return typeof v === 'string' && (COLORS as string[]).includes(v);
}

function normalizeNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    text: typeof r.text === 'string' ? r.text : '',
    color: isColor(r.color) ? r.color : 'amber',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    doneAt: typeof r.doneAt === 'number' ? r.doneAt : null,
  };
}

function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const size = clampCardSize(
    typeof r.cardWidth === 'number' ? r.cardWidth : DEFAULT_SETTINGS.cardWidth,
    typeof r.cardHeight === 'number' ? r.cardHeight : DEFAULT_SETTINGS.cardHeight
  );
  return {
    hotkey: typeof r.hotkey === 'string' && r.hotkey ? r.hotkey : DEFAULT_SETTINGS.hotkey,
    cardWidth: size.cardWidth,
    cardHeight: size.cardHeight,
    windowX: typeof r.windowX === 'number' ? r.windowX : null,
    windowY: typeof r.windowY === 'number' ? r.windowY : null,
  };
}

function normalizeDb(raw: unknown): NoteDb {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const notes = Array.isArray(r.notes)
    ? r.notes.map(normalizeNote).filter((n): n is Note => n !== null)
    : [];
  const archive = Array.isArray(r.archive)
    ? r.archive.map(normalizeNote).filter((n): n is Note => n !== null)
    : [];
  return { version: 1, settings: normalizeSettings(r.settings), notes, archive };
}

export function initStore(): NoteDb {
  // NOTES_DATA_DIR 可以把数据放到指定目录：便携版、放网盘同步、多套数据切换都用得上。
  // 指定了就不再走 userData，也不做旧目录迁移（那不是默认位置）。
  const override = process.env.NOTES_DATA_DIR;
  dataFile = override
    ? path.join(override, 'data.json')
    : path.join(app.getPath('userData'), 'data.json');
  if (!override) migrateLegacyData(dataFile);
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    db = normalizeDb(JSON.parse(raw));
  } catch {
    db = emptyDb();
  }
  return db;
}

/**
 * 兼容包名变更前的旧数据目录：userData 路径由 package.json 的 name 决定，
 * 改过 name 就会指向新目录，旧数据留在原处读不到。
 * 若新目录还没有数据、而旧目录有，就把旧数据复制过来（复制而非移动：
 * 旧文件保留，最坏情况只是多一份副本，不会因为迁移中途出错而丢数据）。
 */
const LEGACY_APP_DIRS = ['desktop-notes'];

function migrateLegacyData(target: string) {
  try {
    if (fs.existsSync(target)) return;
    const base = app.getPath('appData');
    for (const dir of LEGACY_APP_DIRS) {
      const old = path.join(base, dir, 'data.json');
      if (!fs.existsSync(old)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(old, target);
      console.log(`[store] migrated legacy data: ${old} -> ${target}`);
      return;
    }
  } catch (err) {
    console.error('[store] legacy migration failed:', err);
  }
}

export function getDb(): NoteDb {
  return db;
}

export function getDataFile() {
  return dataFile;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSync();
  }, 250);
}

export function flushSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty || !dataFile) return;
  const tmp = dataFile + '.tmp';
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, dataFile);
    dirty = false;
  } catch (err) {
    console.error('[store] flush failed:', err);
  }
}

export function mutate(fn: (d: NoteDb) => void): NoteDb {
  fn(db);
  scheduleSave();
  return db;
}

export function createNote(partial: { text?: string; color?: NoteColor } = {}): Note {
  const note: Note = {
    id: newId(),
    text: partial.text ?? '',
    color: partial.color ?? 'amber',
    createdAt: Date.now(),
    doneAt: null,
  };
  mutate((d) => {
    d.notes.push(note);
  });
  return note;
}

export function updateNote(id: string, patch: { text?: string; color?: NoteColor }) {
  mutate((d) => {
    const note = d.notes.find((n) => n.id === id);
    if (!note) return;
    if (typeof patch.text === 'string') note.text = patch.text;
    if (isColor(patch.color)) note.color = patch.color;
  });
}

export function completeNote(id: string) {
  mutate((d) => {
    const idx = d.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [note] = d.notes.splice(idx, 1);
    note.doneAt = Date.now();
    d.archive.unshift(note);
  });
}

export function restoreNote(id: string) {
  mutate((d) => {
    const idx = d.archive.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [note] = d.archive.splice(idx, 1);
    note.doneAt = null;
    d.notes.push(note);
  });
}

export function deleteArchived(id: string) {
  mutate((d) => {
    d.archive = d.archive.filter((n) => n.id !== id);
  });
}

export function clearArchive() {
  mutate((d) => {
    d.archive = [];
  });
}

export function reorderNotes(orderedIds: string[]) {
  mutate((d) => {
    const map = new Map(d.notes.map((n) => [n.id, n]));
    const next: Note[] = [];
    for (const id of orderedIds) {
      const note = map.get(id);
      if (note) {
        next.push(note);
        map.delete(id);
      }
    }
    for (const leftover of map.values()) next.push(leftover);
    d.notes = next;
  });
}

export function updateSettings(patch: Partial<Settings>) {
  mutate((d) => {
    const size = clampCardSize(
      patch.cardWidth ?? d.settings.cardWidth,
      patch.cardHeight ?? d.settings.cardHeight
    );
    d.settings = {
      ...d.settings,
      ...patch,
      cardWidth: size.cardWidth,
      cardHeight: size.cardHeight,
    };
  });
}
