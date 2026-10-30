/**
 * 皮肤管理窗。
 *
 * 独立的 BrowserWindow，从管理窗设置里的「皮肤管理」进来，关掉即销毁 ——
 * 它不像便签那样常驻，多一个渲染进程的成本只在开着的时候付。
 *
 * 这个窗只干一件事：把皮肤挑出来。真正的落地在 skin-runtime 里，
 * 三个渲染进程共用同一份，免得各写一遍漂移。
 */
import { EMPTY_DB, SKINS, type NoteDb } from '../shared/types';
import { applyAllSkin, shrinkToDataUrl } from './skin-runtime';

const grid = document.getElementById('grid') as HTMLElement;
const veil = document.getElementById('veil') as HTMLInputElement;
const veilOut = document.getElementById('veil-out') as HTMLOutputElement;
const btnClose = document.getElementById('btn-close') as HTMLButtonElement;
const veilTip = document.getElementById('veil-tip') as HTMLElement;
const tip = document.getElementById('tip') as HTMLElement;

let db: NoteDb = EMPTY_DB;

/** 预览纸上铺两行假文字：光给一块色块看不出字距和行距。 */
const SAMPLE = ['这张便签', '写点什么'];

function buildPaper(dataSkin: string): HTMLElement {
  const paper = document.createElement('span');
  paper.className = 'sk-card__paper';
  // 带上 data-skin，这张小纸就会匹配到那个皮肤的变量 —— 预览和真实卡片同一套 CSS
  paper.dataset.skin = dataSkin;
  for (const line of SAMPLE) {
    const p = document.createElement('span');
    p.className = 'sk-card__line';
    p.textContent = line;
    paper.appendChild(p);
  }
  return paper;
}

function buildCard(dataSkin: string, label: string, on: boolean, extraClass?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sk-card';
  if (on) btn.classList.add('is-on');
  btn.append(buildPaper(dataSkin));

  const name = document.createElement('span');
  name.className = 'sk-card__name';
  name.textContent = label;
  btn.append(name);
  if (extraClass) btn.classList.add(extraClass);
  return btn;
}

/**
 * 点内置皮肤 = 背景换成那个皮肤。
 * 图还在的话它会继续盖在上面，用户会以为点了没反应，所以顺手把图清掉。
 */
async function chooseSkin(id: string) {
  tip.textContent = '';
  if (db.settings.skinImage) await window.api.clearSkinImage();
  await window.api.updateSettings({ skin: id });
}

async function pickPhoto() {
  tip.textContent = '选一张图片…';
  const picked = await window.api.pickSkinImage();
  if (!picked) {
    tip.textContent = '';
    return;
  }
  if ('error' in picked) {
    tip.textContent = picked.error;
    return;
  }

  tip.textContent = '压缩中…';
  try {
    const small = await shrinkToDataUrl(picked.dataUrl, 1600);
    const saved = await window.api.saveSkinImage(small);
    tip.textContent = saved.ok
      ? `背景已换（${Math.round(small.length / 1024)} KB）`
      : (saved.reason ?? '存不下');
  } catch (err) {
    tip.textContent = err instanceof Error ? err.message : '这张图处理不了';
  }
}

function render() {
  void applyAllSkin(db);

  grid.innerHTML = '';

  for (const skin of SKINS) {
    const on = !db.settings.skinImage && skin.id === (db.settings.skin ?? '');
    const btn = buildCard(skin.id, skin.label, on);
    btn.addEventListener('click', () => void chooseSkin(skin.id));
    grid.appendChild(btn);
  }

  const hasPhoto = !!db.settings.skinImage;
  const photo = buildCard(
    'photo',
    hasPhoto ? '换一张图片' : '用自己的图片',
    hasPhoto,
    hasPhoto ? 'has-photo' : 'is-empty'
  );
  photo.addEventListener('click', () => void pickPhoto());
  grid.appendChild(photo);

  /*
   * 滑杆常显。没有背景图时它没东西可调，但也不能藏起来 ——
   * 藏起来等于用户永远不知道有这个能力（航哥就是这么找不到的）。
   * 置灰 + 一句说明，位置固定，选了图立刻可用。
   */
  veil.disabled = !hasPhoto;
  veilTip.textContent = hasPhoto
    ? '照片上垫的纸色浓度。越浓字越清楚，照片越淡。'
    : '先在上面选一张背景图，这里才能调。';

  // 正在拖滑杆的时候别回填：一次 db 广播回来会把手指按住的值冲掉
  if (document.activeElement !== veil) {
    const v = db.settings.skinVeil ?? 55;
    veil.value = String(v);
    veilOut.textContent = `${v}%`;
  }
}

function wire() {
  btnClose.addEventListener('click', () => window.close());

  /*
   * 拖动中：本窗改自己的 CSS 变量（缩略图立刻跟手），并把值节流推给便签窗。
   * 便签是另一个渲染进程，这里改变量够不着它，只能走 IPC。
   *
   * 不节流的话，拖一次滑杆就是几十次 IPC 往返。80ms 的节奏人眼已经看不出延迟，
   * 而且第一次立刻发（leading edge），手感上不会"拖了才动"。
   */
  let veilPending = Number(veil.value);
  let veilTimer = 0;
  veil.addEventListener('input', () => {
    veilOut.textContent = `${veil.value}%`;
    document.documentElement.style.setProperty('--skin-photo-veil', `${veil.value}%`);
    veilPending = Number(veil.value);
    if (veilTimer) return;
    void window.api.previewSkinVeil(veilPending);
    veilTimer = window.setTimeout(() => {
      veilTimer = 0;
      // 抬手前最后一段没送到的话，补一发
      if (veilPending !== Number(veil.value)) return;
      void window.api.previewSkinVeil(veilPending);
    }, 80);
  });
  // change 才是松手，这时才存盘
  veil.addEventListener('change', () => {
    void window.api.updateSettings({ skinVeil: Number(veil.value) });
  });
}

async function boot() {
  db = await window.api.getDb();
  await applyAllSkin(db);
  render();
  wire();

  window.api.onDbChanged((next) => {
    db = next;
    render();
  });
}

void boot();
