import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'node_modules', 'electron', 'dist');
const out = path.join(root, 'release', 'CZNotes');

if (!fs.existsSync(src)) {
  console.error('electron dist not found:', src);
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'dist', 'main', 'index.js'))) {
  console.error('build output missing, run "npm run build" first');
  process.exit(1);
}

try {
  fs.rmSync(path.join(root, 'release'), { recursive: true, force: true });
} catch {
  /* 删除失败就退化为直接覆盖，不让打包卡在清理这一步 */
}
fs.mkdirSync(out, { recursive: true });

// 目标目录里的文件被占用时（最常见的是 CZNotes.exe 还开着），cpSync 抛的是原始
// Node 错误，看不懂。这里换成能照着做的提示。
try {
  fs.cpSync(src, out, { recursive: true });
} catch (err) {
  console.error('');
  console.error('打包失败：无法写入 ' + out);
  console.error('原因：' + (err && err.message ? err.message : err));
  if (fs.existsSync(path.join(out, 'CZNotes.exe'))) {
    console.error('');
    console.error('上一版的 CZNotes.exe 可能还在运行，文件被占用。');
    console.error('先退出它（托盘图标右键 → 退出），再重新执行 npm run dist。');
  }
  process.exit(1);
}

const exeOld = path.join(out, 'electron.exe');
const exeNew = path.join(out, 'CZNotes.exe');
if (fs.existsSync(exeOld)) fs.renameSync(exeOld, exeNew);

const appDir = path.join(out, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main,
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(runtimePkg, null, 2));

const defaultAsar = path.join(out, 'resources', 'default_app.asar');
if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar);

const walk = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += walk(p);
    else total += fs.statSync(p).size;
  }
  return total;
};

const bytes = walk(out);
console.log(`packed -> release/CZNotes/CZNotes.exe`);
console.log(`size: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`launch: ${exeNew}`);
