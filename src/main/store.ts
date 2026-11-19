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
import { logError } from './log';
import {
  DEFAULT_IMAGE_RATIO,
  clampCardSize,
  clampImageRatio,
  newQueueFields,
  type Note,
  type NoteColor,
  type NoteDb,
  type Queue,
  type Settings,
} from '../shared/types';

let db: NoteDb = emptyDb();
let dataFile = '';
let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;
const pendingAttachmentCleanup = new Set<string>();
type StoreLoadState = LoadState | { kind: 'unreadable'; file: string; reason: string };
let loadState: StoreLoadState = { kind: 'fresh' };
/** 读取失败、数据版本过高或备份失败时，保护原文件免于被写回。 */
let readOnly = false;
/** 最近一次「读不懂就备份」的落盘位置，启动时告诉用户。 */
let lastBackup: string | null = null;

/**
 * 写盘失败的通知出口。store 只管数据，不碰 UI —— 由 index.ts 注入「记日志 + 弹给用户」。
 * 不注入也要能工作（测试里直接 import 这个模块）。
 */
let onSaveError: ((err: unknown) => void) | null = null;

export function setSaveErrorHandler(fn: (err: unknown) => void) {
  onSaveError = fn;
}

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

function readLocation(file: string): { dataDir: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  const dir = (parsed as { dataDir?: unknown } | null)?.dataDir;
  if (dir === null) return null;
  if (typeof dir === 'string' && dir.trim()) return { dataDir: dir };
  throw new Error('数据目录配置无效');
}

function markUnreadable(file: string, err: unknown) {
  readOnly = true;
  loadState = { kind: 'unreadable', file, reason: err instanceof Error ? err.message : String(err) };
  logError(`store 读取失败 (${file})`, err);
}

function writeLocation(dataDir: string | null) {
  const file = locationPath();
  const tmp = `${file}.${newId()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ dataDir }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        logError(`store 清理地址临时文件失败 (${tmp})`, cleanupErr);
      }
    }
    throw new Error('未能保存新数据目录', { cause: err });
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
  readOnly = false;
  lastBackup = null;
  // NOTES_DATA_DIR 可以把数据放到指定目录：便携版、放网盘同步、多套数据切换都用得上。
  // 指定了就不再走 userData，也不做旧目录迁移（那不是默认位置）。
  // 优先级：环境变量 > 用户选的目录（data-location.json）> 默认 userData。
  const override = process.env.NOTES_DATA_DIR;
  let loc: ReturnType<typeof readLocation> = null;
  if (!override) {
    const file = locationPath();
    try {
      loc = readLocation(file);
    } catch (err) {
      markUnreadable(file, err);
      return db;
    }
  }
  dataFile = override
    ? path.join(override, 'data.json')
    : loc
      ? path.join(loc.dataDir, 'data.json')
      : path.join(app.getPath('userData'), 'data.json');
  if (!override && !loc) migrateLegacyData(dataFile);

  let raw: Buffer;
  try {
    raw = fs.readFileSync(dataFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      db = emptyDb();
      loadState = { kind: 'fresh' };
    } else {
      markUnreadable(dataFile, err);
    }
    return db;
  }

  const { state, db: loaded } = parseDb(raw.toString('utf8'));
  loadState = state;

  switch (state.kind) {
    case 'corrupt': {
      // 关键：读不懂就绝不能把空库写回去。先留一份原文件副本，再让上层决定怎么办。
      lastBackup = backupUnreadable(raw);
      readOnly = lastBackup === null;
      logError(`store 无法解析 ${dataFile}`, state.reason);
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
function backupUnreadable(raw: Buffer): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${dataFile}.corrupt-${stamp}.bak`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw, { flag: 'wx' });
    return file;
  } catch (err) {
    logError(`store 备份失败 (${dataFile})`, err);
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`store 清理附件失败 (${fileName})`, err);
    }
  }
}

function scheduleAttachmentCleanup(name: string | null) {
  if (!readOnly && name && path.basename(name) === name) pendingAttachmentCleanup.add(name);
}

function cleanupUnusedAttachments() {
  if (pendingAttachmentCleanup.size === 0) return;

  // 读取附件时用 basename，Windows 上同名文件也可能写成不同大小写。
  const key = (name: string) => {
    const base = path.basename(name);
    return process.platform === 'win32' ? base.toLowerCase() : base;
  };
  const referenced = new Set<string>();
  if (db.settings.skinImage) referenced.add(key(db.settings.skinImage));
  for (const queue of db.queues) {
    for (const note of [...queue.notes, ...queue.archive]) {
      if (note.image) referenced.add(key(note.image));
    }
  }

  for (const name of pendingAttachmentCleanup) {
    if (!referenced.has(key(name))) removeAttachment(name);
  }
  pendingAttachmentCleanup.clear();
}

/** 换图 / 清图。便签成功写盘后再考虑删旧图。 */
export function setNoteImage(queueId: string, id: string, fileName: string | null) {
  mutate((d) => {
    const note = d.queues.find((q) => q.id === queueId)?.notes.find((n) => n.id === id);
    if (!note) return;
    const old = note.image;
    if (old !== fileName) scheduleAttachmentCleanup(old);
    note.image = fileName;
  });
}

export function setSkinImage(fileName: string | null) {
  mutate((d) => {
    const old = d.settings.skinImage;
    if (old !== fileName) scheduleAttachmentCleanup(old);
    d.settings = { ...d.settings, skinImage: fileName };
  });
}

/* ── 队列 ──
 * 一个队列 = 一个便签窗 + 一叠便签。多开窗口就是多条任务线并行。
 */

export function createQueue(name: string): Queue {
  const queue: Queue = { id: newId(), ...newQueueFields(name.trim() || '未命名') };
  mutate((d) => {
    d.queues.push(queue);
  });
  return queue;
}

export function renameQueue(id: string, name: string) {
  const clean = name.trim();
  if (!clean) return;
  mutate((d) => {
    const q = d.queues.find((x) => x.id === id);
    if (q) q.name = clean;
  });
}

/**
 * 删队列 = 连它那一叠便签和归档一起删，附件也一并清掉。
 * 只剩一个队列时拒绝 —— 一个都没有就等于程序没窗口可开。
 */
export function deleteQueue(id: string): { ok: boolean; reason?: string } {
  if (getDb().queues.length <= 1) return { ok: false, reason: '至少保留一个队列' };
  mutate((d) => {
    const idx = d.queues.findIndex((x) => x.id === id);
    if (idx < 0) return;
    for (const n of d.queues[idx].notes) scheduleAttachmentCleanup(n.image);
    for (const n of d.queues[idx].archive) scheduleAttachmentCleanup(n.image);
    d.queues.splice(idx, 1);
  });
  return { ok: true };
}

/** 窗口位置 / 卡片尺寸 —— 每队列各记一份，多窗口才不会互相踩。 */
export function setQueueBounds(
  id: string,
  patch: { windowX?: number; windowY?: number; cardWidth?: number; cardHeight?: number }
) {
  mutate((d) => {
    const q = d.queues.find((x) => x.id === id);
    if (!q) return;
    if (typeof patch.windowX === 'number') q.windowX = patch.windowX;
    if (typeof patch.windowY === 'number') q.windowY = patch.windowY;
    const size = clampCardSize(patch.cardWidth ?? q.cardWidth, patch.cardHeight ?? q.cardHeight);
    q.cardWidth = size.cardWidth;
    q.cardHeight = size.cardHeight;
  });
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
  if (dirty && !readOnly) {
    return { ok: false, dir: path.dirname(from), reason: '当前便签未能保存，数据目录未切换' };
  }

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
  } catch (err) {
    const cause = err instanceof Error ? err.cause ?? err : err;
    logError(`store 换数据目录失败 (${from} → ${target})`, cause);
    let rollbackFailed = false;
    if (movedFile) {
      try {
        moveFile(target, from);
      } catch (rollbackErr) {
        rollbackFailed = true;
        logError(`store 回滚数据文件失败 (${target} → ${from})`, rollbackErr);
      }
    }
    if (movedAtt) {
      try {
        moveDir(toAtt, fromAtt);
      } catch (rollbackErr) {
        rollbackFailed = true;
        logError(`store 回滚附件失败 (${toAtt} → ${fromAtt})`, rollbackErr);
      }
    }
    return {
      ok: false,
      dir: path.dirname(from),
      reason: rollbackFailed
        ? `换目录失败，部分文件未能搬回。请检查 ${path.dirname(from)} 和 ${path.dirname(target)}`
        : err instanceof Error ? err.message : String(err),
    };
  }
  dataFile = target;
  initStore();
  const state = getLoadState();
  if (state.kind === 'unreadable') {
    return { ok: false, dir: getDataDir(), reason: `文件已搬迁，但无法读取 ${state.file}：${state.reason}` };
  }
  return { ok: true, dir: getDataDir() };
}

export function getLoadState(): StoreLoadState {
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

export function flushSync(): boolean {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return true;
  if (!dataFile || readOnly) return false;
  const tmp = dataFile + '.tmp';
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, dataFile);
    dirty = false;
  } catch (err) {
    // 以前这里只有 console.error —— 打包版没有控制台，磁盘满 / 目录只读 / 网盘占用
    // 的时候，用户以为存上了，实际什么都没写。现在落日志 + 让上层弹给用户。
    logError('store.flush 失败（改动未落盘）', err);
    try {
      onSaveError?.(err);
    } catch {
      /* 本来就在错误处理路径上，通知再抛就真没兜底了 */
    }
    return false;
  }
  cleanupUnusedAttachments();
  return true;
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
  queueId: string,
  partial: { text?: string; color?: NoteColor } = {},
  atTop = false
): Note | null {
  const note: Note = {
    id: newId(),
    text: partial.text ?? '',
    color: partial.color ?? 'amber',
    createdAt: Date.now(),
    doneAt: null,
    dueAt: null,
    dueSetAt: null,
    image: null,
    imageRatio: DEFAULT_IMAGE_RATIO,
  };
  let ok = false;
  mutate((d) => {
    const q = d.queues.find((x) => x.id === queueId);
    if (!q) return;
    if (atTop) q.notes.unshift(note);
    else q.notes.push(note);
    ok = true;
  });
  return ok ? note : null;
}

export function updateNote(
  queueId: string,
  id: string,
  patch: { text?: string; color?: NoteColor; imageRatio?: number }
) {
  mutate((d) => {
    const note = d.queues.find((q) => q.id === queueId)?.notes.find((n) => n.id === id);
    if (!note) return;
    if (typeof patch.text === 'string') note.text = patch.text;
    if (isColor(patch.color)) note.color = patch.color;
    // 拖滑杆是连续调用，每次都要收回范围 —— 越界的值一旦落盘，
    // 下次启动图片会占满整张卡片或缩成一条
    if (typeof patch.imageRatio === 'number') note.imageRatio = clampImageRatio(patch.imageRatio);
  });
}

/**
 * 设 / 清时限。dueSetAt 记的是「设的那一刻」——
 * 便签窗那条细线要靠 (dueAt - now) / (dueAt - dueSetAt) 算剩余比例，少了它画不出来。
 */
export function setNoteDue(queueId: string, id: string, dueAt: number | null) {
  mutate((d) => {
    const note = d.queues.find((q) => q.id === queueId)?.notes.find((n) => n.id === id);
    if (!note) return;
    note.dueAt = dueAt;
    note.dueSetAt = dueAt === null ? null : Date.now();
  });
}

export function completeNote(queueId: string, id: string) {
  mutate((d) => {
    const q = d.queues.find((x) => x.id === queueId);
    if (!q) return;
    const idx = q.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [note] = q.notes.splice(idx, 1);
    note.doneAt = Date.now();
    q.archive.unshift(note);
  });
}

export function restoreNote(queueId: string, id: string) {
  mutate((d) => {
    const q = d.queues.find((x) => x.id === queueId);
    if (!q) return;
    const idx = q.archive.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [note] = q.archive.splice(idx, 1);
    note.doneAt = null;
    q.notes.push(note);
  });
}

export function deleteArchived(queueId: string, id: string) {
  mutate((d) => {
    const q = d.queues.find((x) => x.id === queueId);
    if (q) q.archive = q.archive.filter((n) => n.id !== id);
  });
}

export function clearArchive(queueId: string) {
  mutate((d) => {
    const q = d.queues.find((x) => x.id === queueId);
    if (q) q.archive = [];
  });
}

export function reorderNotes(queueId: string, orderedIds: string[]) {
  mutate((d) => {
    const q = d.queues.find((x) => x.id === queueId);
    if (!q) return;
    const map = new Map(q.notes.map((n) => [n.id, n]));
    const next: Note[] = [];
    for (const id of orderedIds) {
      const note = map.get(id);
      if (note) {
        next.push(note);
        map.delete(id);
      }
    }
    for (const leftover of map.values()) next.push(leftover);
    q.notes = next;
  });
}

export function updateSettings(patch: Partial<Settings>) {
  mutate((d) => {
    d.settings = { ...d.settings, ...patch };
  });
}
