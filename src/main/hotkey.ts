import { globalShortcut } from 'electron';
import { getDb, updateSettings } from './store';
import { HOTKEY_CANDIDATES } from '../shared/types';

let active = '';

export function registerHotkey(toggle: () => void): string {
  const wanted = getDb().settings.hotkey;
  const order = [wanted, ...HOTKEY_CANDIDATES.filter((k) => k !== wanted)];

  for (const accel of order) {
    let ok = false;
    try {
      ok = globalShortcut.register(accel, toggle);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    active = accel;
    if (accel !== wanted) updateSettings({ hotkey: accel });
    return accel;
  }

  active = '';
  return '';
}

/**
 * 重绑呼出热键。
 *
 * 只注销自己这一个，不能 unregisterAll —— 程序里还有别的全局热键
 * （Ctrl+Alt+V 剪贴板捕获），一把全注销会把它们一起弄没。
 */
export function rebindHotkey(toggle: () => void): string {
  if (active) globalShortcut.unregister(active);
  active = '';
  return registerHotkey(toggle);
}

/**
 * 换成用户指定的热键。
 *
 * 装不上时一定要把上一个装回去：失败就不管的话，程序从此一个热键都没有，
 * 只能去托盘点 —— 用户那边看到的就是「改了一下设置，热键没了」。
 */
export function setHotkey(
  accel: string,
  toggle: () => void
): { ok: boolean; active: string; reason?: string } {
  const prev = active;
  // 同上：只注销自己这一个，别碰别的全局热键
  if (prev) globalShortcut.unregister(prev);

  let ok = false;
  try {
    ok = globalShortcut.register(accel, toggle);
  } catch {
    ok = false;
  }
  if (ok) {
    active = accel;
    updateSettings({ hotkey: accel });
    return { ok: true, active: accel };
  }

  if (prev && prev !== accel) {
    let back = false;
    try {
      back = globalShortcut.register(prev, toggle);
    } catch {
      back = false;
    }
    if (back) {
      active = prev;
      return {
        ok: false,
        active: prev,
        reason: `「${accel}」注册失败（多半被别的程序占了），已退回「${prev}」`,
      };
    }
  }

  active = '';
  return {
    ok: false,
    active: '',
    reason: `「${accel}」注册失败，原来那个「${prev}」也装不回去了`,
  };
}

export function getActiveHotkey() {
  return active;
}

export function unregisterAll() {
  globalShortcut.unregisterAll();
  active = '';
}
