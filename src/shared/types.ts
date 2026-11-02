export type NoteColor = 'amber' | 'rose' | 'sky' | 'mint' | 'violet';

export interface Note {
  id: string;
  /**
   * 标题。列表里显示的就是它，空串时列表显示「空标题」。
   *
   * 和正文分成两个字段，是因为「改标题」和「改正文」是两个动作：
   * 靠正文首行顶替的话，在正文里回车一换行，标题就断了；
   * 而且列表里会被一整段话挤满 —— 以前就是整段 textContent 靠 CSS 截成一行。
   */
  title: string;
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
  /**
   * 图片占卡片的高度比例（IMAGE_RATIO_MIN–MAX）。没图时无意义。
   * 默认 0.58 必须和 style.css 里 `.card__img { height: 58% }` 那条对得上 ——
   * 老数据补上默认值之后，画面要和加这个字段之前一模一样。
   */
  imageRatio: number;
}

/**
 * 全局设置。窗口位置和卡片尺寸**不在这里** —— 每个队列一个窗口，
 * 那些是「这一叠自己的」状态，放在 Queue 上，否则两个窗口会互相踩。
 */
export interface Settings {
  hotkey: string;
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

/**
 * 一条任务线：一个队列 = 一个便签窗 + 一叠便签。
 *
 * 多开窗口是这套东西的核心用法 —— 工作、学习、社团各开一个，
 * 每个窗口只处理自己那一叠，互不打扰。
 */
export interface Queue {
  id: string;
  /** 显示在窗口标题和托盘菜单里，用户自己起，比如「工作」 */
  name: string;
  notes: Note[];
  archive: Note[];
  /** 这个窗口上次的位置。多窗口各自记，不然两个窗口会叠在同一个点上 */
  windowX: number | null;
  windowY: number | null;
  cardWidth: number;
  cardHeight: number;
}

export interface NoteDb {
  version: number;
  settings: Settings;
  queues: Queue[];
}

export const CARD_MIN_W = 220;
export const CARD_MAX_W = 520;
export const CARD_MIN_H = 150;
export const CARD_MAX_H = 480;

export const TOOLBAR_H = 34;
export const WINDOW_PAD = 22;

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'Control+Alt+Space',
  autoLaunch: false,
  skin: '',
  skinImage: null,
  skinVeil: 55,
};

export const DEFAULT_QUEUE_SIZE = { cardWidth: 320, cardHeight: 250 };

/**
 * 渲染进程在拿到真数据之前的占位。
 * 三个窗口都要一个初值，各自手写会漂 —— 尤其是队列字段以后再加的时候。
 */
export const EMPTY_DB: NoteDb = {
  version: 3,
  settings: { ...DEFAULT_SETTINGS },
  queues: [
    {
      id: '',
      name: '默认',
      notes: [],
      archive: [],
      windowX: null,
      windowY: null,
      ...DEFAULT_QUEUE_SIZE,
    },
  ],
};

/** 新建队列时的默认值。位置留空由系统摆放，尺寸沿用默认那张纸。 */
export function newQueueFields(name: string) {
  return {
    name,
    notes: [],
    archive: [],
    windowX: null,
    windowY: null,
    cardWidth: DEFAULT_QUEUE_SIZE.cardWidth,
    cardHeight: DEFAULT_QUEUE_SIZE.cardHeight,
  };
}

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

/** 图片占卡片高度的比例。0.2 时只剩一条缩略带，0.8 时基本是图、字只剩两行。 */
export const IMAGE_RATIO_MIN = 0.2;
export const IMAGE_RATIO_MAX = 0.8;
/**
 * 0.58 —— 不是凑整，是 `.card__img` 原来写死的 `height: 58%`。
 * 老数据补默认值之后画面必须和以前逐像素一致，所以这个数字不能改。
 */
export const DEFAULT_IMAGE_RATIO = 0.58;

/** 非数字 / 越界都收回默认值。0.6 是重构前写死的那条线，老数据必须落在它上面。 */
export function clampImageRatio(v: unknown) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_IMAGE_RATIO;
  return Math.min(IMAGE_RATIO_MAX, Math.max(IMAGE_RATIO_MIN, v));
}
