/**
 * 把免安装版目录打成可分发的 zip。
 *
 * 为什么单独一个脚本：v0.3.0 首次发布时只上传了 CZNotes.exe，别的文件没跟过去，
 * 用户下载后直接崩溃（缺 icudtl.dat，exit 3）。从那以后，发布物必须满足两条：
 *   1. 打包前做前置校验，缺关键文件就地报错，不让半成品溜到发布步骤；
 *   2. zip 顶层是 CZNotes 文件夹，解压后双击里面的 exe 就能跑。
 *
 * 用法：
 *   node tools/pack-zip.mjs              # 默认输出 release/CZNotes-win64.zip
 *   node tools/pack-zip.mjs --out x.zip
 *   node tools/pack-zip.mjs --no-verify  # 跳过解压复现测试
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countFiles, verifyDist } from './verify-dist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'release', 'CZNotes');

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const outFile = path.resolve(
  root,
  outArg >= 0 && argv[outArg + 1] ? argv[outArg + 1] : path.join('release', 'CZNotes-win64.zip')
);
const verify = !argv.includes('--no-verify');

function fail(msg) {
  console.error('');
  console.error('打包失败：' + msg);
  process.exit(1);
}

function find7z() {
  const candidates = [
    'C:/Program Files/7-Zip/7z.exe',
    'C:/Program Files (x86)/7-Zip/7z.exe',
    '7z',
    '7za',
    '7zz',
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ['i'], { stdio: 'ignore', shell: false });
    if (r.status === 0 || r.status === 1) return c;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) fail(`${cmd} 退出码 ${r.status}`);
}

function sha256(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

// 1. 前置校验
if (!fs.existsSync(srcDir)) fail('没有 release/CZNotes/，先跑 npm run dist');
const check = verifyDist(srcDir);
if (!check.ok) {
  fail('产物缺这些文件，不能发布：\n  - ' + check.missing.join('\n  - '));
}
const stat = { files: check.files, bytes: check.bytes };
console.log(`[pack-zip] 源目录 ${stat.files} 个文件 / ${(stat.bytes / 1048576).toFixed(1)} MB`);

// 2. 压缩（依次回退）
fs.mkdirSync(path.dirname(outFile), { recursive: true });
if (fs.existsSync(outFile)) fs.rmSync(outFile);

const sevenZip = find7z();
if (sevenZip) {
  console.log('[pack-zip] 用 7-Zip 压缩');
  run(sevenZip, ['a', '-tzip', '-mx=7', '-mmt=on', outFile, './CZNotes/'], {
    cwd: path.dirname(srcDir),
  });
} else if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0) {
  console.log('[pack-zip] 用 zip 压缩');
  run('zip', ['-r', '-9', outFile, 'CZNotes'], { cwd: path.dirname(srcDir) });
} else if (process.platform === 'win32') {
  console.log('[pack-zip] 回退到 PowerShell Compress-Archive');
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${srcDir}' -DestinationPath '${outFile}' -Force`,
  ]);
} else {
  fail('这台机器上既没有 7-Zip 也没有 zip，装一个再打包');
}

// 3. 复现测试：解压到干净目录，检查文件数与关键文件
if (verify && sevenZip) {
  const tmp = path.join(root, 'release', '.verify-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  run(sevenZip, ['x', `-o${tmp}`, outFile, '-y'], { stdio: 'ignore' });
  const extracted = path.join(tmp, 'CZNotes');
  if (!fs.existsSync(extracted)) fail('解压后没有 CZNotes 目录');
  const after = countFiles(extracted);
  const afterCheck = verifyDist(extracted);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!afterCheck.ok) fail('解压后仍缺：' + afterCheck.missing.join(', '));
  if (after.files !== stat.files) {
    fail(`解压后文件数对不上：源 ${stat.files}，解压 ${after.files}`);
  }
  console.log(`[pack-zip] 解压复现测试通过（${after.files} 个文件，缺一即失败）`);
} else if (verify) {
  console.log('[pack-zip] 跳过解压复现测试（没有 7-Zip 可用）');
}

// 4. 输出
const size = fs.statSync(outFile).size;
console.log('');
console.log(`产物：${outFile}`);
console.log(`大小：${size} 字节（${(size / 1048576).toFixed(1)} MB）`);
console.log(`sha256：${sha256(outFile)}`);
console.log('');
console.log('发布时别忘了：正文里写上这个 sha256，用户下完能核对。');
