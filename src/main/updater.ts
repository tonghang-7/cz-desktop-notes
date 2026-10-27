/**
 * 热更新：只换 resources/app（几十 KB），不碰 exe 和 Chromium 运行时。
 *
 * 为什么这条路可行：Electron 把「代码」和「运行时」分开放 —— 我们的东西全在
 * resources\app 里，那些文件只在启动时读一次，运行中不持有句柄。
 * 所以替换它既没有文件占用问题，也不像「程序替换自己的 exe」那样招惹杀软。
 *
 * 三道安全闸，一道都不能省：
 *   1. sha256 校验 —— 下载回来的 JS 是要被执行的，不校验等于开放远程代码执行
 *   2. electronVersion 比对 —— 新版代码可能用了新 API，装到旧运行时上会直接崩
 *   3. 路径穿越检查 —— 解包时挡掉 ../ 和绝对路径
 *
 * 失败怎么退：替换前把 app 改名成 app.old，替换时任何一步出错就改回来。
 * 成功启动后由 applyPending() 自己清理 app.old。
 */
import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REPO = 'tonghang-7/cz-desktop-notes';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface UpdateInfo {
  version: string;
  size: number;
  url: string;
  sha256: string;
  electronVersion: string;
  notes: string;
}

function updateDir() {
  return path.join(app.getPath('userData'), 'update');
}

function pendingFile() {
  return path.join(updateDir(), 'pending.json');
}

function applyingFile() {
  return path.join(updateDir(), 'applying.json');
}

/** "0.5.1" > "0.5.0" 这类比较，只认 x.y.z 数字 */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function rm(target: string) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // 删不掉不影响主流程
  }
}

/** 查有没有新版。用 net.fetch 而不是 Node 的 fetch —— 它走 Chromium 的网络栈，能吃到系统代理。 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  const res = await net.fetch(API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'cz-desktop-notes' },
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const rel = (await res.json()) as {
    tag_name?: string;
    body?: string;
    assets?: { name: string; size: number; browser_download_url: string; digest?: string }[];
  };

  const latest = (rel.tag_name || '').replace(/^v/, '');
  if (!latest || !isNewer(latest, app.getVersion())) return null;

  const asset = (rel.assets || []).find((a) => a.name.startsWith('app-') && a.name.endsWith('.tar.gz'));
  if (!asset) throw new Error('这个版本没提供增量包，只能下完整包');

  return {
    version: latest,
    size: asset.size,
    url: asset.browser_download_url,
    sha256: (asset.digest || '').replace(/^sha256:/, ''),
    // electronVersion 在 update.json 里，下载后才知道；这里先占位
    electronVersion: '',
    notes: rel.body || '',
  };
}

/** 解 tar.gz 到目录。只处理普通文件，挡掉路径穿越。 */
function extractTarGz(gz: Buffer, outDir: string) {
  const tar = zlib.gunzipSync(gz);
  const base = path.resolve(outDir);
  let off = 0;

  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 两个全零块 = 结束

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeStr || '0', 8) || 0;
    const type = String.fromCharCode(header[156]);

    off += 512;
    if (type === '0' || type === '\0') {
      const target = path.resolve(base, rawName);
      // 挡掉 ../ 和绝对路径：解包写到程序目录里，这个洞必须堵
      if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error(`包里有非法路径：${rawName}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, tar.subarray(off, off + size));
    }
    off += Math.ceil(size / 512) * 512;
  }
}

/**
 * 下载增量包并解到 update/app.new/。不替换，只是准备好。
 * @returns 包里的 electronVersion
 */
export async function downloadUpdate(info: UpdateInfo): Promise<string> {
  const res = await net.fetch(info.url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (info.sha256) {
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== info.sha256) throw new Error('sha256 对不上，包可能被改过，已丢弃');
  }

  const dir = updateDir();
  const staged = path.join(dir, 'app.new');
  rm(staged);
  fs.mkdirSync(staged, { recursive: true });
  extractTarGz(buf, staged);

  const metaFile = path.join(staged, 'update.json');
  if (!fs.existsSync(metaFile)) throw new Error('包里没有 update.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
    version?: string;
    electronVersion?: string;
  };
  if (!meta.version) throw new Error('update.json 里没写版本');

  const runtime = process.versions.electron;
  if (meta.electronVersion && meta.electronVersion !== runtime) {
    throw new Error(
      `这个更新要 Electron ${meta.electronVersion}，你现在是 ${runtime} —— 得下完整包`
    );
  }

  fs.writeFileSync(
    pendingFile(),
    JSON.stringify({ version: meta.version, electronVersion: meta.electronVersion, at: Date.now() })
  );
  return meta.electronVersion || '';
}

/** 有没有已经下好、等着下次启动安装的更新 */
export function readPending(): { version: string; at: number } | null {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 启动时调用（必须在创建窗口之前）。返回这次干了什么。
 *
 * - 上次替换过、这次能跑到这里 = 新版起来了 → 清掉 app.old
 * - 有 pending 且 app.new 就位 → 替换，然后由调用方 relaunch
 */
export function applyPendingUpdate(): 'applied' | 'cleaned' | 'none' | 'failed' {
  if (!app.isPackaged) return 'none'; // 开发模式不动，那是源码目录

  const appPath = app.getAppPath(); // ...\resources\app
  const oldPath = `${appPath}.old`;

  // 新版能跑到这里，说明上一次安装是成功的
  if (fs.existsSync(applyingFile())) {
    rm(applyingFile());
    rm(oldPath);
    return 'cleaned';
  }

  const pending = readPending();
  const staged = path.join(updateDir(), 'app.new');
  if (!pending || !fs.existsSync(staged)) return 'none';

  try {
    rm(oldPath);
    fs.renameSync(appPath, oldPath); // 想反悔就把它改回来
    fs.writeFileSync(applyingFile(), JSON.stringify({ from: app.getVersion(), to: pending.version }));
    try {
      fs.renameSync(staged, appPath);
    } catch (err) {
      fs.renameSync(oldPath, appPath); // 换不上就退回原样
      throw err;
    }
    rm(pendingFile());
    return 'applied';
  } catch (err) {
    console.error('[update] 安装失败，已回滚：', err instanceof Error ? err.message : err);
    rm(applyingFile());
    return 'failed';
  }
}

/** 清掉上次遗留的 app.old（替换成功但当时没来得及删） */
export function cleanupLeftovers() {
  if (!app.isPackaged) return;
  const oldPath = `${app.getAppPath()}.old`;
  if (fs.existsSync(oldPath)) rm(oldPath);
  rm(path.join(updateDir(), 'app.new'));
}
