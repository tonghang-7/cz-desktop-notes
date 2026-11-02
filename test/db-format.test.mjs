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

/** 现役结构：一个队列一叠便签，便签带标题和图片比例。 */
const validDb = () => ({
  version: DB_VERSION,
  settings: { hotkey: 'Control+Alt+Space' },
  queues: [
    {
      id: 'q1',
      name: '默认',
      windowX: 1,
      windowY: 2,
      cardWidth: 320,
      cardHeight: 250,
      notes: [
        {
          id: 'a',
          title: '',
          text: '第一条',
          color: 'amber',
          createdAt: 100,
          doneAt: null,
          imageRatio: 0.58,
        },
        {
          id: 'b',
          title: '第二条的标题',
          text: '第二条',
          color: 'rose',
          createdAt: 200,
          doneAt: 300,
          imageRatio: 0.4,
        },
      ],
      archive: [],
    },
  ],
});

/** v2 的老结构：多队列已经有了，但便签没有标题、图片比例写死。 */
const legacyV2 = () => ({
  version: 2,
  settings: { hotkey: 'Control+Alt+Space' },
  queues: [
    {
      id: 'q1',
      name: '工作',
      windowX: 10,
      windowY: 20,
      cardWidth: 400,
      cardHeight: 300,
      notes: [
        { id: 'a', text: '没有标题的第一条', color: 'amber', createdAt: 100, doneAt: null },
        { id: 'b', text: '第二条', color: 'rose', createdAt: 200, doneAt: 300, image: 'x.png' },
      ],
      archive: [{ id: 'c', text: '已经摘掉的一条', color: 'sky', createdAt: 50, doneAt: 60 }],
    },
  ],
});

/** v1 的老结构：单叠，窗口状态在 settings 里。 */
const legacyV1 = () => ({
  version: 1,
  settings: { hotkey: 'Control+Alt+Space', cardWidth: 320, cardHeight: 250, windowX: 1, windowY: 2 },
  notes: [
    { id: 'a', text: '第一条', color: 'amber', createdAt: 100, doneAt: null },
    { id: 'b', text: '第二条', color: 'rose', createdAt: 200, doneAt: 300 },
  ],
  archive: [],
});

test('正常现役数据：loaded，笔记一条不少', () => {
  const { state, db } = parseDb(JSON.stringify(validDb()));
  assert.equal(state.kind, 'loaded');
  assert.equal(db.queues.length, 1);
  assert.equal(db.queues[0].notes.length, 2);
  assert.equal(db.queues[0].notes[0].text, '第一条');
  assert.equal(db.queues[0].notes[1].doneAt, 300);
  assert.equal(db.settings.hotkey, 'Control+Alt+Space');
  assert.equal(db.version, DB_VERSION);
});

test('v2 迁移到 v3：待办补上空标题和被写死的 0.58 图片比例', () => {
  const { state, db } = parseDb(JSON.stringify(legacyV2()));
  assert.equal(state.kind, 'migrated');
  assert.equal(state.from, 2);
  assert.equal(db.version, DB_VERSION);

  for (const n of db.queues[0].notes) {
    assert.equal(n.title, '', '老便签没有标题，补空串而不是 undefined');
    assert.equal(
      n.imageRatio,
      0.58,
      '0.58 是 .card__img 原来写死的高度，画面必须和以前一致'
    );
  }
  // 原有的内容一个都不能动
  assert.equal(db.queues[0].notes[0].text, '没有标题的第一条');
  assert.equal(db.queues[0].notes[1].image, 'x.png');
  assert.equal(db.queues[0].windowX, 10);
});

test('归档里的便签也补上新字段，不只补待办', () => {
  const { db } = parseDb(JSON.stringify(legacyV2()));
  assert.equal(db.queues[0].archive.length, 1);
  assert.equal(db.queues[0].archive[0].title, '');
  assert.equal(db.queues[0].archive[0].imageRatio, 0.58);
  assert.equal(db.queues[0].archive[0].text, '已经摘掉的一条');
});

test('v1 一路迁到 v3：中间那步不会漏字段', () => {
  const { state, db } = parseDb(JSON.stringify(legacyV1()));
  assert.equal(state.kind, 'migrated');
  assert.equal(state.from, 1);
  assert.equal(db.version, DB_VERSION);
  assert.equal(db.queues[0].notes.length, 2);
  for (const n of db.queues[0].notes) {
    assert.equal(n.title, '');
    assert.equal(n.imageRatio, 0.58);
  }
});

test('imageRatio 越界或不是数字：收回默认值，不让坏值落盘', () => {
  const raw = validDb();
  raw.queues[0].notes[0].imageRatio = 9;
  raw.queues[0].notes[1].imageRatio = 'garbage';
  const { db } = parseDb(JSON.stringify(raw));
  assert.equal(db.queues[0].notes[0].imageRatio, 0.8, '上限 0.8');
  assert.equal(db.queues[0].notes[1].imageRatio, 0.58, '非数字退默认');

  raw.queues[0].notes[0].imageRatio = -3;
  assert.equal(parseDb(JSON.stringify(raw)).db.queues[0].notes[0].imageRatio, 0.2, '下限 0.2');
});

test('已经是 v3 的数据带标题：原样保留，不被默认值盖掉', () => {
  const { db } = parseDb(JSON.stringify(validDb()));
  assert.equal(db.queues[0].notes[1].title, '第二条的标题');
  assert.equal(db.queues[0].notes[1].imageRatio, 0.4);
});

test('v1 老数据迁移成一个队列，笔记和窗口位置都跟着搬过去', () => {
  const { state, db } = parseDb(JSON.stringify(legacyV1()));
  assert.equal(state.kind, 'migrated');
  assert.equal(db.queues.length, 1);
  assert.equal(db.queues[0].name, '默认');
  assert.equal(db.queues[0].notes.length, 2);
  assert.equal(db.queues[0].notes[1].text, '第二条');
  // 窗口位置和尺寸原本在 settings 里，现在归队列
  assert.equal(db.queues[0].windowX, 1);
  assert.equal(db.queues[0].windowY, 2);
  assert.equal(db.queues[0].cardWidth, 320);
  assert.equal(db.queues[0].cardHeight, 250);
  assert.equal(db.version, DB_VERSION);
});

test('迁移后 settings 里不再留窗口字段（否则两个窗口会互相踩）', () => {
  const { db } = parseDb(JSON.stringify(legacyV1()));
  const s = db.settings;
  assert.equal('windowX' in s, false);
  assert.equal('windowY' in s, false);
  assert.equal('cardWidth' in s, false);
  assert.equal('cardHeight' in s, false);
});

test('缺 version 的老文件按 v1 处理，不当成损坏', () => {
  const raw = legacyV1();
  delete raw.version;
  const { state, db } = parseDb(JSON.stringify(raw));
  assert.equal(state.kind, 'migrated');
  assert.equal(db.queues[0].notes.length, 2);
});

test('版本高于当前：future，绝不当成损坏', () => {
  const raw = { ...validDb(), version: DB_VERSION + 1 };
  const { state, db } = parseDb(JSON.stringify(raw));
  assert.equal(state.kind, 'future');
  assert.equal(state.version, DB_VERSION + 1);
  assert.equal(db.queues[0].notes.length, 0);
});

test('JSON 坏了：corrupt，且不返回任何原内容', () => {
  const { state, db } = parseDb('{ "notes": [');
  assert.equal(state.kind, 'corrupt');
  assert.ok(state.reason.length > 0);
  assert.equal(db.queues[0].notes.length, 0);
  assert.equal(db.queues[0].archive.length, 0);
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
  const migrations = {
    1: (db) => {
      const out = {
        ...db,
        queues: [
          {
            id: 'q1',
            name: '默认',
            notes: (db.notes ?? []).map((n) => ({ ...n, color: 'sky' })),
            archive: [],
            cardWidth: 320,
            cardHeight: 250,
            windowX: null,
            windowY: null,
          },
        ],
      };
      delete out.notes;
      delete out.archive;
      return out;
    },
  };
  const { state, db } = parseDb(JSON.stringify(legacyV1()), 2, migrations);
  assert.equal(state.kind, 'migrated');
  assert.equal(state.from, 1);
  assert.equal(state.to, 2);
  assert.equal(db.queues[0].notes.length, 2);
  assert.equal(db.queues[0].notes[0].color, 'sky');
});

test('迁移新增了没人接的字段：直接报错，不静默丢字段', () => {
  const migrations = {
    1: (db) => {
      const out = {
        ...db,
        queues: [
          {
            id: 'q1',
            name: '默认',
            notes: db.notes ?? [],
            archive: [],
            cardWidth: 320,
            cardHeight: 250,
            windowX: null,
            windowY: null,
          },
        ],
        pinned: false,
      };
      delete out.notes;
      delete out.archive;
      return out;
    },
  };
  const { state } = parseDb(JSON.stringify(legacyV1()), 2, migrations);
  assert.equal(state.kind, 'corrupt');
  assert.match(state.reason, /pinned/);
});

test('normalizeDb：老数据没有时限字段，补成 null', () => {
  const db = normalizeDb(validDb());
  assert.equal(db.queues[0].notes[0].dueAt, null);
  assert.equal(db.queues[0].notes[0].dueSetAt, null);
});

test('normalizeDb：设了时限的 dueAt / dueSetAt 要留住', () => {
  const raw = validDb();
  raw.queues[0].notes[0].dueAt = 1_700_000_000_000;
  raw.queues[0].notes[0].dueSetAt = 1_699_999_000_000;
  const db = normalizeDb(raw);
  assert.equal(db.queues[0].notes[0].dueAt, 1_700_000_000_000);
  assert.equal(db.queues[0].notes[0].dueSetAt, 1_699_999_000_000);
});

test('normalizeDb：老数据没有 image，补成 null', () => {
  const db = normalizeDb(validDb());
  assert.equal(db.queues[0].notes[0].image, null);
});

test('normalizeDb：image 的文件名要留住（存的是名字不是路径）', () => {
  const raw = validDb();
  raw.queues[0].notes[0].image = 'a1b2c3.png';
  const db = normalizeDb(raw);
  assert.equal(db.queues[0].notes[0].image, 'a1b2c3.png');
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


test('normalizeDb：一个队列都没有就补一个，否则程序没有窗口可开', () => {
  const db = normalizeDb({ settings: {}, queues: [] });
  assert.equal(db.queues.length, 1);
  assert.equal(db.queues[0].name, '默认');
  assert.ok(db.queues[0].id.length > 0);
});

test('normalizeDb：非对象条目丢掉，缺 id 的条目补 id', () => {
  const db = normalizeDb({
    queues: [
      {
        id: 'q1',
        name: '默认',
        notes: [null, 'x', { text: '没有 id' }, { id: 'ok', text: '有 id' }],
        archive: [],
      },
    ],
  });
  const notes = db.queues[0].notes;
  assert.equal(notes.length, 2);
  assert.ok(notes[0].id.length > 0);
  assert.equal(notes[1].id, 'ok');
  assert.equal(db.version, DB_VERSION);
});
