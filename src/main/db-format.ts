/**
 * data.json 的纯逻辑层：结构规范化、版本迁移、解析。
 *
 * 刻意不 import electron —— 这些函数要能被 node --test 直接跑。
 * 副作用（读写文件、弹窗）留在 store.ts / index.ts。
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  clampCardSize,
  type Note,
  type NoteColor,
  type NoteDb,
  type Settings,
} from '../shared/types';

/** 当前数据结构版本。改数据结构就 +1，并在 MIGRATIONS 里补一条升级路径。 */
export const DB_VERSION = 1;

export type Migration = (db: Record<string, unknown>) => Record<string, unknown>;

/**
 * 迁移链：key 是旧版本号，函数把旧结构升级到下一版。
 * 已发布的迁移永不修改，只往后加 —— 否则老用户的数据会被两次迁移搞坏。
 *
 * 规矩：迁移新增的字段，必须同时加进 NoteDb 类型和 normalizeDb。
 * 少改一处，parseDb 会直接判定为「结构对不上」并报错 —— 宁可报错，
 * 也不能把用户的字段悄悄丢掉。
 */
export const MIGRATIONS: Record<number, Migration> = {
  // 例：1: (db) => ({ ...db, pinned: false }),   // v1 → v2
};

/** NoteDb 允许出现的顶层键。normalizeDb 按白名单重建对象，多出来的键视为「没接住」。 */
const KNOWN_KEYS = new Set(['version', 'settings', 'notes', 'archive']);

export type LoadState =
  /** 目录里还没有 data.json，第一次启动 */
  | { kind: 'fresh' }
  /** 正常读到当前版本 */
  | { kind: 'loaded'; version: number }
  /** 读到旧版本，已就地升级 */
  | { kind: 'migrated'; from: number; to: number }
  /** 文件在但读不懂：JSON 坏了，或结构对不上 */
  | { kind: 'corrupt'; reason: string }
  /** 文件来自更新版本的程序（用户降级了），不能动它 */
  | { kind: 'future'; version: number };

const COLORS: NoteColor[] = ['amber', 'rose', 'sky', 'mint', 'violet'];

export function emptyDb(): NoteDb {
  return { version: DB_VERSION, settings: { ...DEFAULT_SETTINGS }, notes: [], archive: [] };
}

export function isColor(v: unknown): v is NoteColor {
  return typeof v === 'string' && (COLORS as string[]).includes(v);
}

function normalizeNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
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

export function normalizeDb(raw: unknown): NoteDb {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const notes = Array.isArray(r.notes)
    ? r.notes.map((n) => normalizeNote(n)).filter((n): n is Note => n !== null)
    : [];
  const archive = Array.isArray(r.archive)
    ? r.archive.map((n) => normalizeNote(n)).filter((n): n is Note => n !== null)
    : [];
  return { version: DB_VERSION, settings: normalizeSettings(r.settings), notes, archive };
}

function readVersion(raw: Record<string, unknown>): number {
  const v = raw.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return 1;
  return v;
}

/**
 * 把旧结构逐级升级到 targetVersion。
 * 任何一级缺迁移都直接抛错 —— 宁可报错也不能悄悄丢字段。
 */
export function migrateDb(
  raw: Record<string, unknown>,
  targetVersion: number = DB_VERSION,
  migrations: Record<number, Migration> = MIGRATIONS
): { db: Record<string, unknown>; from: number } {
  const from = readVersion(raw);
  let version = from;
  const db = { ...raw };
  while (version < targetVersion) {
    const step = migrations[version];
    if (!step) throw new Error(`缺少 v${version} → v${version + 1} 的迁移`);
    const next = step(db);
    version += 1;
    next.version = version;
    Object.assign(db, next);
  }
  return { db, from };
}

/**
 * 解析 data.json 文本。永不抛异常 —— 解析不了就返回 corrupt，由上层决定怎么办。
 * 关键约定：corrupt / future 两种情况下，上层绝不能把空库写回原文件。
 */
export function parseDb(
  text: string,
  targetVersion: number = DB_VERSION,
  migrations: Record< number, Migration> = MIGRATIONS
): { state: LoadState; db: NoteDb } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      state: { kind: 'corrupt', reason: err instanceof Error ? err.message : String(err) },
      db: emptyDb(),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: { kind: 'corrupt', reason: '顶层不是对象' }, db: emptyDb() };
  }

  const raw = parsed as Record<string, unknown>;
  const version = readVersion(raw);
  if (version > targetVersion) {
    return { state: { kind: 'future', version }, db: emptyDb() };
  }

  try {
    const { db, from } = migrateDb(raw, targetVersion, migrations);
    const dropped = Object.keys(db).filter((k) => !KNOWN_KEYS.has(k));
    if (dropped.length) {
      throw new Error(`迁移后有字段没被接收：${dropped.join(', ')}（请同步改 NoteDb 与 normalizeDb）`);
    }
    const state: LoadState =
      from === targetVersion
        ? { kind: 'loaded', version: targetVersion }
        : { kind: 'migrated', from, to: targetVersion };
    return { state, db: normalizeDb(db) };
  } catch (err) {
    return {
      state: { kind: 'corrupt', reason: err instanceof Error ? err.message : String(err) },
      db: emptyDb(),
    };
  }
}
