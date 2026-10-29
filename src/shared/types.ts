export type NoteColor = 'amber' | 'rose' | 'sky' | 'mint' | 'violet';

export interface Note {
  id: string;
  text: string;
  color: NoteColor;
  createdAt: number;
  doneAt: number | null;
  /** 到期时刻；null 表示这张没设时限 */
  dueAt: number | null;
  /** 设时限的那一刻。画「还剩多少」的细线要知道总时长，光有到期时间算不出比例 */
  dueSetAt: number | null;
  /**
   * 附件的文件名（不是路径）。
   * 存文件名是因为数据目录可以换 —— 存绝对路径等于把数据和位置焊死。
   * 文件在 <数据目录>/attachments/ 下。
   */
  image: string | null;
}

export interface Settings {
  hotkey: string;
  cardWidth: number;
  cardHeight: number;
  windowX: number | null;
  windowY: number | null;
  /** 开机自启。数据目录不在这里 —— 它决定 data.json 在哪，写在自己里面就成了鸡生蛋。 */
  autoLaunch: boolean;
  /**
   * 皮肤 id，空串 = 素纸。
   * 皮肤只改「材质」（背景纹理、字体、形状、纸背压暗），纸色仍是每张便签的 color，
   * 两者正交 —— 同一个方格纸皮肤配琥珀是黄色方格纸，配浅蓝就是蓝色方格纸。
   */
  skin: string;
  /**
   * 自定义背景图（attachments 里的文件名，不是路径）。
   * 非空时背景层**只有这张图**：内置纹理整层让位，不叠在上面。
   * 字体、圆角、纸背压暗这些仍然跟着 skin 走 —— 图是背景，不是皮肤。
   */
  skinImage: string | null;
  /**
   * 自定义背景图上那层纸色的浓度（0-100，默认 55）。
   * 照片越深，这个数要越大，否则黑字压不住。
   */
  skinVeil: number;
}

/**
 * 内置皮肤。label 给管理窗用，id 对应 style.css 里的 [data-skin='...'] 规则。
 * 加新皮肤：这里加一条，CSS 加一块变量覆盖，别的都不用动。
 */
export const SKINS = [
  { id: '', label: '素纸' },
  { id: 'grid', label: '方格' },
  { id: 'kraft', label: '牛皮' },
] as const;

export function isSkin(v: unknown): v is string {
  return typeof v === 'string' && SKINS.some((s) => s.id === v);
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
  skin: '',
  skinImage: null,
  skinVeil: 55,
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
