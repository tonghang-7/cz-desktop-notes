/**
 * data.json 格式层的测试。
 * 跑法：npm test（会先 build，产出 dist/main/db-format.js）
 *
 * 这些用例守的是「用户数据不被静默清空」这条底线：
 * 读不懂的文件绝不能被空库覆盖，读得懂但版本更高的文件绝不能被写回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseDb, migrateDb, normalizeDb, DB_VERSION } = require('../dist/main/db-format.js');

const validDb = () => ({
  version: 1,
  settings: { hotkey: 'Control+Alt+Space', cardWidth: 320, cardHeight: 250, windowX: 1, windowY: 2 },
  notes: [
    { id: 'a', text: '第一条', color: 'amber', createdAt: 100, doneAt: null },
    { id: 'b', text: '第二条', color: 'rose', createdAt: 200, doneAt: 300 },
  ],
  archive: [],
});

test('正常 v1 数据：loaded，笔记一条不少', () => {
  const { state, db } = parseDb(JSON.stringify(validDb()));
  assert.equal(state.kind, 'loaded');
  assert.equal(db.notes.length, 2);
  assert.equal(db.notes[0].text, '第一条');
  assert.equal(db.notes[1].doneAt, 300);
  assert.equal(db.settings.hotkey, 'Control+Alt+Space');
  assert.equal(db.version, DB_VERSION);
});

test('缺 version 的老文件按 v1 处理，不当成损坏', () => {
  const raw = validDb();
  delete raw.version;
  const { state, db } = parseDb(JSON.stringify(raw));
  assert.equal(state.kind, 'loaded');
  assert.equal(db.notes.length, 2);
});

test('版本高于当前：future，绝不当成损坏', () => {
  const raw = { ...validDb(), version: DB_VERSION + 1 };
  const { state, db } = parseDb(JSON.stringify(raw));
  assert.equal(state.kind, 'future');
  assert.equal(state.version, DB_VERSION + 1);
  assert.equal(db.notes.length, 0);
});

test('JSON 坏了：corrupt，且不返回任何原内容', () => {
  const { state, db } = parseDb('{ "notes": [');
  assert.equal(state.kind, 'corrupt');
  assert.ok(state.reason.length > 0);
  assert.equal(db.notes.length, 0);
  assert.equal(db.archive.length, 0);
});

test('顶层不是对象（数组/数字/字符串）：corrupt', () => {
  for (const bad of ['[]', '42', '"hi"', 'null']) {
    assert.equal(parseDb(bad).state.kind, 'corrupt', bad);
  }
});

test('迁移链逐级执行，版本号与字段都对', () => {
  const migrations = {
    1: (db) => ({ ...db, pinned: false }),
    2: (db) => ({ ...db, tags: [] }),
  };
  const { db, from } = migrateDb({ version: 1, notes: [] }, 3, migrations);
  assert.equal(from, 1);
  assert.equal(db.version, 3);
  assert.equal(db.pinned, false);
  assert.deepEqual(db.tags, []);
});

test('缺迁移时抛错，不静默丢字段', () => {
  assert.throws(() => migrateDb({ version: 1 }, 2, {}), /缺少 v1 → v2 的迁移/);
});

test('解析时的迁移：老版本文件升级后状态是 migrated，内容正确', () => {
  // 迁移只改动 normalizeDb 认得的字段，才算一次「接得住」的迁移
  const migrations = { 1: (db) => ({ ...db, notes: db.notes.map((n) => ({ ...n, color: 'sky' })) }) };
  const { state, db } = parseDb(JSON.stringify(validDb()), 2, migrations);
  assert.equal(state.kind, 'migrated');
  assert.equal(state.from, 1);
  assert.equal(state.to, 2);
  assert.equal(db.notes.length, 2);
  assert.equal(db.notes[0].color, 'sky');
});

test('迁移新增了没人接的字段：直接报错，不静默丢字段', () => {
  const migrations = { 1: (db) => ({ ...db, pinned: false }) };
  const { state } = parseDb(JSON.stringify(validDb()), 2, migrations);
  assert.equal(state.kind, 'corrupt');
  assert.match(state.reason, /pinned/);
});

test('normalizeDb：老数据没有时限字段，补成 null', () => {
  const db = normalizeDb(validDb());
  assert.equal(db.notes[0].dueAt, null);
  assert.equal(db.notes[0].dueSetAt, null);
});

test('normalizeDb：设了时限的 dueAt / dueSetAt 要留住', () => {
  const raw = validDb();
  raw.notes[0].dueAt = 1_700_000_000_000;
  raw.notes[0].dueSetAt = 1_699_999_000_000;
  const db = normalizeDb(raw);
  assert.equal(db.notes[0].dueAt, 1_700_000_000_000);
  assert.equal(db.notes[0].dueSetAt, 1_699_999_000_000);
});

test('normalizeDb：老数据没有 image，补成 null', () => {
  const db = normalizeDb(validDb());
  assert.equal(db.notes[0].image, null);
});

test('normalizeDb：image 的文件名要留住（存的是名字不是路径）', () => {
  const raw = validDb();
  raw.notes[0].image = 'a1b2c3.png';
  const db = normalizeDb(raw);
  assert.equal(db.notes[0].image, 'a1b2c3.png');
});

test('normalizeDb：老数据没有 autoLaunch，补成默认的 false', () => {
  const db = normalizeDb(validDb());
  assert.equal(db.settings.autoLaunch, false);
});

test('normalizeDb：autoLaunch 显式为真要留住', () => {
  const raw = validDb();
  raw.settings.autoLaunch = true;
  const db = normalizeDb(raw);
  assert.equal(db.settings.autoLaunch, true);
});

test('normalizeDb：autoLaunch 是乱七八糟的值就退回默认', () => {
  const raw = validDb();
  raw.settings.autoLaunch = 'yes';
  const db = normalizeDb(raw);
  assert.equal(db.settings.autoLaunch, false);
});

test('normalizeDb：老数据没有 skin，补成空串（素纸）', () => {
  const db = normalizeDb(validDb());
  assert.equal(db.settings.skin, '');
});

test('normalizeDb：认得的皮肤留住', () => {
  const raw = validDb();
  raw.settings.skin = 'grid';
  const db = normalizeDb(raw);
  assert.equal(db.settings.skin, 'grid');
});

test('normalizeDb：手改 json 写成不存在的皮肤，退回素纸而不是崩', () => {
  const raw = validDb();
  raw.settings.skin = '不存在的皮肤';
  const db = normalizeDb(raw);
  assert.equal(db.settings.skin, '');
});


test('normalizeDb：非对象条目丢掉，缺 id 的条目补 id', () => {
  const db = normalizeDb({
    notes: [null, 'x', { text: '没有 id' }, { id: 'ok', text: '有 id' }],
    archive: [],
  });
  assert.equal(db.notes.length, 2);
  assert.ok(db.notes[0].id.length > 0);
  assert.equal(db.notes[1].id, 'ok');
  assert.equal(db.version, DB_VERSION);
});
