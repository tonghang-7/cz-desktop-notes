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

export function rebindHotkey(toggle: () => void): string {
  globalShortcut.unregisterAll();
  return registerHotkey(toggle);
}

export function getActiveHotkey() {
  return active;
}

export function unregisterAll() {
  globalShortcut.unregisterAll();
  active = '';
}
