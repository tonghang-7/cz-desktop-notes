import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'node:path';

let tray: Tray | null = null;

function asset(name: string) {
  return path.join(app.getAppPath(), 'assets', name);
}

export interface TrayHandlers {
  toggle: () => void;
  openManager: () => void;
  openDataFolder: () => void;
  quit: () => void;
}

export function createTray(handlers: TrayHandlers) {
  const image = nativeImage.createFromPath(asset('tray.png'));
  tray = new Tray(image);
  tray.setToolTip('苍泽便签');
  tray.on('click', handlers.toggle);
  tray.on('double-click', handlers.openManager);
  refreshTray(handlers);
  return tray;
}

export function refreshTray(handlers: TrayHandlers) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏便签', click: handlers.toggle },
    { label: '管理便签…', click: handlers.openManager },
    { type: 'separator' },
    { label: '打开数据文件夹', click: handlers.openDataFolder },
    { type: 'separator' },
    { label: '退出', click: handlers.quit },
  ]);
  tray.setContextMenu(menu);
}

export function destroyTray() {
  tray?.destroy();
  tray = null;
}
