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
const SIDE_FLIP = 160; // 横向拖过这么多也算摘掉
const TAP_SLOP = 5; // 位移小于它当作「点一下」而不是拖
const DRAG_DEAD = 12; // 拖动死区，前 12px 不响应，用来滤掉手抖
const RX_CURVE = 38; // 渐近曲线的形状参数，越大越早进入「拖不动」的区段
const RX_MAX = 82; // 最大掀角。不到 90°，所以永远看不到纸背

// ── 折叠路径（默认）──
const FOLD_PAD = 36; // canvas 四周留白，折出去的部分和阴影要地方画
const FOLD_RATIO = 0.42; // 摘除阈值 = 卡片对角线 × 0.42
const FOLD_DAMP = 0.85; // 手指走 100px，折痕只推进 85px

// 实验 API 只在启动时探一次，结果决定这次运行走哪条路径。
const FOLD_OK =
  typeof CanvasRenderingContext2D !== 'undefined' &&
  typeof (CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>)['drawElementImage'] ===
    'function';

// 抓图连续失败（实验 API 换了脾气、或某个 Chromium 版本上行为变了）时，
// 本次运行整体降级到掀纸动画。宁可观感弱，也不要让卡片在手势里变成空白。
let foldBroken = false;

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

function buildCard(note: Note): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.color = note.color;
  el.dataset.id = note.id;

  const text = document.createElement('div');
  text.className = 'card__text';
  if (note.text.trim()) {
    text.textContent = note.text;
  } else {
    text.textContent = '空白便签';
    text.classList.add('card__text--empty');
  }
  el.appendChild(text);
  return el;
}

function buildPeek(note: Note, i: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'peek';
  el.dataset.i = String(i);

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
  // 只叠 2 层。再多也看不出层次，白白多画两个 DOM。
  const extra = Math.min(notes.length - 1, 2);
  for (let i = extra; i >= 1; i--) stage.appendChild(buildPeek(notes[i], i));

  const card = buildCard(top);
  if (top.id !== lastTopId) card.classList.add('enter');
  stage.appendChild(card);

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

  attachGesture(card, canvas, shot, top);
  lastTopId = top.id;
}

function attachGesture(
  card: HTMLElement,
  canvas: HTMLCanvasElement | null,
  shot: HTMLElement | null,
  note: Note
) {
  // 用 let：抓图连续失败时要能把它置空，当场切回掀纸路径。
  let fold = FOLD_OK && !foldBroken && canvas && shot ? { canvas, shot } : null;
  const ctx = fold ? fold.canvas.getContext('2d') : null;
  // 两套坐标，不能混：画布 0..W/0..H 含留白，卡片在画布里占 (CX,CY,CW,CH)。
  // 所有裁剪、填充、包围盒都必须用卡片那套，用画布那套会让纸背大出一圈。
  const W = fold ? fold.canvas.width : 0;
  const H = fold ? fold.canvas.height : 0;
  const CX = FOLD_PAD;
  const CY = FOLD_PAD;
  const CW = db.settings.cardWidth;
  const CH = db.settings.cardHeight;
  const threshold = fold
    ? Math.hypot(CW, CH) * FOLD_RATIO
    : Math.max(64, db.settings.cardHeight * FLIP_RATIO);

  // 纸背色 = 卡片底色压暗 7%。硬编码一个颜色的话，换卡片配色时纸背会对不上。
  const paperBack = (() => {
    const bg = getComputedStyle(card).backgroundColor;
    const m = bg.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (!m) return 'rgb(238, 227, 194)';
    const k = 0.93;
    return `rgb(${Math.round(Number(m[1]) * k)}, ${Math.round(Number(m[2]) * k)}, ${Math.round(
      Number(m[3]) * k
    )})`;
  })();

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
    ctx.clearRect(0, 0, W, H);
    if (!bitmap) return;
    if (dist < 1.5) return;

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

    // ③ 折痕线：沿折痕方向画一条远超卡片的长线，两端交给卡片矩形裁掉
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
  const capture = async () => {
    if (!fold || !ctx || capturing) return;
    capturing = true;
    const anyCtx = ctx as unknown as {
      drawElementImage(el: Element, dx: number, dy: number, dw?: number, dh?: number): unknown;
    };
    for (let i = 0; i < 20; i++) {
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
      } catch {
        await new Promise((r) => window.setTimeout(r, 40));
      }
    }
    capturing = false;
    // 重试到底还是抓不到图：判定这条路径不可用，本次运行改走掀纸动画。
    // 折叠分支会把真卡片 opacity 置 0，切回去之前必须放回来，否则卡片是隐形的。
    foldBroken = true;
    fold = null;
    card.style.opacity = '';
    canvas?.remove();
    console.warn('[fold] 抓图连续失败，本次运行降级为掀纸动画');
  };

  const animateFold = (target: number, ms: number, done?: () => void) => {
    const from = curDist;
    const t0 = performance.now();
    // 缓出三次曲线：起步快、收尾慢
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
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
      // 折痕方向固定为「抓取点 → 卡片中心」，按下时算一次就不再变。
      // 如果让折痕垂直于拖动方向，横着拖时折痕会竖起来横扫整张卡片，一拖就折掉半边。
      const dx0 = CX + CW / 2 - gx;
      const dy0 = CY + CH / 2 - gy;
      const dl = Math.hypot(dx0, dy0) || 1;
      nx = dx0 / dl;
      ny = dy0 / dl;
      curDist = 0;
      ctx?.clearRect(0, 0, W, H);
      if (!bitmap) void capture();
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

    if (fold) {
      const r = rectOf();
      cx = e.clientX - r.left;
      cy = e.clientY - r.top;
      // 只取「朝卡片中心」那个方向的位移分量。反方向拖（往外拉）投影为负，
      // max(0) 兜住，等于完全不折 —— 折角只会朝卡片内部长大。
      const proj = (cx - gx) * nx + (cy - gy) * ny;
      curDist = Math.max(0, proj) * FOLD_DAMP;
      if (curDist > 2 && bitmap) card.style.opacity = '0';
      if (bitmap) paint(gx, gy, nx, ny, curDist);
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
      if (fold) {
        cx = gx;
        cy = gy;
        ctx?.clearRect(0, 0, W, H);
        card.style.opacity = '';
      } else {
        card.style.transform = '';
      }
      if (pendingRender) render();
      else void window.api.openManager();
      return;
    }

    const shouldFlip = !cancelled && (fold ? curDist > threshold : -dy > threshold || Math.abs(dx) > SIDE_FLIP);

    if (shouldFlip) {
      flipping = true;
      if (fold) {
        animateFold(760, 220, () => {
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

    if (fold) {
      animateFold(0, 200, () => {
        interacting = false;
        ctx?.clearRect(0, 0, W, H);
        card.style.opacity = '';
        if (pendingRender) render();
      });
    } else {
      card.style.transition = 'transform 250ms cubic-bezier(.22,1.15,.36,1)';
      card.style.transform = 'perspective(2400px) rotateX(0deg) rotateZ(0deg) translateY(0)';
      reset(250);
    }
  };

  card.addEventListener('pointerup', () => finish(false));
  card.addEventListener('pointercancel', () => finish(true));

  activeFinish = finish;

  if (fold) window.setTimeout(() => void capture(), 60);
}

async function addNote() {
  await window.api.createNote('');
  await window.api.openManager();
}

function wire() {
  btnAdd.addEventListener('click', addNote);
  btnManage.addEventListener('click', () => void window.api.openManager());
  btnHide.addEventListener('click', () => void window.api.hideNotepad());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void window.api.hideNotepad();
  });
  window.addEventListener('blur', () => activeFinish?.(true));
}

async function boot() {
  db = await window.api.getDb();
  applyVars();
  render();
  wire();

  window.api.onDbChanged((next) => {
    db = next;
    applyVars();
    render();
  });

  window.api.onShown(() => {
    if (interacting || flipping) return;
    render();
  });
}

void boot();
