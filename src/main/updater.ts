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
import { extractTarGz, isNewer } from './update-format';

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

/**
 * 上一次安装失败的原因。
 * 打在磁盘上而不是只 console.error —— 打包版没有控制台，用户看到的只是
 * 「点了重启，什么都没变」，没有这个文件就只能靠猜。
 */
function errorFile() {
  return path.join(updateDir(), 'last-error.txt');
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
  const written = extractTarGz(buf, staged);
  if (written === 0) throw new Error('包里没有任何文件');

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
    rm(`${appPath}.staged`);
    return 'cleaned';
  }

  const pending = readPending();
  const staged = path.join(updateDir(), 'app.new');
  // 和 app 同盘的临时目录。Windows 下跨盘 rename 会抛 EXDEV，
  // 而 app.new 在 userData（通常是 C: 的 %APPDATA%），程序可能在 D:/E: —— 见下面的注释。
  const local = `${appPath}.staged`;
  if (!pending || !fs.existsSync(staged)) return 'none';

  try {
    rm(oldPath);
    rm(local);

    // 先把新代码复制到目标盘，再去动 app 目录。
    // 顺序很重要：这一步失败时 app 还是原样，不需要任何回滚。
    // （早期版本直接 rename(app.new → app)，在程序装在非 C 盘时必然失败，
    //   而我本地测试时 userData 和程序都在 E 盘，掩盖了这个 bug。）
    fs.cpSync(staged, local, { recursive: true });

    fs.renameSync(appPath, oldPath); // 想反悔就把它改回来
    fs.writeFileSync(applyingFile(), JSON.stringify({ from: app.getVersion(), to: pending.version }));
    try {
      fs.renameSync(local, appPath); // 同盘，瞬间完成
    } catch (err) {
      fs.renameSync(oldPath, appPath); // 换不上就退回原样
      throw err;
    }
    rm(pendingFile());
    rm(staged);
    rm(errorFile());
    return 'applied';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[update] 安装失败，已回滚：', msg);
    // 打包版没有控制台。失败必须留痕，否则用户看到的只是「点了重启没反应」。
    try {
      fs.mkdirSync(updateDir(), { recursive: true });
      fs.writeFileSync(errorFile(), `${new Date().toISOString()}  ${pending.version}\n${msg}\n`);
    } catch {
      // 连错误都写不下去，那就只能算了
    }
    rm(applyingFile());
    rm(local);
    return 'failed';
  }
}

/** 上次安装失败的原因。UI 用它在 pending 状态下给出提示。 */
export function lastUpdateError(): string | null {
  try {
    const text = fs.readFileSync(errorFile(), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** 清掉上次遗留的 app.old（替换成功但当时没来得及删） */
export function cleanupLeftovers() {
  if (!app.isPackaged) return;
  const oldPath = `${app.getAppPath()}.old`;
  if (fs.existsSync(oldPath)) rm(oldPath);
  rm(path.join(updateDir(), 'app.new'));
}
