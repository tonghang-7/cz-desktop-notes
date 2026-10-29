/**
 * 皮肤在渲染进程里的落地：把 settings 里的三项（皮肤 id、背景图、蒙版浓度）
 * 变成 <html> 上的属性和 CSS 变量。
 *
 * 三个渲染进程（便签窗 / 管理窗 / 皮肤窗）都要做同一件事，抽出来免得三份漂移。
 *
 * 顺序有关系：applySkin 和 applyVeil 必须先于 render —— 折角要读这些变量算纸背色，
 * 晚一步画出来的就是上一套的纸。
 */
import type { NoteDb } from '../shared/types';

/** 当前注入的背景图文件名。db 变化很频繁（打字都会广播），没变就别重读那几百 KB。 */
let photoName = '';

/** 皮肤 id → <html data-skin>，CSS 用 [data-skin='x'] 覆盖那组变量。 */
export function applySkin(db: NoteDb) {
  const s = db.settings.skin;
  if (s) document.documentElement.dataset.skin = s;
  else delete document.documentElement.dataset.skin;
}

/** 蒙版浓度 → CSS 变量。0 = 纯照片，100 = 完全被纸色盖住。 */
export function applyVeil(db: NoteDb) {
  const v = typeof db.settings.skinVeil === 'number' ? db.settings.skinVeil : 55;
  document.documentElement.style.setProperty('--skin-photo-veil', `${v}%`);
}

/**
 * 自定义背景图 → CSS 变量。
 *
 * 必须是 data URL：file:// 或自定义协议会被 Chromium 当成跨源，canvas 一读像素就 taint，
 * drawElementImage 抓图时会**直接跳过那张图** —— 折起来背景凭空消失。
 */
export async function applySkinPhoto(db: NoteDb) {
  const name = db.settings.skinImage ?? '';
  if (name === photoName) return;
  photoName = name;

  const root = document.documentElement;
  const clear = () => {
    root.style.removeProperty('--skin-photo');
    delete root.dataset.skinPhoto;
  };

  if (!name) {
    clear();
    return;
  }
  const url = await window.api.readImage(name);
  if (!url) {
    // 文件被人手动删了：退回不含背景的样子，不要留个裂图
    clear();
    return;
  }
  root.style.setProperty('--skin-photo', `url("${url}")`);
  root.dataset.skinPhoto = '1';
}

/** 三件事一起做，同步部分先落地，背景图异步补上。 */
export async function applyAllSkin(db: NoteDb) {
  applySkin(db);
  applyVeil(db);
  await applySkinPhoto(db);
}

/**
 * 把图缩到指定宽度并转 JPEG。
 *
 * 原图可能是 4000×3000 —— 解码后 48MB 的位图，一张背景不该吃这么多。压完约 300KB。
 * 入参必须是 data URL：换成 file:// 会让 canvas taint，toDataURL 直接抛 SecurityError。
 */
export function shrinkToDataUrl(src: string, maxWidth: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        if (!ctx) throw new Error('拿不到 2d 上下文');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error('这张图解不开'));
    img.src = src;
  });
}
