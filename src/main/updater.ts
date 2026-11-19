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
 * 新版初始化成功后由 confirmPendingUpdate() 清理 app.old。
 */
import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractTarGz, isNewer } from './update-format';
import { logError } from './log';

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

let checkedUpdate: UpdateInfo | null = null;

/** 查有没有新版。用 net.fetch 而不是 Node 的 fetch —— 它走 Chromium 的网络栈，能吃到系统代理。 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  checkedUpdate = null;
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
  const digest = typeof asset.digest === 'string' ? /^sha256:([a-f\d]{64})$/i.exec(asset.digest) : null;
  if (!digest) throw new Error('增量包缺少有效的 SHA-256 摘要，请从发布页下载完整包');

  checkedUpdate = {
    version: latest,
    size: asset.size,
    url: asset.browser_download_url,
    sha256: digest[1].toLowerCase(),
    // electronVersion 在 update.json 里，下载后才知道；这里先占位
    electronVersion: '',
    notes: rel.body || '',
  };
  return checkedUpdate;
}

let downloading = false;

/** 下载并校验增量包。全部准备好后才替换待安装的更新。 */
export async function downloadUpdate(info: UpdateInfo): Promise<string> {
  if (downloading) throw new Error('已有更新正在下载，请稍后再试');
  const checked = checkedUpdate;
  if (!checked || info?.version !== checked.version || info.url !== checked.url || info.sha256 !== checked.sha256) {
    throw new Error('更新信息已失效，请重新检查更新');
  }
  downloading = true;
  try {
    return await prepareUpdate(checked);
  } finally {
    downloading = false;
  }
}

async function prepareUpdate(info: UpdateInfo): Promise<string> {
  const res = await net.fetch(info.url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== info.sha256) throw new Error('SHA-256 校验失败，已丢弃增量包');

  const dir = updateDir();
  fs.mkdirSync(dir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(dir, 'download-'));
  const incoming = path.join(workDir, 'incoming');
  const incomingPending = path.join(workDir, 'incoming.json');
  const backup = path.join(workDir, 'previous');
  const backupPending = path.join(workDir, 'previous.json');
  const staged = path.join(dir, 'app.new');
  const pending = pendingFile();
  let backedUpPending = false;
  let backedUpPackage = false;
  let movedIncoming = false;
  let keepBackup = false;
  try {
    fs.mkdirSync(incoming);
    if (extractTarGz(buf, incoming) === 0) throw new Error('包里没有任何文件');

    const metaFile = path.join(incoming, 'update.json');
    if (!fs.existsSync(metaFile)) throw new Error('包里没有 update.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
      version?: string;
      electronVersion?: string;
    };
    if (meta.version !== info.version) throw new Error('增量包版本与发布版本不一致');

    const runtime = process.versions.electron;
    if (!meta.electronVersion) throw new Error('增量包缺少 Electron 版本，请从发布页下载完整包');
    if (meta.electronVersion !== runtime) {
      throw new Error(
        `这个更新要 Electron ${meta.electronVersion}，你现在是 ${runtime} —— 得下完整包`
      );
    }

    fs.writeFileSync(
      incomingPending,
      JSON.stringify({ version: meta.version, electronVersion: meta.electronVersion, at: Date.now() })
    );
    // 先收起旧记录，最后才放出新记录。启动时只能看到已就位的一整套更新。
    if (fs.existsSync(pending)) {
      fs.renameSync(pending, backupPending);
      backedUpPending = true;
    }
    if (fs.existsSync(staged)) {
      fs.renameSync(staged, backup);
      backedUpPackage = true;
    }
    fs.renameSync(incoming, staged);
    movedIncoming = true;
    fs.renameSync(incomingPending, pending);
    return meta.electronVersion;
  } catch (err) {
    try {
      if (movedIncoming) fs.renameSync(staged, incoming);
      if (backedUpPackage) fs.renameSync(backup, staged);
      if (backedUpPending) fs.renameSync(backupPending, pending);
    } catch (rollbackErr) {
      keepBackup = true;
      logError(`update:download:rollback (${workDir})`, rollbackErr);
    }
    throw err;
  } finally {
    if (!keepBackup) rm(workDir);
  }
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
 * - 上次替换过 → 等新版便签窗就绪后确认，再清理 app.old
 * - 有 pending 且 app.new 就位 → 替换，然后由调用方 relaunch
 */
export function applyPendingUpdate(): 'applied' | 'awaiting-confirmation' | 'none' | 'failed' {
  if (!app.isPackaged) return 'none'; // 开发模式不动，那是源码目录

  const appPath = app.getAppPath(); // ...\resources\app
  const oldPath = `${appPath}.old`;

  if (fs.existsSync(applyingFile())) return 'awaiting-confirmation';

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

    fs.renameSync(appPath, oldPath);
    try {
      fs.writeFileSync(applyingFile(), JSON.stringify({ from: app.getVersion(), to: pending.version }));
      fs.renameSync(local, appPath); // 同盘，瞬间完成
    } catch (err) {
      try {
        fs.renameSync(oldPath, appPath);
      } catch (rollbackErr) {
        logError(`update:rollback (${oldPath} → ${appPath})`, rollbackErr);
      }
      throw err;
    }
    rm(pendingFile());
    rm(staged);
    rm(errorFile());
    return 'applied';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 打包版没有控制台。last-error.txt 给 UI 看，main.log 留带堆栈的现场。
    logError('update:apply', err);
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

/** 便签窗确认就绪后，才清理这一轮更新的旧版备份。 */
export function confirmPendingUpdate(): boolean {
  if (!app.isPackaged) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(applyingFile(), 'utf8')) as { to?: string };
    if (marker.to !== app.getVersion()) throw new Error('运行版本与待确认版本不一致，保留旧版备份');

    // 安装时可能没能删掉待安装记录。只清已安装的版本，保留后来准备的更新。
    if (readPending()?.version === marker.to) {
      fs.rmSync(pendingFile(), { force: true });
      fs.rmSync(path.join(updateDir(), 'app.new'), { recursive: true, force: true });
    }
    const appPath = app.getAppPath();
    fs.rmSync(`${appPath}.staged`, { recursive: true, force: true });
    fs.rmSync(`${appPath}.old`, { recursive: true, force: true });
    fs.rmSync(applyingFile(), { force: true });
    return true;
  } catch (err) {
    logError('update:confirm', err);
    return false;
  }
}
