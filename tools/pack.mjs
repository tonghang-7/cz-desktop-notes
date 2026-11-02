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

const releaseDir = path.join(root, 'release');

/**
 * 尽力删除，返回删不掉的条目 [{ path, code }]。
 *
 * 整棵 rmSync 失败时退化为逐条删 —— 一个被锁的文件不该连累同目录下的其它文件，
 * 而这正是之前空 catch 掩盖的事：release/ 只删掉一半，根目录的旧 zip / tar.gz 全留着。
 */
const removeBestEffort = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* 整棵删不掉，往下走逐条删 */
  }
  if (!fs.existsSync(target)) return [];

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    return [{ path: target, code: err.code || '?' }];
  }

  const failed = [];
  for (const entry of entries) {
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) failed.push(...removeBestEffort(p));
    else {
      try {
        fs.rmSync(p, { force: true });
      } catch (err) {
        failed.push({ path: p, code: err.code || '?' });
      }
    }
  }

  // 子项清空后再试一次删自己（目录得空删）
  try {
    fs.rmdirSync(target);
  } catch (err) {
    let empty = false;
    try {
      empty = fs.readdirSync(target).length === 0;
    } catch {
      /* 读不了就当非空，子项的错误已经报过了 */
    }
    if (empty) failed.push({ path: target, code: err.code || '?' });
  }
  return failed;
};

const leftovers = removeBestEffort(releaseDir);
if (leftovers.length) {
  console.warn('');
  console.warn('[pack] release/ 没清干净，下面这些删不掉：');
  for (const item of leftovers) {
    console.warn(`  - ${path.relative(root, item.path)}  (${item.code})`);
  }
  console.warn('[pack] 通常是 CZNotes 还在运行（exe 被锁），或者杀软正在扫这个目录。');
  console.warn('[pack] cpSync 只覆盖不删除，所以下面会再查一遍产物里有没有孤儿文件。');
  console.warn('');
}
fs.mkdirSync(out, { recursive: true });

// 开发时跑过 node_modules/electron/dist/electron.exe，Chromium 会在它旁边留下
// debug.log。不过滤的话每次打包都会把这份日志拷进产物 —— 之前那个「debug.log
// 跟着整个目录走」的来源就是它。
const isRuntimeJunk = (p) => /^(debug|chrome_debug)\.log$/i.test(path.basename(p));

// 目标目录里的文件被占用时（最常见的是 CZNotes.exe 还开着），cpSync 抛的是原始
// Node 错误，看不懂。这里换成能照着做的提示。
try {
  fs.cpSync(src, out, { recursive: true, filter: (s) => !isRuntimeJunk(s) });
} catch (err) {
  // 单个文件被锁会让整次拷贝失败。最常见的是 default_app.asar：它是 Electron 自带的
  // 默认应用包，我们跑的是 resources/app，一份都用不到 —— 杀软扫描或上一个进程留下的
  // 僵尸句柄锁住它时，跳过它重试一次，别为了 1MB 卡住整次发版。
  const lockedAsar = path.join(out, 'resources', 'default_app.asar');
  if (fs.existsSync(lockedAsar)) {
    console.warn('[pack] default_app.asar 被占用，跳过它继续');
    fs.cpSync(src, out, {
      recursive: true,
      filter: (s) => !s.endsWith('default_app.asar') && !isRuntimeJunk(s),
    });
  } else {
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
try {
  if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar);
} catch {
  /* 被锁就留着：多 1MB，运行时不会用到它 */
}

// 收尾自检：产物里出现「既不是 electron 运行时、也不是我们写进去的」文件，说明
// release/CZNotes 上次没删干净，旧版本的文件混进来了（debug.log、已删掉的模块……）。
// cpSync 只覆盖不删除，这种残留会一路进 zip 发出去，包和源码就对不上了。
const norm = (p) => p.split(path.sep).join('/');
const listFiles = (dir, base = dir, acc = new Set()) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(p, base, acc);
    else acc.add(norm(path.relative(base, p)));
  }
  return acc;
};

const expected = listFiles(src);
expected.delete('electron.exe');
expected.add('CZNotes.exe');
// resources/default_app.asar 不算孤儿：正常情况下上面已经删掉，被锁住时会故意留着
for (const rel of listFiles(appDir)) expected.add(norm(path.relative(out, path.join(appDir, rel))));

const stray = [...listFiles(out)].filter((rel) => !expected.has(rel));
if (stray.length) {
  console.error('');
  console.error('打包自检失败：release/CZNotes 里有 ' + stray.length + ' 个不属于本次构建的文件');
  for (const rel of stray) console.error('  - ' + rel);
  console.error('');
  console.error('这些是上一版遗留的（上次清理没成功），被打进包就会发出去。');
  console.error('托盘退出 CZNotes 后重新执行 npm run dist，或者手动删掉它们再重跑。');
  process.exit(1);
}

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
