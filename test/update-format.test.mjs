/**
 * 热更新纯逻辑的测试：版本比较 + 解包。
 * 跑法：npm test（会先 build，产出 dist/main/update-format.js）
 *
 * 这些用例守两件事：
 *   1. 版本比较不能错 —— 错了要么一直提示有新版（每次启动更新一遍），要么该更新时不更新
 *   2. 解包必须挡住 ../ 和绝对路径 —— 压缩包是网络来的，这一层是唯一的闸
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { isNewer, extractTarGz } = require('../dist/main/update-format.js');

/** 造一个最小 tar.gz（只写普通文件），喂给 extractTarGz */
function makeTarGz(files) {
  const chunks = [];
  for (const f of files) {
    const h = Buffer.alloc(512);
    h.write(f.name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 8);
    h.write('0000000\0', 108, 8);
    h.write('0000000\0', 116, 8);
    h.write(f.data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    h.write('0'.repeat(11) + '\0', 136, 12);
    h.write('        ', 148, 8); // 校验和先填空格
    h.write('0', 156, 1);
    h.write('ustar\0', 257, 6);
    h.write('00', 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(h, f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // 归档结束
  return zlib.gzipSync(Buffer.concat(chunks));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cznote-upd-'));

test('isNewer：补丁号', () => {
  assert.equal(isNewer('0.5.1', '0.5.0'), true);
  assert.equal(isNewer('0.5.0', '0.5.1'), false);
});

test('isNewer：相同版本不算新', () => {
  assert.equal(isNewer('0.5.1', '0.5.1'), false);
});

test('isNewer：两位数要按数字比，不能按字符串', () => {
  // 按字符串比会得出 "0.5.10" < "0.5.9"，这里就是那种错的关键用例
  assert.equal(isNewer('0.5.10', '0.5.9'), true);
  assert.equal(isNewer('0.5.9', '0.5.10'), false);
});

test('isNewer：主版本和次版本', () => {
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.6.0', '0.5.9'), true);
});

test('isNewer：缺的段按 0 补', () => {
  assert.equal(isNewer('0.5', '0.5.0'), false);
  assert.equal(isNewer('0.5.1', '0.5'), true);
  assert.equal(isNewer('0.6', '0.5.9'), true);
});

test('extractTarGz：正常解出文件与内容', () => {
  const dir = tmp();
  const n = extractTarGz(
    makeTarGz([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'sub/b.txt', data: Buffer.from('world') },
    ]),
    dir
  );
  assert.equal(n, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'b.txt'), 'utf8'), 'world');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractTarGz：挡住 ../ 穿越', () => {
  const dir = tmp();
  assert.throws(
    () => extractTarGz(makeTarGz([{ name: '../evil.txt', data: Buffer.from('x') }]), dir),
    /非法路径/
  );
  // 关键：不能真的写到外面去
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.txt')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractTarGz：挡住藏在子目录里的穿越', () => {
  const dir = tmp();
  assert.throws(
    () => extractTarGz(makeTarGz([{ name: 'sub/../../evil.txt', data: Buffer.from('x') }]), dir),
    /非法路径/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractTarGz：挡住绝对路径', () => {
  const dir = tmp();
  assert.throws(
    () => extractTarGz(makeTarGz([{ name: '/abs-evil.txt', data: Buffer.from('x') }]), dir),
    /非法路径/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractTarGz：空包解出 0 个文件', () => {
  const dir = tmp();
  assert.equal(extractTarGz(makeTarGz([]), dir), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
