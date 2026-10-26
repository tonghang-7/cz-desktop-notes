/**
 * 免安装产物的完整性校验。
 *
 * v0.3.0 首次发布只上传了 CZNotes.exe，别人下载后缺 icudtl.dat 等 89 个文件，
 * 启动即崩（exit 3，报 icu_util.cc:232 Invalid file descriptor to ICU data received）。
 * 从那以后，发布前必须过这道检查：少一个文件就不许发。
 *
 * 单独成文件是因为 CI 和 tools/pack-zip.mjs 都要用，规则只能有一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 少了任何一个，压缩包发出去就是打不开的。 */
export const REQUIRED_FILES = [
  'CZNotes.exe',
  'icudtl.dat',
  'resources.pak',
  'v8_context_snapshot.bin',
  'version',
  'locales',
  'resources/app/package.json',
  'resources/app/dist/main/index.js',
  'resources/app/dist/preload/index.js',
  'resources/app/dist/renderer/notepad.js',
];

export function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countFiles(p);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(p).size;
    }
  }
  return { files, bytes };
}

/** @returns {{ok: boolean, missing: string[], files: number, bytes: number}} */
export function verifyDist(dir) {
  if (!fs.existsSync(dir)) {
    return { ok: false, missing: [`目录不存在：${dir}`], files: 0, bytes: 0 };
  }
  const missing = REQUIRED_FILES.filter((rel) => !fs.existsSync(path.join(dir, rel)));
  const stat = countFiles(dir);
  return { ok: missing.length === 0, missing, files: stat.files, bytes: stat.bytes };
}

// 直接执行时当脚本用：校验 release/CZNotes
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'release', 'CZNotes');
  const result = verifyDist(dir);
  if (!result.ok) {
    console.error('');
    console.error('产物校验失败：');
    for (const m of result.missing) console.error('  - ' + m);
    console.error('');
    console.error('先跑 npm run dist 再校验。');
    process.exit(1);
  }
  console.log(
    `产物校验通过：${result.files} 个文件 / ${(result.bytes / 1048576).toFixed(1)} MB，关键文件齐全`
  );
}
