export type NoteColor = 'amber' | 'rose' | 'sky' | 'mint' | 'violet';

export interface Note {
  id: string;
  text: string;
  color: NoteColor;
  createdAt: number;
  doneAt: number | null;
}

export interface Settings {
  hotkey: string;
  cardWidth: number;
  cardHeight: number;
  windowX: number | null;
  windowY: number | null;
  /** 开机自启。数据目录不在这里 —— 它决定 data.json 在哪，写在自己里面就成了鸡生蛋。 */
  autoLaunch: boolean;
}

export interface NoteDb {
  version: number;
  settings: Settings;
  notes: Note[];
  archive: Note[];
}

export const CARD_MIN_W = 220;
export const CARD_MAX_W = 520;
export const CARD_MIN_H = 150;
export const CARD_MAX_H = 480;

export const TOOLBAR_H = 34;
export const WINDOW_PAD = 22;

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'Control+Alt+Space',
  cardWidth: 320,
  cardHeight: 250,
  windowX: null,
  windowY: null,
  autoLaunch: false,
};

export const HOTKEY_CANDIDATES = [
  'Control+Alt+Space',
  'Control+Alt+N',
  'Control+Shift+Space',
  'Alt+Shift+N',
];

export const STACK_TUCK = 34;

export function windowSizeFor(cardWidth: number, cardHeight: number) {
  return {
    width: Math.round(cardWidth + WINDOW_PAD * 2),
    height: Math.round(cardHeight + TOOLBAR_H + WINDOW_PAD * 2 + STACK_TUCK),
  };
}

export function clampCardSize(w: number, h: number) {
  return {
    cardWidth: Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.round(w))),
    cardHeight: Math.min(CARD_MAX_H, Math.max(CARD_MIN_H, Math.round(h))),
  };
}
