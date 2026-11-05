/**
 * 开始菜单快捷方式。
 *
 * 绿色版是「解压就能跑」，从来没被安装进系统，Windows 的开始菜单索引里自然
 * 搜不到它。解决办法不是引入安装器（发版形态定稿是 zip 整目录），而是往用户
 * 自己的「开始菜单\程序」里放一个 .lnk —— 用户目录、不需要管理员权限。
 *
 * 没有卸载器，所以这里必须能加也能删，且绝不碰不是我们建的 .lnk。
 */
import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const LINK_NAME = '苍泽便签.lnk';
const AUMID = 'dev.cangze.czdesktopnotes';

export type ShortcutState = {
  /** 当前环境能不能用（只有 Windows 打包版可以） */
  supported: boolean;
  /** 是否已经有一个指向当前 exe 的快捷方式 */
  installed: boolean;
  /** 不支持 / 状态异常时说人话 */
  reason?: string;
  linkPath?: string;
};

export type ShortcutResult = {
  ok: boolean;
  state: ShortcutState;
  reason?: string;
};

/**
 * 测试落点覆盖：验证时不该真往他的开始菜单里写东西。
 * 项目里 NOTES_DATA_DIR / NOTES_TRACE / NOTES_GPU 都是这个用法。
 */
function menuDir(): string {
  return (
    process.env.NOTES_START_MENU_DIR ||
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  );
}

function linkPath(): string {
  return path.join(menuDir(), LINK_NAME);
}

/** Windows 不区分路径大小写，短路径 / 斜杠写法也要先归一。 */
const norm = (p: string) => path.resolve(p).toLowerCase();

function unsupported(): ShortcutState | null {
  if (process.platform !== 'win32') {
    return { supported: false, installed: false, reason: '只有 Windows 有开始菜单' };
  }
  if (!app.isPackaged) {
    return {
      supported: false,
      installed: false,
      reason: '开发模式不支持，只有打包版能用',
    };
  }
  return null;
}

export function getShortcutState(): ShortcutState {
  const off = unsupported();
  if (off) return off;

  const p = linkPath();
  if (!fs.existsSync(p)) return { supported: true, installed: false, linkPath: p };

  try {
    const detail = shell.readShortcutLink(p);
    const same = norm(detail.target) === norm(app.getPath('exe'));
    return {
      supported: true,
      installed: same,
      // 用户把程序整个挪过目录，或者自己拖过一个同名快捷方式 —— 都算「不是我们建的」。
      reason: same ? undefined : '有一个同名快捷方式，但它指向别处',
      linkPath: p,
    };
  } catch {
    return {
      supported: true,
      installed: false,
      reason: '同名文件读不出快捷方式信息',
      linkPath: p,
    };
  }
}

export function setStartMenuShortcut(on: boolean): ShortcutResult {
  const off = unsupported();
  if (off) return { ok: false, state: off, reason: off.reason };

  const p = linkPath();
  const fail = (reason: string): ShortcutResult => ({
    ok: false,
    state: getShortcutState(),
    reason,
  });

  try {
    if (on) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const exe = app.getPath('exe');

      // Electron 45 实测：'replace' 只在目标已存在时能成功，空路径上会直接返回 false。
      // 所以按「有没有残留」分两种操作 —— 残留指向旧位置时覆盖，全新安装时创建。
      let operation: 'create' | 'replace' = 'create';
      if (fs.existsSync(p)) {
        try {
          shell.readShortcutLink(p);
          operation = 'replace';
        } catch {
          // 同名但不是快捷方式：绝不覆盖用户放在那儿的文件。
          return fail('那个位置有个同名文件，不是快捷方式，请先手动移除');
        }
      }

      const ok = shell.writeShortcutLink(p, operation, {
        target: exe,
        cwd: path.dirname(exe),
        icon: exe,
        iconIndex: 0,
        description: '苍泽便签 · 桌面便签',
        appUserModelId: AUMID,
      });
      if (!ok) return fail('系统没能写入快捷方式');
    } else {
      // 只删自己建的：用户手动放的同名快捷方式不该被程序悄悄清掉。
      const cur = getShortcutState();
      if (fs.existsSync(p) && !cur.installed) return fail('同名快捷方式指向别处，没有动它');
      fs.rmSync(p, { force: true });
    }
    return { ok: true, state: getShortcutState() };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
