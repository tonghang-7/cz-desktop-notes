import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DB_VERSION,
  emptyDb,
  isColor,
  parseDb,
  type LoadState,
} from './db-format';
import {
  clampCardSize,
  type Note,
  type NoteColor,
  type NoteDb,
  type Settings,
} from '../shared/types';

let db: NoteDb = emptyDb();
let dataFile = '';
let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;
let loadState: LoadState = { kind: 'fresh' };
/** 数据文件来自更新版本的程序时只读：任何写回都会把新结构降级成旧结构。 */
let readOnly = false;
/** 最近一次「读不懂就备份」的落盘位置，启动时告诉用户。 */
let lastBackup: string | null = null;

function newId() {
  return randomUUID();
}

export function initStore(): NoteDb {
  // NOTES_DATA_DIR 可以把数据放到指定目录：便携版、放网盘同步、多套数据切换都用得上。
  // 指定了就不再走 userData，也不做旧目录迁移（那不是默认位置）。
  const override = process.env.NOTES_DATA_DIR;
  dataFile = override
    ? path.join(override, 'data.json')
    : path.join(app.getPath('userData'), 'data.json');
  if (!override) migrateLegacyData(dataFile);

  let raw: string;
  try {
    raw = fs.readFileSync(dataFile, 'utf8');
  } catch {
    // 第一次启动：目录里还没有 data.json。
    db = emptyDb();
    loadState = { kind: 'fresh' };
    return db;
  }

  const { state, db: loaded } = parseDb(raw);
  loadState = state;

  switch (state.kind) {
    case 'corrupt': {
      // 关键：读不懂就绝不能把空库写回去。先留一份原文件副本，再让上层决定怎么办。
      const backup = backupUnreadable(raw);
      console.error('[store] data.json 无法解析：', state.reason, backup ? `已备份到 ${backup}` : '备份失败');
      db = emptyDb();
      break;
    }
    case 'future': {
      // 用户降级了程序：文件结构比这份代码新，只读不写。
      readOnly = true;
      console.warn(`[store] data.json 版本 v${state.version} 高于当前支持的 v${DB_VERSION}，已转为只读`);
      db = emptyDb();
      break;
    }
    case 'migrated': {
      console.log(`[store] data.json 已从 v${state.from} 迁移到 v${state.to}`);
      db = loaded;
      scheduleSave();
      break;
    }
    default:
      db = loaded;
  }
  return db;
}

/** 把读不懂的原始内容另存一份，原文件保持不动。 */
function backupUnreadable(raw: string): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${dataFile}.corrupt-${stamp}.bak`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw, 'utf8');
    lastBackup = file;
    return file;
  } catch (err) {
    console.error('[store] 备份失败：', err);
    return null;
  }
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

export function getLoadState(): LoadState {
  return loadState;
}

export function isReadOnly() {
  return readOnly;
}

export function getLastBackup() {
  return lastBackup;
}

function scheduleSave() {
  if (readOnly) return;
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
  if (!dirty || !dataFile || readOnly) return;
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
