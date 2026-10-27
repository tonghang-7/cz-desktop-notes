/**
 * 打「热更新增量包」：只装 resources/app（几百 KB），不含 exe 和 Chromium 运行时。
 *
 * 为什么用 tar.gz 而不是 zip：客户端解包必须零依赖（项目 dependencies 是空的），
 * Node 内置 zlib 能解 gzip，tar 的头就是 512 字节定长结构，几十行就能读完；
 * zip 要处理 central directory、deflate 流、zip64，代价大得多。
 *
 * 包内结构（相对 resources/app）：
 *   update.json          {version, electronVersion, builtAt} —— 客户端靠它判断能不能装
 *   dist/**              代码
 *   assets/**            图标
 *
 * 用法：node tools/pack-app.mjs [--out xxx.tar.gz]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'release', 'CZNotes', 'resources', 'app');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPkg = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
);

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const outFile = path.resolve(
  root,
  outArg >= 0 && argv[outArg + 1] ? argv[outArg + 1] : path.join('release', `app-${pkg.version}.tar.gz`)
);

function fail(msg) {
  console.error('');
  console.error('增量包打包失败：' + msg);
  process.exit(1);
}

if (!fs.existsSync(srcDir)) fail('没有 release/CZNotes/resources/app，先跑 npm run dist');
for (const must of ['dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/notepad.js']) {
  if (!fs.existsSync(path.join(srcDir, must))) fail(`缺 ${must}，产物不完整`);
}

/** 收集文件，名字统一成 posix 相对路径（tar 只认这个） */
function walk(dir, prefix, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const name = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, name, out);
    else if (ent.isFile()) out.push({ name, data: fs.readFileSync(abs) });
  }
}

const files = [];
walk(srcDir, '', files);

// 客户端靠这个判断「这包能不能装在我的运行时上」
files.unshift({
  name: 'update.json',
  data: Buffer.from(
    JSON.stringify(
      { version: pkg.version, electronVersion: electronPkg.version, builtAt: new Date().toISOString() },
      null,
      2
    )
  ),
});

/** tar 的一个文件头（ustar 格式，512 字节定长） */
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8); // mode
  h.write('0000000\0', 108, 8); // uid
  h.write('0000000\0', 116, 8); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  h.write('        ', 148, 8); // 校验和位置先填空格
  h.write('0', 156, 1); // typeflag：普通文件
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

const now = Date.now();
const chunks = [];
for (const f of files) {
  if (f.name.length > 100) fail(`路径超过 100 字符，需要 prefix 字段：${f.name}`);
  chunks.push(tarHeader(f.name, f.data.length, now), f.data);
  const pad = (512 - (f.data.length % 512)) % 512;
  if (pad) chunks.push(Buffer.alloc(pad));
}
chunks.push(Buffer.alloc(1024)); // tar 结束：两个全零块

const tar = Buffer.concat(chunks);
const gz = zlib.gzipSync(tar, { level: 9 });

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, gz);

const sha = createHash('sha256').update(gz).digest('hex');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`[pack-app] ${files.length} 个文件，tar ${kb(tar.length)} → gz ${kb(gz.length)}`);
console.log(`[pack-app] 版本 ${pkg.version} · Electron ${electronPkg.version}`);
console.log('');
console.log(`产物：${outFile}`);
console.log(`大小：${gz.length} 字节（${kb(gz.length)}）`);
console.log(`sha256：${sha}`);
