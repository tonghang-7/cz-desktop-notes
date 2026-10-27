/**
 * 热更新里的纯逻辑：版本比较、解 tar.gz。
 *
 * 单独抽出来是为了**能测**。这两块都属于「写错了不会立刻报错，但会在用户机器上出事」：
 *   - 版本比较写错 → 要么一直提示有新版（每次启动更新一遍），要么该更新时不更新
 *   - 解包路径检查写错 → 等于给了压缩包一个任意写文件的口子
 *
 * 它们不依赖 Electron，所以能脱离主进程直接跑单测（见 test/update-format.test.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** a 是否比 b 新。只认 x.y.z 数字，缺的段按 0 补（"0.5" 等同 "0.5.0"）。 */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** tar 头里字段是「八进制数字 + NUL」的定长串，读的时候要把尾巴上的空字节切掉。 */
function readStr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

/**
 * 把 tar.gz 解到 outDir，返回写出的文件数。
 *
 * 只处理普通文件（跳过目录、软链等）；每个目标路径都会 resolve 后校验是否还在 outDir 里，
 * 挡掉 `../` 和绝对路径 —— 压缩包是网络来的，这一层不能省。
 */
export function extractTarGz(gz: Buffer, outDir: string): number {
  const tar = zlib.gunzipSync(gz);
  const base = path.resolve(outDir);
  let off = 0;
  let count = 0;

  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 两个全零块 = 归档结束

    const name = readStr(header, 0, 100);
    const size = parseInt(readStr(header, 124, 12).trim() || '0', 8) || 0;
    const typeflag = String.fromCharCode(header[156]);

    off += 512;
    if (typeflag === '0' || typeflag === '\0') {
      const target = path.resolve(base, name);
      // 必须严格落在 base 里面：target === base 也不行（那是目录本身）
      if (target === base || !target.startsWith(base + path.sep)) {
        throw new Error(`包里有非法路径：${name}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, tar.subarray(off, off + size));
      count++;
    }
    off += Math.ceil(size / 512) * 512;
  }

  return count;
}
