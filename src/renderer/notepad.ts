/**
 * 便签窗：渲染卡片栈，处理「捏起来折掉」这个手势。
 *
 * 拖动时有两条互斥的渲染路径：
 *  1. 折叠（默认）—— 把真卡片抓成位图，沿「抓取点 → 卡片中心」的法线把折痕往外推，
 *     再对纸做镜像反射，屏幕上看到的就是纸被折起来。需要 Chromium 实验 API
 *     `ctx.drawElementImage`。
 *  2. 掀纸（降级）—— 绕卡片顶边 `rotateX`。API 不存在时自动走这条，
 *     手势和判定完全一样，只是观感弱一些。
 *
 * 两条路径共用同一套阈值判定和状态机，区别只在 paint 的部分。
 */
import { DEFAULT_SETTINGS, type Note, type NoteDb } from '../shared/types';

const stage = document.getElementById('stage') as HTMLElement;
const countEl = document.getElementById('count') as HTMLElement;
const btnAdd = document.getElementById('btn-add') as HTMLButtonElement;
const btnManage = document.getElementById('btn-manage') as HTMLButtonElement;
const btnHide = document.getElementById('btn-hide') as HTMLButtonElement;

// ── 掀纸路径（降级用）──
const FLIP_RATIO = 0.34; // 摘除阈值 = 卡片高 × 0.34
const TAP_SLOP = 5; // 位移小于它当作「点一下」而不是拖
const DRAG_DEAD = 12; // 拖动死区，前 12px 不响应，用来滤掉手抖
const RX_CURVE = 38; // 渐近曲线的形状参数，越大越早进入「拖不动」的区段
const RX_MAX = 82; // 最大掀角。不到 90°，所以永远看不到纸背

// ── 折叠路径（默认）──
const FOLD_PAD = 36; // canvas 四周留白，折出去的部分和阴影要地方画
/**
 * 摘除阈值：量的是「折痕离卡片中心还剩多远」，不是「手指走了多远」。
 *
 * 早先是「折角距离 > 对角线 × 0.42」，那个量以抓取点为原点 —— 抓在卡片底边
 * 只要走 231px（窗口够高，走得完），抓在下半部分靠中间时最多只能走一百多像素，
 * 物理上永远够不到阈值，手感就是「怎么拖都不撕」。换成到中心的距离之后，
 * 同一个折痕深度无论从哪儿抓都是同一个数。
 *
 * 0.2 = 半对角线的 20%（394×250 的卡片约 47px），此时折掉的纸约占三成。
 * 调大更难撕，调小更容易。
 */
const FOLD_DEPTH_RATIO = 0.2;
const FOLD_DAMP = 0.85; // 手指走 100px，折痕只推进 85px
const FLAT = 1.5; // 折角小于这个距离就算摊平：画布改成画整张摊平的纸
const FLAT_HIDE = 3; // 画布接管真卡片的门槛。比 FLAT 大一点，避免临界处来回抖。
const REBOUND_MIN = 90; // 回弹最快也要这么长（ms），折得浅时一收手就平才不至于闪
const REBOUND_MAX = 280; // 再深也不超过这个时长
const REBOUND_PER_PX = 1.1; // 每折深 1px，回弹多花 1.1ms

// 实验 API 只在启动时探一次，结果决定这次运行走哪条路径。
const FOLD_OK =
  typeof CanvasRenderingContext2D !== 'undefined' &&
  typeof (CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>)['drawElementImage'] ===
    'function';

// 抓图连续失败（实验 API 换了脾气、或某个 Chromium 版本上行为变了）时，
// 本次运行整体降级到掀纸动画。宁可观感弱，也不要让卡片在手势里变成空白。
let foldBroken = false;

/**
 * 每重画一次就换一张卡，上一轮手势的异步任务必须自己闭嘴。
 *
 * 背景：重画会把上一轮那张卡连同它的折纸画布一起从 DOM 里摘掉。
 * 排在那儿等着抓图的预热任务醒来时，元素已经不在页面上了，
 * drawElementImage 只会报一句「No cached paint record」。
 * 少了这个代号检查，一次陈旧的预热失败就会把整轮折纸判死。
 */
let renderGen = 0;

let db: NoteDb = { version: 1, settings: { ...DEFAULT_SETTINGS }, notes: [], archive: [] };

// 三个状态位的关系：
//   interacting —— 有指针正按在卡片上
//   flipping    —— 正在播放「折走」动画，这段时间不接受新手势
//   pendingRender —— render() 被调用了但现在不能重建 DOM，先记下，等手势结束再补
// render() 会清空 stage，拖动中被调用等于把正在操作的卡片删掉，所以要避开前两个状态。
let interacting = false;
let flipping = false;
let pendingRender = false;
let lastTopId = '';

// 窗口失焦要能中止当前手势，而 finish 定义在 attachGesture 内部。
// 每次绑定时把它的引用挂出来，wire() 里那个只注册一次的 blur 监听器通过它调用。
let activeFinish: ((cancelled: boolean) => void) | null = null;

function applyVars() {
  const root = document.documentElement;
  root.style.setProperty('--card-w', `${db.settings.cardWidth}px`);
  root.style.setProperty('--card-h', `${db.settings.cardHeight}px`);
}

/** 附件文件名 → data URL。渲染是同步的，图片必须提前读进内存。 */
const imageCache = new Map<string, string>();

/** 把当前用到的图片读成 data URL。读不到的跳过 —— 文件可能被用户手动删了。 */
async function preloadImages(): Promise<void> {
  const names = db.notes
    .map((n) => n.image)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const name of names) {
    if (imageCache.has(name)) continue;
    const url = await window.api.readImage(name);
    if (url) imageCache.set(name, url);
  }
}

function buildCard(note: Note): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.color = note.color;
  el.dataset.id = note.id;

  if (note.image) {
    const url = imageCache.get(note.image);
    if (url) {
      const img = document.createElement('img');
      img.className = 'card__img';
      img.src = url;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
      el.classList.add('has-image');
    }
  }

  const text = document.createElement('div');
  text.className = 'card__text';
  if (note.text.trim()) {
    text.textContent = note.text;
  } else {
    // 有图的时候不必再顶一句「空白便签」—— 图本身就是内容
    if (!note.image) {
      text.textContent = '空白便签';
      text.classList.add('card__text--empty');
    }
  }

  // 滚到底就摘掉底部渐隐，否则最后一行永远糊在渐变里。scroll 不冒泡，不影响卡片手势。
  text.addEventListener('scroll', () => {
    text.classList.toggle(
      'at-end',
      text.scrollTop + text.clientHeight >= text.scrollHeight - 2
    );
  });

  el.appendChild(text);

  // 时限细线：一条浅色轨道 + 一条暖色剩余量，缩到 0 就是到期
  const due = document.createElement('div');
  due.className = 'card__due';
  due.hidden = true;
  const dueLine = document.createElement('span');
  dueLine.className = 'card__due-line';
  due.appendChild(dueLine);
  el.appendChild(due);

  return el;
}

/** 已经因为到期抖过 / 通知过的卡片。重启会重来一次，可以接受。 */
const dueFired = new Set<string>();

/**
 * 更新一张卡的时限细线。
 *
 * 只改 width 和 class，绝不重建 DOM —— 重建会把正在进行的折纸手势打断。
 * 比例要 (到期 - 现在) / (到期 - 设定时刻)，所以 note 里专门存了 dueSetAt。
 */
function paintDue(el: HTMLElement, note: Note, now: number) {
  const due = el.querySelector<HTMLElement>('.card__due');
  const line = el.querySelector<HTMLElement>('.card__due-line');
  if (!due || !line) return;

  if (note.dueAt === null) {
    due.hidden = true;
    el.classList.remove('is-overdue');
    return;
  }

  due.hidden = false;
  const span = Math.max(1, note.dueAt - (note.dueSetAt ?? note.dueAt - 1));
  const left = note.dueAt - now;
  const ratio = Math.max(0, Math.min(1, left / span));
  line.style.width = `${(ratio * 100).toFixed(2)}%`;

  const overdue = left <= 0;
  el.classList.toggle('is-overdue', overdue);

  if (!overdue || dueFired.has(note.id)) return;
  dueFired.add(note.id);
  el.classList.add('is-shake');
  window.setTimeout(() => el.classList.remove('is-shake'), 420);
  void window.api.notify('这张便签到期了', note.text.trim().slice(0, 60) || '（空白便签）');
}

/** 每秒刷一次细线。手势进行中跳过：那时真卡片是隐藏的，改样式也没意义。 */
function startDueTicker() {
  window.setInterval(() => {
    if (interacting || flipping) return;
    const el = stage.querySelector<HTMLElement>('article.card');
    const top = db.notes[0];
    if (!el || !top) return;
    paintDue(el, top, Date.now());
  }, 1000);
}

function buildPeek(note: Note): HTMLElement {
  const el = document.createElement('div');
  el.className = 'peek';
  // 跟着自己那张便签的颜色走。不设的话底下的纸永远是写死的米白，
  // 一掀起来就露出一张「不是这个颜色」的白纸。
  el.dataset.color = note.color;

  const text = document.createElement('div');
  text.className = 'peek__text';
  const body = note.text.trim();
  text.textContent = body || '空白便签';
  if (!body) text.classList.add('card__text--empty');
  el.appendChild(text);
  return el;
}

function render() {
  if (interacting || flipping) {
    pendingRender = true;
    return;
  }
  pendingRender = false;

  const notes = db.notes;
  countEl.textContent = notes.length ? `${notes.length} 张待办` : '';

  stage.innerHTML = '';

  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'np__empty';
    const label = document.createElement('p');
    label.textContent = '还没有便签';
    const addBtn = document.createElement('button');
    addBtn.textContent = '新建一张';
    addBtn.addEventListener('click', addNote);
    empty.appendChild(label);
    empty.appendChild(addBtn);
    stage.appendChild(empty);
    lastTopId = '';
    return;
  }

  const top = notes[0];
  // 只垫一张。下面那张和上面那张完全重合，多建几层也全被盖住 —— 白画。
  if (notes.length > 1) stage.appendChild(buildPeek(notes[1]));

  const card = buildCard(top);
  if (top.id !== lastTopId) {
    card.classList.add('enter');
    // 入场动画是 animation-fill-mode: both，播完之后它仍然握着 opacity: 1 和 transform。
    // 而 **CSS 动画的优先级高于 inline style** —— 手势里那句 `card.style.opacity = '0'`
    // 会被整条压掉：纸折起来了，真卡片还亮着，折角旁边原样站着第一张。
    // 动画放完就摘掉 class，把控制权还给 inline style。
    card.addEventListener('animationend', () => card.classList.remove('enter'), { once: true });
  }
  stage.appendChild(card);
  paintDue(card, top, Date.now());

  let canvas: HTMLCanvasElement | null = null;
  let shot: HTMLElement | null = null;

  if (FOLD_OK) {
    canvas = document.createElement('canvas');
    canvas.className = 'fold-canvas';
    // 比卡片大一圈：折出去的那半张、折痕阴影都要在卡片外画得下。
    canvas.width = db.settings.cardWidth + FOLD_PAD * 2;
    canvas.height = db.settings.cardHeight + FOLD_PAD * 2;
    canvas.setAttribute('layoutsubtree', '');

    // canvas 里放的是卡片的第二份副本，供 drawElementImage 抓图。
    // 它自己也会在页面上照常渲染，而且 layoutsubtree 会忽略 position，
    // 结果就和 canvas 里画的内容错开叠在一起。挪出屏幕是唯一有效的隐藏手段：
    // opacity: 0 会让绘制记录消失（抓不到图），visibility: hidden / clip-path 直接画不出东西。
    shot = buildCard(top);
    shot.style.transform = 'translateX(-2000px)';
    canvas.appendChild(shot);
    stage.appendChild(canvas);
  }

  // 这一轮的手势、预热抓图都绑定在这个代号上。render 之后旧代号自动作废。
  const gen = ++renderGen;

  attachGesture(card, canvas, shot, top, gen);
  lastTopId = top.id;
}

function attachGesture(
  card: HTMLElement,
  canvas: HTMLCanvasElement | null,
  shot: HTMLElement | null,
  note: Note,
  gen: number
) {
  /** 这一轮是不是已经被下一次重画换掉了 */
  const alive = () => gen === renderGen;
  // 用 let：抓图连续失败时要能把它置空，当场切回掀纸路径。
  let fold = FOLD_OK && !foldBroken && canvas && shot ? { canvas, shot } : null;
  const ctx = fold ? fold.canvas.getContext('2d') : null;
  // 本次手势是否走折叠。抓上角（从上往下压）时为 false，改走掀纸。
  let foldThis = false;
  // 本次手势是否完全冻结。抓上角时为 true：卡片一动不动，也不能被摘掉。
  let frozen = false;
  // 两套坐标，不能混：画布 0..W/0..H 含留白，卡片在画布里占 (CX,CY,CW,CH)。
  // 所有裁剪、填充、包围盒都必须用卡片那套，用画布那套会让纸背大出一圈。
  const W = fold ? fold.canvas.width : 0;
  const H = fold ? fold.canvas.height : 0;
  const CX = FOLD_PAD;
  const CY = FOLD_PAD;
  const CW = db.settings.cardWidth;
  const CH = db.settings.cardHeight;
  // 掀纸路径的阈值与抓取点无关，按下之前就能定。
  const flipThreshold = Math.max(64, db.settings.cardHeight * FLIP_RATIO);
  // 折叠路径换算成「手指要走的距离」得知道抓取点在哪，按下时才算 —— 见 pointerdown。
  const depthLimit = Math.hypot(CW, CH) * FOLD_DEPTH_RATIO;
  let foldThreshold = 0;

  // 卡片底色按比例压暗。硬编码颜色的话，换卡片配色时纸背会对不上。
  const tone = (k: number, fallback: string) => {
    const bg = getComputedStyle(card).backgroundColor;
    const m = bg.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (!m) return fallback;
    return `rgb(${Math.round(Number(m[1]) * k)}, ${Math.round(Number(m[2]) * k)}, ${Math.round(
      Number(m[3]) * k
    )})`;
  };
  // 纸背：压暗 7%，折过去那一面
  const paperBack = tone(0.93, 'rgb(238, 227, 194)');

  let bitmap: HTMLCanvasElement | null = null;
  let capturing = false;
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  let gx = 0;
  let gy = 0;
  let cx = 0;
  let cy = 0;
  let nx = 0;
  let ny = 1;
  let curDist = 0;
  let active = false;
  let pid = -1;
  let rafId = 0;
  let resetTimer = 0;

  const rectOf = () => (fold ? fold.canvas : card).getBoundingClientRect();

  /**
   * 裁出折痕一侧的半平面。
   * (mx,my) 是折痕上任一点；(nx,ny) 是折痕法线（指向手指）；sign 选哪一侧。
   *
   * 不去算折痕和卡片四条边的交点——那要分好几种情况讨论。改为沿折痕方向铺一条
   * 极长的边，再沿法线推 big 的距离，直接构成一个大到盖住整个画布的四边形。
   */
  const clipHalf = (
    t: CanvasRenderingContext2D,
    mx: number,
    my: number,
    nx: number,
    ny: number,
    sign: number
  ) => {
    const big = 4000;
    const vx = -ny * sign;
    const vy = nx * sign;
    const ox = nx * sign * big;
    const oy = ny * sign * big;
    t.beginPath();
    t.moveTo(mx + vx * big, my + vy * big);
    t.lineTo(mx - vx * big, my - vy * big);
    t.lineTo(mx - vx * big + ox, my - vy * big + oy);
    t.lineTo(mx + vx * big + ox, my + vy * big + oy);
    t.closePath();
    t.clip();
  };

  /**
   * 画一帧折叠状态。
   * (ax,ay) 抓取点，(dirx,diry) 折痕法线（单位向量，指向卡片中心），
   * dist 是折痕沿这条法线从抓取点推进的距离，0 表示没折。
   *
   * 严格的中垂线折叠要求 dist = 「抓取点 → 手指」距离的一半，此时抓取点的镜像正好
   * 落在手指上。实际乘了 FOLD_DAMP（0.85），折痕推得更快，抓取点会越过手指 ——
   * 折角比手指略微超前，观感更「跟得上」，但代价是它不是精确的中垂线。
   */
  const paint = (ax: number, ay: number, dirx: number, diry: number, dist: number) => {
    if (!ctx) return;
    if (!bitmap) return;
    if (dist < FLAT) {
      // 折角小到看不出区别了：直接把整张位图画上去 —— 那就是「完全摊平的纸」。
      // 这里不能什么都不画：早退会让画布空掉，而真卡片这时往往还隐藏着，
      // 两边都不在 → 整张便签凭空消失。
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(bitmap, 0, 0);
      return;
    }
    ctx.clearRect(0, 0, W, H);

    const mx = ax + dirx * dist; // 折痕中点
    const my = ay + diry * dist;
    const nx = dirx; // 局部同名，就是折痕法线
    const ny = diry;

    // 关于「过 (mx,my)、法线 (nx,ny) 的直线」做镜像反射，矩阵是 R = I − 2·n·nᵀ。
    // e,f 是平移项，约束是「折痕上的点变换后仍然落在折痕上」。
    const r00 = 1 - 2 * nx * nx;
    const r01 = -2 * nx * ny;
    const r10 = r01;
    const r11 = 1 - 2 * ny * ny;
    const e = mx - r00 * mx - r01 * my;
    const f = my - r10 * mx - r11 * my;

    // ① 不动的半边：折痕朝手指那一侧，原样画正面
    ctx.save();
    ctx.beginPath();
    ctx.rect(CX, CY, CW, CH);
    ctx.clip();
    clipHalf(ctx, mx, my, nx, ny, 1);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();

    // ② 折过去的那半张：裁同一侧再套反射矩阵，它就翻过来落在这一侧上面。
    //    先算卡片四角反射后的包围盒，把绘制范围框住，免得对整块画布做变换。
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of [
      [CX, CY],
      [CX + CW, CY],
      [CX + CW, CY + CH],
      [CX, CY + CH],
    ]) {
      const qx = r00 * px + r01 * py + e;
      const qy = r10 * px + r11 * py + f;
      if (qx < minX) minX = qx;
      if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy;
      if (qy > maxY) maxY = qy;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(minX, minY, maxX - minX, maxY - minY);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(CX, CY, CW, CH);
    ctx.clip();
    clipHalf(ctx, mx, my, nx, ny, 1);
    ctx.transform(r00, r10, r01, r11, e, f);
    ctx.fillStyle = paperBack;
    ctx.fillRect(CX, CY, CW, CH);
    // 叠一层 7% 的正面：真纸翻过来多少能透出一点背面透过来的字痕
    ctx.globalAlpha = 0.07;
    ctx.drawImage(bitmap, 0, 0);
    ctx.globalAlpha = 1;
    ctx.restore();

    // ③ 折走那一侧留空 —— 纸折走了，露出的就是下面那张，这是它对的地方。

    // ④ 折痕线：沿折痕方向画一条远超卡片的长线，两端交给卡片矩形裁掉
    const big = 4000;
    ctx.save();
    ctx.beginPath();
    ctx.rect(CX, CY, CW, CH);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(mx - ny * big, my + nx * big);
    ctx.lineTo(mx + ny * big, my - nx * big);
    ctx.strokeStyle = 'rgba(92,72,32,0.26)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  };

  /**
   * 把真卡片抓成位图。
   *
   * 两个坑：`drawElementImage` 是直接把内容画在 canvas 上的，所以抓完必须复制到
   * 离屏 canvas 并清空，否则画布上会一直留着一份和原卡片重叠的图像，看起来像「变大了」。
   * 另外元素首次绘制完成前调用会抛 No cached paint record，所以带重试。
   */
  const capture = async (fromGesture: boolean) => {
    if (!fold || !ctx || capturing) return;
    // 这一轮已经被重画换掉的话，抓到的图也没意义，直接放弃。
    if (!alive()) return;
    capturing = true;
    // 图还没解码完就抓图，抓到的是空白 —— 先等它。
    // 这是「卡片上带图片」引入的新竞态，不处理的话拖动时图会忽有忽无。
    const shotImg = fold.shot.querySelector('img');
    if (shotImg && !shotImg.complete) {
      await shotImg.decode().catch(() => undefined);
      if (!alive()) {
        capturing = false;
        return;
      }
    }
    const anyCtx = ctx as unknown as {
      drawElementImage(el: Element, dx: number, dy: number, dw?: number, dh?: number): unknown;
    };
    for (let i = 0; i < 20; i++) {
      if (!alive()) {
        capturing = false;
        return;
      }
      try {
        ctx.clearRect(0, 0, W, H);
        await anyCtx.drawElementImage(
          fold.shot,
          FOLD_PAD,
          FOLD_PAD,
          db.settings.cardWidth,
          db.settings.cardHeight
        );
        const off = document.createElement('canvas');
        off.width = W;
        off.height = H;
        const octx = off.getContext('2d');
        if (octx) octx.drawImage(fold.canvas, 0, 0);
        bitmap = off;
        capturing = false;
        ctx.clearRect(0, 0, W, H);
        if (active) paint(gx, gy, nx, ny, curDist);
        return;
      } catch (err) {
        // 只报第一次：20 次重试全打出来会把终端刷爆
        if (i === 0) {
          const e = err as { name?: string; message?: string };
          console.warn(
            `[fold] 抓图失败（${fromGesture ? '手势中' : '预热'}）：${e?.name ?? 'Error'} ${e?.message ?? String(err)}`
          );
        }
        await new Promise((r) => window.setTimeout(r, 40));
      }
    }
    capturing = false;
    // 预热抓不到不算事：多半是这一轮画布刚建、绘制记录还没生成，下次手势再抓就是了。
    // 只有用户正在拖、却怎么也抓不到，才说明折叠这条路真的走不通。
    if (!fromGesture) return;
    if (!alive()) return;
    // 重试到底还是抓不到图：判定这条路径不可用，本次运行改走掀纸动画。
    // 折叠分支会把真卡片 opacity 置 0，切回去之前必须放回来，否则卡片是隐形的。
    foldBroken = true;
    fold = null;
    foldThis = false;
    card.style.opacity = '';
    canvas?.remove();
    console.warn('[fold] 手势中抓图连续失败，本次运行降级为掀纸动画');
  };

  /**
   * 折角的形变动画。
   *
   * 三条曲线，各有各的用处：
   *  - 摘除（往 760 走）用缓出：起步快、收尾慢，像纸被甩出去；
   *  - 回弹（往 0 走）用线性：匀速摊平。缓入缓出看着更「软」，
   *    但末段几乎不动 —— 折角本来就只剩几个像素，再慢就变成停顿；
   *    匀速则全程都有可见变化，末尾也不会突然跳一下。
   */
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
  const easeLinear = (t: number) => t;

  const animateFold = (
    target: number,
    ms: number,
    done?: () => void,
    ease: (t: number) => number = easeOut
  ) => {
    const from = curDist;
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      curDist = from + (target - from) * ease(t);
      paint(gx, gy, nx, ny, curDist);
      if (t < 1) rafId = requestAnimationFrame(step);
      else if (done) done();
    };
    rafId = requestAnimationFrame(step);
  };

  // 回弹动画放完才解除 interacting。这个 timer 必须能被 pointerdown 取消：
  // 否则回弹途中再按下去，旧 timer 到点把 interacting 置成 false，render() 就会放行，
  // 正在拖的那张卡片被 stage.innerHTML 清掉，手势当场断。
  const reset = (delay: number) => {
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      resetTimer = 0;
      card.style.transition = '';
      card.style.transform = '';
      interacting = false;
      if (pendingRender) render();
    }, delay);
  };

  card.addEventListener('pointerdown', (e) => {
    if (flipping || e.button !== 0) return;
    window.clearTimeout(resetTimer);
    resetTimer = 0;
    cancelAnimationFrame(rafId);
    active = true;
    interacting = true;
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    dx = 0;
    dy = 0;

    if (fold) {
      const r = rectOf();
      gx = e.clientX - r.left;
      gy = e.clientY - r.top;

      // 只允许从下往上折：抓取点必须落在卡片下半部分。
      // 抓上角往里拖是把纸「压」下去（从上往下折），不是「掀」起来 —— 不做。
      // 这次手势整个冻结：卡片不动，也不能被拖出去摘掉。
      foldThis = gy >= CY + CH / 2;
      frozen = !foldThis;

      if (foldThis) {
        // 折痕方向固定为「抓取点 → 卡片中心」，按下时算一次就不再变。
        // 如果让折痕垂直于拖动方向，横着拖时折痕会竖起来横扫整张卡片，一拖就折掉半边。
        const dx0 = CX + CW / 2 - gx;
        const dy0 = CY + CH / 2 - gy;
        const dl = Math.hypot(dx0, dy0);
        if (dl < 1) {
          // 正好按在卡片几何中心：法线退化成零向量，之后投影恒为 0，
          // 折角一动都不动、也永远撕不掉。给一个「朝上」的默认方向 ——
          // 折纸手势本来就是从下往上掀的。
          nx = 0;
          ny = -1;
        } else {
          nx = dx0 / dl;
          ny = dy0 / dl;
        }
        // 阈值换回「手指要推进多少」：抓取点本身离中心 dl，折痕推到离中心
        // depthLimit 时就是推进了 dl - depthLimit。下限 30px 是给「抓得极靠近
        // 中心」兜底 —— 那时 dl 很小，不兜住一碰就撕。
        foldThreshold = Math.max(30, dl - depthLimit);
        curDist = 0;
        ctx?.clearRect(0, 0, W, H);
        if (!bitmap) void capture(true);
      } else {
        card.style.transition = '';
      }
    } else {
      card.style.transition = '';
    }

    card.setPointerCapture(pid);
    card.classList.add('is-dragging');
  });

  card.addEventListener('pointermove', (e) => {
    if (!active) return;
    dx = e.clientX - sx;
    dy = e.clientY - sy;

    // 抓的是上半部分：这张卡这次一个字都不许动 ——
    // 不折、不掀、不位移，更不许被拖出去摘掉。
    if (frozen) return;

    if (foldThis) {
      const r = rectOf();
      cx = e.clientX - r.left;
      cy = e.clientY - r.top;

      // 指针拖到窗口外面：这里**不能**当作取消。
      //
      // 便签窗只比卡片大 22px（左右）、56px（上下），而摘掉要求手指走九十来像素，
      // 往内侧折的时候手指几乎必然会越过窗口边界。早先在这里 finish(true)，
      // 结果就是「拖得挺好的，一出边就弹回来」—— 越用力拖越摘不掉，完全是反的。
      //
      // 越界本身也不需要特别处理：clientX/clientY 变负只让投影更大，折痕继续往外推，
      // paint() 会把折过去的部分裁在画布内，画面上就是一张折得更深的纸。
      // 真的松手收不到 pointerup，靠 window blur 和下一次 pointerdown 兜底。
      //
      // 只取「朝卡片中心」那个方向的位移分量。反方向拖（往外拉）投影为负，
      // max(0) 兜住，等于完全不折 —— 折角只会朝卡片内部长大。
      const proj = (cx - gx) * nx + (cy - gy) * ny;
      curDist = Math.max(0, proj) * FOLD_DAMP;
      if (bitmap) paint(gx, gy, nx, ny, curDist);
      // 画布接管真卡片：折角看得见时把卡片藏起来（两者同框就是重影）；
      // 折角摊平后把卡片放回来 —— 画布上那张摊平的位图和它完全重合，看不出差别。
      // 两个门槛故意不一样（3 和 1.5）：用同一个的话，在临界处来回抖就会闪。
      if (curDist > FLAT_HIDE) card.style.opacity = '0';
      else if (curDist < FLAT) card.style.opacity = '';
      return;
    }

    const up = Math.max(0, -dy);
    const down = Math.max(0, dy);
    const eff = Math.max(0, up - DRAG_DEAD);
    const rx = RX_MAX * (eff / (eff + RX_CURVE));
    const rz = Math.max(-8, Math.min(8, dx * 0.045));
    card.style.transform = `perspective(2400px) rotateX(${rx.toFixed(2)}deg) rotateZ(${rz}deg) translateY(${down * 0.26}px)`;
  });

  const finish = (cancelled: boolean) => {
    if (!active) return;
    active = false;
    card.classList.remove('is-dragging');
    try {
      card.releasePointerCapture(pid);
    } catch {
      /* capture already gone */
    }

    const tapped = Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP;

    if (!cancelled && tapped) {
      interacting = false;
      if (foldThis) {
        cx = gx;
        cy = gy;
        ctx?.clearRect(0, 0, W, H);
        card.style.opacity = '';
      } else {
        card.style.transform = '';
      }
      // 轻点落在图片上 = 「我要看这张图的大图」，落在别处 = 「我要改这张便签」。
      // 用按下时的坐标判断，图有 pointer-events:auto 也不会拦掉折纸手势（事件照样冒泡）。
      const imgRect = card.querySelector('.card__img')?.getBoundingClientRect();
      const onImage =
        !!imgRect &&
        sx >= imgRect.left &&
        sx <= imgRect.right &&
        sy >= imgRect.top &&
        sy <= imgRect.bottom;

      if (pendingRender) render();
      else if (onImage && note.image) void window.api.openImage(note.image);
      // 传 true：轻点卡片的目的就是改这张，进去直接把光标放编辑器里
      else void window.api.openManager(true);
      return;
    }

    // 冻结的手势：卡片本来就没动过，也绝不能被摘掉。直接收工。
    if (frozen) {
      interacting = false;
      card.style.transform = '';
      if (pendingRender) render();
      return;
    }

    // 摘除只有两条路：折角撕掉（foldThis 看折痕推进了多少）、向上拖翻页（看 -dy）。
    // 早先还有一条「横向拖过 160px 也算摘掉」，已移除 —— 见 docs/变更与决策记录.md 的 CR-002。
    const shouldFlip = !cancelled && (foldThis ? curDist > foldThreshold : -dy > flipThreshold);

    if (shouldFlip) {
      flipping = true;
      if (foldThis) {
        // 拖出窗口之后 curDist 可能已经远超 760。固定往 760 走会让动画倒退，
        // 看着像纸自己弹回来 —— 取当前值和 760 的较大者，保证始终是往外折。
        animateFold(Math.max(760, curDist + 40), 220, () => {
          flipping = false;
          interacting = false;
          void window.api.completeNote(note.id);
        });
      } else {
        const rz = Math.max(-8, Math.min(8, dx * 0.045));
        card.style.transition =
          'transform 340ms cubic-bezier(.32,0,.56,1), opacity 240ms ease-in 110ms';
        card.style.transform = `perspective(2400px) rotateX(84deg) rotateZ(${rz * 1.8}deg) translateY(-26px) scale(0.97)`;
        card.style.opacity = '0';
        window.setTimeout(() => {
          flipping = false;
          interacting = false;
          void window.api.completeNote(note.id);
        }, 340);
      }
      return;
    }

    if (foldThis) {
      // 回弹的终点是「摊平」而不是 0：
      // 实测折角距离降到 30 以内，画面就和完全摊平的卡片逐像素一致了，
      // 再往 0 走画面也不变 —— 那段行程纯粹是静止的时间。
      //
      // 时长也跟着行程走：折得深就弹得久，折得浅就一收手就平。
      // 固定时长的话，深折时后半程画面不动（像卡住），浅折时又被拉长（也像卡住）。
      const span = Math.max(0, curDist - FLAT);
      const ms = Math.max(REBOUND_MIN, Math.min(REBOUND_MAX, span * REBOUND_PER_PX));
      animateFold(
        0,
        ms,
        () => {
          interacting = false;
          // 把真卡片放回来。画布上那张摊平的位图和真卡片完全重合，看不出重影。
          //
          // 这里刻意不清画布：清了就多一次「画布空掉、真卡片还没回来」的跳变，
          // 那一下就是肉眼看到的闪烁。画布残留没关系 ——
          // 下次 pointerdown 会先 clearRect，下次 render 会把它整个清掉，
          // 而且它是 pointer-events: none，压在卡片上也不挡任何操作。
          card.style.opacity = '';
          if (pendingRender) render();
        },
        easeLinear
      );
    } else {
      card.style.transition = 'transform 250ms cubic-bezier(.22,1.15,.36,1)';
      card.style.transform = 'perspective(2400px) rotateX(0deg) rotateZ(0deg) translateY(0)';
      reset(250);
    }
  };

  card.addEventListener('pointerup', () => finish(false));
  card.addEventListener('pointercancel', () => finish(true));

  activeFinish = finish;

  // 预热：趁用户还没动手，先把卡片抓成位图备着。
  // 失败不致命 —— 抓不到就等用户真的开始拖时再抓。
  if (fold) {
    window.setTimeout(() => {
      if (alive()) void capture(false);
    }, 60);
  }
}

/** 把剪贴板图片存成附件，返回文件名。 */
async function uploadImage(file: File): Promise<string | null> {
  try {
    const buf = await file.arrayBuffer();
    return await window.api.saveImage(buf, file.type || 'image/png');
  } catch (err) {
    console.warn('[paste] 图片存盘失败', err);
    return null;
  }
}

/**
 * 粘贴图片 → 贴到栈顶那张便签上。
 *
 * 系统截图（Win+Shift+S）之后按 Ctrl+V 就行。不去自己做截屏工具：
 * 那只会做出一个比系统更差的截图器，而真正的缺口是「截完图没地方放」。
 */
async function handlePaste(e: ClipboardEvent) {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  if (!file) return;
  e.preventDefault();

  const name = await uploadImage(file);
  if (!name) return;

  const top = db.notes[0];
  if (top) {
    await window.api.setImage(top.id, name);
  } else {
    // 库里一张都没有：先建一张再接图，别让粘贴白白落空
    const created = await window.api.createNote('');
    await window.api.setImage(created.id, name);
  }
}

async function addNote() {
  await window.api.createNote('');
  // 新建完就是准备写字，同样直接把光标放进去
  await window.api.openManager(true);
}

function wire() {
  btnAdd.addEventListener('click', addNote);
  window.addEventListener('paste', (e) => void handlePaste(e));
  btnManage.addEventListener('click', () => void window.api.openManager());
  btnHide.addEventListener('click', () => void window.api.hideNotepad());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void window.api.hideNotepad();
  });
  window.addEventListener('blur', () => activeFinish?.(true));

  // 这里曾经挂过一个 mouseout（relatedTarget 为空 = 鼠标离开窗口 → 取消手势）。
  // 删掉了：便签窗只比卡片大一圈，往外折必然出窗，那个监听器把「正常拖动」
  // 判成了「用户放弃」，是这个手势最坏的手感来源。
  // 窗口真失焦走上面的 blur。

  // 拖到窗口外再松手时，pointerup 偶尔收不到（capture 掉了）。那会让 interacting
  // 一直挂着、界面从此不再刷新。在 window 上补一道 —— finish 自己有 active 判定，
  // 卡片那一份照常先跑，这一份重复调用直接返回。
  window.addEventListener('pointerup', () => activeFinish?.(false));
  window.addEventListener('pointercancel', () => activeFinish?.(true));
}

async function boot() {
  db = await window.api.getDb();
  applyVars();
  // 图片要先落进内存再 render —— buildCard 是同步的，拿不到就是在画一张没有图的纸
  await preloadImages();
  render();
  wire();
  startDueTicker();

  window.api.onDbChanged((next) => {
    db = next;
    applyVars();
    void (async () => {
      await preloadImages();
      render();
    })();
  });

  window.api.onShown(() => {
    if (interacting || flipping) return;
    render();
  });
}

void boot();
