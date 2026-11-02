import { Tray, Menu, nativeImage, app, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';

let tray: Tray | null = null;

function asset(name: string) {
  return path.join(app.getAppPath(), 'assets', name);
}

export interface TrayQueueItem {
  id: string;
  name: string;
  visible: boolean;
}

export interface TrayHandlers {
  toggle: () => void;
  openManager: () => void;
  /** 从剪贴板（图或文字）直接生成一张便签。热键被占用时的备用入口。 */
  capture: () => void;
  openDataFolder: () => void;
  quit: () => void;
  /**
   * 队列快照。
   *
   * 菜单是 buildFromTemplate 那一刻定死的一张快照，之后窗口显示 / 隐藏都不会自己变，
   * 所以这里每次重建都现读，而不是让调用方缓存一份递进来。
   */
  queueItems: () => TrayQueueItem[];
  /** 只切这一叠。和 toggle 的全出全收是两条路。 */
  toggleQueue: (id: string) => void;
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

  const queues = handlers.queueItems();
  // 只有一个队列时「单独开关」和第一项完全重复 —— 不占这个位置
  const queueSection: MenuItemConstructorOptions[] =
    queues.length > 1
      ? [
          { type: 'separator' },
          { label: '按队列开关', enabled: false },
          ...queues.map<MenuItemConstructorOptions>((q) => ({
            type: 'checkbox',
            label: q.name,
            checked: q.visible,
            click: () => handlers.toggleQueue(q.id),
          })),
        ]
      : [];

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏便签', click: handlers.toggle },
    ...queueSection,
    { label: '管理便签…', click: handlers.openManager },
    { label: '从剪贴板新建便签（Ctrl + Alt + V）', click: handlers.capture },
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
