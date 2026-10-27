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

/**
 * 「数据放哪个目录」记在 userData 下的 data-location.json，而不是记在 data.json 里 ——
 * 后者记不了自己住哪：得先知道它在哪，才读得到它。
 */
const LOCATION_FILE = 'data-location.json';

function locationPath(): string {
  return path.join(app.getPath('userData'), LOCATION_FILE);
}

function readLocation(): { dataDir: string } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(locationPath(), 'utf8'));
    const dir = (parsed as { dataDir?: unknown } | null)?.dataDir;
    return typeof dir === 'string' && dir ? { dataDir: dir } : null;
  } catch {
    return null;
  }
}

function writeLocation(dataDir: string | null) {
  try {
    fs.mkdirSync(path.dirname(locationPath()), { recursive: true });
    fs.writeFileSync(locationPath(), JSON.stringify({ dataDir }, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] 写数据位置失败：', err);
  }
}

/** 跨盘符时 renameSync 会抛 EXDEV，退回复制 + 删原文件。 */
function moveFile(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/** 搬整个目录（附件用）。跨盘符一样是 EXDEV，退回复制 + 删。 */
function moveDir(from: string, to: string) {
  try {
    fs.renameSync(from, to);
    return;
  } catch {
    // 多半是跨盘符
  }
  fs.cpSync(from, to, { recursive: true });
  try {
    fs.rmSync(from, { recursive: true, force: true });
  } catch {
    // 旧目录删不掉只是浪费点空间 —— 图已经复制到新位置了，功能不受影响
    console.warn('[store] 旧附件目录没删掉（不影响使用）：', from);
  }
}

export function initStore(): NoteDb {
  // NOTES_DATA_DIR 可以把数据放到指定目录：便携版、放网盘同步、多套数据切换都用得上。
  // 指定了就不再走 userData，也不做旧目录迁移（那不是默认位置）。
  // 优先级：环境变量 > 用户选的目录（data-location.json）> 默认 userData。
  const override = process.env.NOTES_DATA_DIR;
  const loc = override ? null : readLocation();
  dataFile = override
    ? path.join(override, 'data.json')
    : loc
      ? path.join(loc.dataDir, 'data.json')
      : path.join(app.getPath('userData'), 'data.json');
  if (!override && !loc) migrateLegacyData(dataFile);

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

export function getDataDir() {
  return path.dirname(dataFile);
}

/** 附件目录。跟 data.json 同住一个数据目录，换目录时要一起搬。 */
export function attachmentsDir() {
  return path.join(path.dirname(dataFile), 'attachments');
}

function removeAttachment(fileName: string) {
  try {
    fs.unlinkSync(path.join(attachmentsDir(), fileName));
  } catch {
    // 文件本来就不在：不是错误
  }
}

/**
 * 换图 / 清图。旧附件顺手删掉 —— 一张图只归一张便签，留着就是纯泄漏。
 */
export function setNoteImage(id: string, fileName: string | null) {
  let old: string | null = null;
  mutate((d) => {
    const note = d.notes.find((n) => n.id === id);
    if (!note) return;
    old = note.image;
    note.image = fileName;
  });
  if (old && old !== fileName) removeAttachment(old);
}

/**
 * 换数据目录：把 data.json 搬过去，不是复制 ——
 * 复制会留下两份，两边各改各的，早晚要合并冲突。
 *
 * 失败要能回到原样：目标位置有别的 data.json 就拒绝（不替用户决定丢哪边），
 * 搬的过程中出错就把文件搬回原处，绝不停在「一半在这、一半在那」的状态。
 */
export function setDataDir(dir: string | null): { ok: boolean; dir: string; reason?: string } {
  // 环境变量优先级最高，此时「默认位置」不是 userData 而是那个目录。
  // 混着来会让搬迁路径算错（曾把文件搬到一个不会回读的地方），所以干脆不让改。
  if (process.env.NOTES_DATA_DIR) {
    return {
      ok: false,
      dir: path.dirname(dataFile),
      reason: '数据位置由环境变量 NOTES_DATA_DIR 指定，在设置里改不了',
    };
  }

  const target = dir
    ? path.join(dir, 'data.json')
    : path.join(app.getPath('userData'), 'data.json');
  const from = dataFile;
  const fromAtt = path.join(path.dirname(from), 'attachments');
  const toAtt = path.join(path.dirname(target), 'attachments');

  if (path.resolve(target) === path.resolve(from)) {
    return { ok: true, dir: path.dirname(target) };
  }
  if (fs.existsSync(target)) {
    return {
      ok: false,
      dir: path.dirname(from),
      reason: `${target} 已经有一份 data.json，没有覆盖它`,
    };
  }
  // 目标位置已经有图片，也不合并 —— 合并两个 attachments 等于替用户猜哪张图归谁
  if (fs.existsSync(toAtt) && fs.readdirSync(toAtt).length > 0) {
    return {
      ok: false,
      dir: path.dirname(from),
      reason: `${toAtt} 里已经有图片附件，没有覆盖它`,
    };
  }

  flushSync();

  const hadFile = fs.existsSync(from);
  const hadAtt = fs.existsSync(fromAtt);
  let movedFile = false;
  let movedAtt = false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 顺序很重要：先搬图片，data.json 放最后。data.json 是「换完了」的旗标 ——
    // 反过来会出现「数据过去了、图还在原地」，那种状态最难收拾。
    if (hadAtt) {
      moveDir(fromAtt, toAtt);
      movedAtt = true;
    }
    if (hadFile) {
      moveFile(from, target);
      movedFile = true;
    }
    writeLocation(dir);
    initStore();
    return { ok: true, dir: getDataDir() };
  } catch (err) {
    if (movedFile) {
      try {
        moveFile(target, from);
      } catch {
        // 搬回去也失败了：两份都在，只能记下来让用户自己收拾
        console.error('[store] 换目录失败且 data.json 回滚失败，两处都可能留有一份');
      }
    }
    if (movedAtt) {
      try {
        moveDir(toAtt, fromAtt);
      } catch {
        console.error('[store] 换目录失败且附件回滚失败，两处都可能留有图片');
      }
    }
    return {
      ok: false,
      dir: path.dirname(from),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
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

/**
 * @param atTop 放到栈顶。剪贴板捕获这类入口必须置顶 ——
 *   否则新便签排在最后，而便签窗只显示栈顶那张，用户按了热键却什么都看不到。
 */
export function createNote(
  partial: { text?: string; color?: NoteColor } = {},
  atTop = false
): Note {
  const note: Note = {
    id: newId(),
    text: partial.text ?? '',
    color: partial.color ?? 'amber',
    createdAt: Date.now(),
    doneAt: null,
    dueAt: null,
    dueSetAt: null,
    image: null,
  };
  mutate((d) => {
    if (atTop) d.notes.unshift(note);
    else d.notes.push(note);
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

/**
 * 设 / 清时限。dueSetAt 记的是「设的那一刻」——
 * 便签窗那条细线要靠 (dueAt - now) / (dueAt - dueSetAt) 算剩余比例，少了它画不出来。
 */
export function setNoteDue(id: string, dueAt: number | null) {
  mutate((d) => {
    const note = d.notes.find((n) => n.id === id);
    if (!note) return;
    note.dueAt = dueAt;
    note.dueSetAt = dueAt === null ? null : Date.now();
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
