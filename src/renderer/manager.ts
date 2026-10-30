/**
 * 管理窗：便签列表、编辑器、归档、设置面板。
 *
 * 这个进程不直接改数据 —— 所有写操作都通过 IPC 交给主进程，主进程落盘后广播新的 db，
 * 这里收到再整体重渲染。单向数据流省掉了两个进程各存一份状态对不上的可能。
 *
 * 唯一需要小心的是编辑器：重建 DOM 会让 textarea 从文档里移除并触发 blur。
 */
import {
  EMPTY_DB,
  SKINS,
  type Note,
  type NoteColor,
  type NoteDb,
  type Queue,
} from '../shared/types';
import { applyAllSkin } from './skin-runtime';

const COLORS: { key: NoteColor; hex: string }[] = [
  { key: 'amber', hex: '#fdf0c7' },
  { key: 'rose', hex: '#fce4ea' },
  { key: 'sky', hex: '#dfeefb' },
  { key: 'mint', hex: '#ddf3e4' },
  { key: 'violet', hex: '#eae4fb' },
];

const list = document.getElementById('list') as HTMLOListElement;
const listEmpty = document.getElementById('list-empty') as HTMLElement;
const editor = document.getElementById('editor') as HTMLElement;
const archiveEl = document.getElementById('archive') as HTMLDetailsElement;
const archiveList = document.getElementById('archive-list') as HTMLUListElement;
const archiveCount = document.getElementById('archive-count') as HTMLElement;
const btnNew = document.getElementById('btn-new') as HTMLButtonElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const btnSkin = document.getElementById('btn-skin') as HTMLButtonElement;
const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
const sizeW = document.getElementById('size-w') as HTMLInputElement;
const sizeH = document.getElementById('size-h') as HTMLInputElement;
const sizeWOut = document.getElementById('size-w-out') as HTMLOutputElement;
const sizeHOut = document.getElementById('size-h-out') as HTMLOutputElement;
const hint = document.getElementById('hint') as HTMLElement;
const cfgSkinName = document.getElementById('cfg-skin-name') as HTMLElement;
const queuesEl = document.getElementById('queues') as HTMLElement;
const cfgAutoLaunch = document.getElementById('cfg-autolaunch') as HTMLInputElement;
const cfgDataDir = document.getElementById('cfg-datadir') as HTMLElement;
const btnDataDir = document.getElementById('btn-datadir') as HTMLButtonElement;
const btnDataDirDefault = document.getElementById('btn-datadir-default') as HTMLButtonElement;
const btnHotkey = document.getElementById('btn-hotkey') as HTMLButtonElement;
const cfgHotkey = document.getElementById('cfg-hotkey') as HTMLOutputElement;
const cfgTip = document.getElementById('cfg-tip') as HTMLElement;
const cfgVersion = document.getElementById('cfg-version') as HTMLElement;
const btnCheckUpdate = document.getElementById('btn-check-update') as HTMLButtonElement;
const btnInstallUpdate = document.getElementById('btn-install-update') as HTMLButtonElement;
const btnRelaunch = document.getElementById('btn-relaunch') as HTMLButtonElement;

type UpdateInfo = {
  version: string;
  size: number;
  url: string;
  sha256: string;
  electronVersion: string;
  notes: string;
};
let updateInfo: UpdateInfo | null = null;

/**
 * 管理界面上「正在看的是哪一叠」。
 * 便签窗靠 URL 认领自己的队列，管理窗没有那个身份，只能自己记一个。
 */
let currentQueueId = '';

function cur(): Queue {
  return db.queues.find((q) => q.id === currentQueueId) ?? db.queues[0]!;
}

let db: NoteDb = EMPTY_DB;
let selectedId: string | null = null;
// 编辑器当前渲染的是哪张卡。同一个 id 就只刷新元信息，不重建 DOM ——
// 重建会让 textarea 失焦、光标跳回开头，打到一半的字就没法接着打了。
let renderedEditorId: string | null = null;
let draggingId: string | null = null;
let saveTimer: number | null = null;
// 录制热键期间，按键的含义是「设成什么」，不是「执行什么」
let recordingHotkey = false;
// 主键已经按下、正在等用户松手的那一组。松手前不检测、不保存。
let pendingAccel: string | null = null;
let sizeTimer: number | null = null;
let savedTimer: number | null = null;

function fmtTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function currentEditor(): { id: string; text: string } | null {
  const ta = editor.querySelector<HTMLTextAreaElement>('.ed__text');
  const id = ta?.dataset.noteId;
  if (!ta || !id) return null;
  return { id, text: ta.value };
}

function clearDropMarks() {
  list.querySelectorAll('.is-over-top, .is-over-bottom').forEach((el) => {
    el.classList.remove('is-over-top', 'is-over-bottom');
  });
}

function renderList() {
  list.innerHTML = '';
  listEmpty.hidden = cur().notes.length > 0;

  cur().notes.forEach((note, index) => {
    const li = document.createElement('li');
    li.className = 'it';
    if (note.id === selectedId) li.classList.add('is-active');
    li.dataset.id = note.id;
    li.dataset.color = note.color;
    li.draggable = true;

    const num = document.createElement('span');
    num.className = 'it__n';
    num.textContent = String(index + 1);

    const text = document.createElement('span');
    text.className = 'it__text';
    if (note.text.trim()) {
      text.textContent = note.text;
    } else {
      text.textContent = '空白便签';
      text.classList.add('is-empty');
    }

    const done = document.createElement('button');
    done.className = 'it__done';
    done.textContent = '\u2713';
    done.title = '摘掉这张';
    done.addEventListener('click', (e) => {
      e.stopPropagation();
      void completeNote(note.id);
    });

    li.append(num, text, done);
    li.addEventListener('click', () => select(note.id));

    li.addEventListener('dragstart', (e) => {
      draggingId = note.id;
      li.classList.add('is-drag');
      e.dataTransfer?.setData('text/plain', note.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    li.addEventListener('dragend', () => {
      draggingId = null;
      li.classList.remove('is-drag');
      clearDropMarks();
    });

    li.addEventListener('dragover', (e) => {
      if (!draggingId || draggingId === note.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropMarks();
      li.classList.add(after ? 'is-over-bottom' : 'is-over-top');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('is-over-top', 'is-over-bottom');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggingId || draggingId === note.id) {
        clearDropMarks();
        return;
      }
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      // 先把拖动项从列表里摘出去再插，直接按原索引插入会在「往后移」时错一位
      const ids = cur().notes.map((n) => n.id).filter((id) => id !== draggingId);
      const idx = ids.indexOf(note.id);
      ids.splice(after ? idx + 1 : idx, 0, draggingId);
      draggingId = null;
      clearDropMarks();

      flushCurrent();
      void window.api.reorderNotes(ids, currentQueueId);
    });

    list.appendChild(li);
  });
}

/** 附件文件名 → data URL。切来切去不该每次都读盘。 */
const editorImageCache = new Map<string, string>();

async function ensureImage(fileName: string): Promise<string | null> {
  const hit = editorImageCache.get(fileName);
  if (hit) return hit;
  const url = await window.api.readImage(fileName);
  if (url) editorImageCache.set(fileName, url);
  return url;
}

/**
 * 时间戳 → datetime-local 的 value（本地时间，YYYY-MM-DDTHH:mm）。
 * 不能拿 toISOString() 顶替 —— 那是 UTC，回填会差一个时区。
 */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local 的 value → 时间戳。格式里没有时区，new Date 会按本地时间解析，正是要的。 */
function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const ts = new Date(v).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function fmtDue(dueAt: number | null): string {
  if (dueAt === null) return '没设时限';
  const left = dueAt - Date.now();
  if (left <= 0) return '已过期';
  const m = Math.round(left / 60_000);
  if (m < 60) return `剩 ${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `剩 ${h} 小时 ${m % 60} 分` : `剩 ${h} 小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `剩 ${d} 天 ${h % 24} 小时` : `剩 ${d} 天`;
}

function updateEditorMeta(note: Note) {
  const imgWrap = editor.querySelector<HTMLElement>('.ed__imgwrap');
  const imgEl = editor.querySelector<HTMLImageElement>('.ed__img');
  if (imgWrap && imgEl) {
    if (note.image) {
      imgWrap.hidden = false;
      if (imgEl.dataset.file !== note.image) {
        imgEl.dataset.file = note.image;
        void ensureImage(note.image).then((url) => {
          if (url) imgEl.src = url;
        });
      }
    } else {
      imgWrap.hidden = true;
      imgEl.removeAttribute('src');
      delete imgEl.dataset.file;
    }
  }

  const dueVal = editor.querySelector<HTMLElement>('.ed__dueval');
  if (dueVal) dueVal.textContent = fmtDue(note.dueAt);

  const dueInput = editor.querySelector<HTMLInputElement>('.ed__dueinput');
  // 正在拨时间的时候别回填 —— 一次 db 广播回来就会把用户刚选的值冲掉
  if (dueInput && document.activeElement !== dueInput) {
    dueInput.value = note.dueAt === null ? '' : toLocalInput(note.dueAt);
  }

  const pos = editor.querySelector('[data-role="pos"]');
  if (!pos) return;
  const idx = cur().notes.findIndex((n) => n.id === note.id);
  if (idx === 0) {
    pos.textContent = '第 1 张 · 最先显示';
  } else if (idx > 0) {
    pos.textContent = `第 ${idx + 1} 张 · 还剩 ${cur().notes.length - idx} 张在它后面`;
  } else {
    pos.textContent = '';
  }
  editor.querySelectorAll<HTMLButtonElement>('.ed__color').forEach((btn) => {
    btn.classList.toggle('is-on', btn.dataset.color === note.color);
  });
}

function renderEditor() {
  const note = cur().notes.find((n) => n.id === selectedId) ?? null;

  if (!note) {
    if (renderedEditorId !== '__empty__') {
      editor.innerHTML = '';
      const p = document.createElement('div');
      p.className = 'mg__editorempty';
      p.textContent = '从左侧选一条便签开始编辑';
      editor.appendChild(p);
      renderedEditorId = '__empty__';
    }
    return;
  }

  if (renderedEditorId === note.id) {
    updateEditorMeta(note);
    return;
  }

  renderedEditorId = note.id;
  editor.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'ed';

  const meta = document.createElement('div');
  meta.className = 'ed__meta';

  const pos = document.createElement('span');
  pos.className = 'ed__pos';
  pos.dataset.role = 'pos';

  const colors = document.createElement('div');
  colors.className = 'ed__colors';
  for (const c of COLORS) {
    const btn = document.createElement('button');
    btn.className = 'ed__color';
    btn.style.setProperty('--c', c.hex);
    btn.dataset.color = c.key;
    btn.title = c.key;
    btn.dataset.colorKey = c.key;
    btn.addEventListener('click', () => {
      if (!selectedId) return;
      void window.api.updateNote(selectedId, { color: c.key }, currentQueueId);
    });
    colors.appendChild(btn);
  }

  meta.append(pos, colors);

  const ta = document.createElement('textarea');
  ta.className = 'ed__text';
  ta.placeholder = '写下你的疑问、想法，或者任何要记住的事…';
  ta.value = note.text;
  ta.dataset.noteId = note.id;
  ta.spellcheck = false;
  ta.addEventListener('input', () => {
    const id = ta.dataset.noteId;
    if (id) scheduleSave(id, ta.value);
  });
  ta.addEventListener('blur', () => {
    const id = ta.dataset.noteId;
    if (id) flushSave(id, ta.value);
  });

  // 图片是便签的内容，编辑器里就得看得见 —— 只在卡片上画一张图，
  // 用户会觉得那只是贴纸，而不是这张便签本身长这样。
  const imgWrap = document.createElement('div');
  imgWrap.className = 'ed__imgwrap';
  imgWrap.hidden = true;

  const imgEl = document.createElement('img');
  imgEl.className = 'ed__img';
  imgEl.alt = '';
  imgEl.addEventListener('click', () => {
    if (note.image) void window.api.openImage(note.image);
  });

  const imgDel = document.createElement('button');
  imgDel.className = 'ed__imgdel';
  imgDel.type = 'button';
  imgDel.textContent = '移除图片';
  imgDel.addEventListener('click', () => void window.api.setImage(note.id, null, currentQueueId));

  imgWrap.append(imgEl, imgDel);

  // 时限：一个原生的日期时间输入框。
  // 预设按钮本质是「相对现在」的换算，既表达不了「周五 14:00 开会」这种，
  // 也不如直接选来得自由 —— 所以不做了。
  const dueRow = document.createElement('div');
  dueRow.className = 'ed__due';

  const dueTag = document.createElement('span');
  dueTag.className = 'ed__duetag';
  dueTag.textContent = '时限';

  const dueVal = document.createElement('span');
  dueVal.className = 'ed__dueval';
  dueVal.textContent = fmtDue(note.dueAt);

  const dueInput = document.createElement('input');
  dueInput.type = 'datetime-local';
  dueInput.className = 'ed__dueinput';
  dueInput.value = note.dueAt === null ? '' : toLocalInput(note.dueAt);
  // 不让选过去：设完立刻过期会马上触发抖动和通知，很怪
  dueInput.min = toLocalInput(Date.now());

  const applyDue = (at: number | null) => {
    void window.api.setDue(note.id, at, currentQueueId);
    dueVal.textContent = fmtDue(at);
  };

  // 用 change 而不是 input：input 会在还在拨分钟数的时候就写一次盘
  dueInput.addEventListener('change', () => {
    applyDue(fromLocalInput(dueInput.value));
  });

  const clearDue = document.createElement('button');
  clearDue.className = 'ed__duebtn';
  clearDue.textContent = '清除';
  clearDue.addEventListener('click', () => {
    dueInput.value = '';
    applyDue(null);
  });

  dueRow.append(dueTag, dueInput, clearDue, dueVal);

  const foot = document.createElement('div');
  foot.className = 'ed__foot';

  const saved = document.createElement('span');
  saved.className = 'ed__saved';
  saved.textContent = '已保存';

  const doneBtn = document.createElement('button');
  doneBtn.className = 'ed__done';
  doneBtn.textContent = '完成并摘掉';
  doneBtn.addEventListener('click', () => void completeNote(note.id));

  foot.append(saved, doneBtn);
  wrap.append(meta, imgWrap, ta, dueRow, foot);
  editor.appendChild(wrap);

  updateEditorMeta(note);
  ta.focus();
}

function renderArchive() {
  archiveCount.textContent = String(cur().archive.length);
  archiveList.innerHTML = '';

  for (const note of cur().archive) {
    const li = document.createElement('li');
    li.className = 'ar';

    const text = document.createElement('span');
    text.className = 'ar__text';
    text.textContent = note.text.trim() || '（空白）';
    text.title = note.text;

    const time = document.createElement('span');
    time.className = 'ar__time';
    time.textContent = fmtTime(note.doneAt ?? note.createdAt);

    const restore = document.createElement('button');
    restore.className = 'ar__btn';
    restore.textContent = '放回';
    restore.addEventListener('click', () => void window.api.restoreNote(note.id, currentQueueId));

    const del = document.createElement('button');
    del.className = 'ar__btn is-danger';
    del.textContent = '删除';
    del.addEventListener('click', () => void window.api.deleteArchived(note.id, currentQueueId));

    li.append(text, time, restore, del);
    archiveList.appendChild(li);
  }
}

/** 设置里只显示当前皮肤的名字，挑选这件事交给皮肤管理窗。 */
function syncSkinName() {
  const hasPhoto = !!db.settings.skinImage;
  const label = hasPhoto
    ? '自己的图片'
    : (SKINS.find((x) => x.id === (db.settings.skin ?? ''))?.label ?? '素纸');
  cfgSkinName.textContent = label;
}

function syncSize() {
  // 用户正在拖滑块时不回写，否则输入框的值会在拖动过程中被自己覆盖
  if (document.activeElement === sizeW || document.activeElement === sizeH) return;
  // 卡片尺寸是每个队列自己的 —— 换队列后滑块要跟着换
  sizeW.value = String(cur().cardWidth);
  sizeH.value = String(cur().cardHeight);
  sizeWOut.textContent = String(cur().cardWidth);
  sizeHOut.textContent = String(cur().cardHeight);
}

/**
 * 队列条：一条任务线一个 chip，末尾一个 +。
 * 单击切换、双击改名、右键删除 —— 三个动作都只动当前这一叠，不碰别的窗口。
 */
function renderQueues() {
  queuesEl.innerHTML = '';

  for (const q of db.queues) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mg__q';
    b.textContent = q.name;
    b.title = `${q.notes.length} 张待办 · 双击改名 · 右键删除`;
    if (q.id === cur().id) b.classList.add('is-on');
    b.addEventListener('click', () => switchQueue(q.id));
    b.addEventListener('dblclick', (e) => {
      e.preventDefault();
      startRenameQueue(q.id, b);
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void removeQueue(q.id);
    });
    queuesEl.appendChild(b);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'mg__q mg__q--add';
  add.textContent = '+';
  add.title = '新建队列，会同时打开一个新的便签窗口';
  add.addEventListener('click', () => void addQueue());
  queuesEl.appendChild(add);
}

function switchQueue(id: string) {
  if (id === cur().id) return;
  // 先把正在编辑的那张存下去，否则切队列会把最后几个字丢掉
  flushCurrent();
  currentQueueId = id;
  selectedId = cur().notes[0]?.id ?? null;
  renderedEditorId = null;
  render();
}

async function addQueue() {
  const q = await window.api.createQueue(`队列 ${db.queues.length + 1}`);
  db = await window.api.getDb();
  currentQueueId = q.id;
  selectedId = cur().notes[0]?.id ?? null;
  renderedEditorId = null;
  render();
}

function startRenameQueue(id: string, chip: HTMLElement) {
  const q = db.queues.find((x) => x.id === id);
  if (!q) return;

  const input = document.createElement('input');
  input.className = 'mg__q-input';
  input.value = q.name;
  chip.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const done = (save: boolean) => {
    if (settled) return;
    settled = true;
    const v = input.value.trim();
    if (save && v && v !== q.name) void window.api.renameQueue(id, v);
    render();
  };
  input.addEventListener('blur', () => done(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      done(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done(false);
    }
  });
}

async function removeQueue(id: string) {
  const q = db.queues.find((x) => x.id === id);
  if (!q) return;

  const total = q.notes.length + q.archive.length;
  // 删队列会把里面的便签和附件一起删掉，不是移进回收站 —— 必须问清楚
  const msg = total
    ? `删除队列「${q.name}」？\n\n里面的 ${q.notes.length} 张待办和 ${q.archive.length} 张归档会一起删除，不能撤销。`
    : `删除空队列「${q.name}」？`;
  if (!window.confirm(msg)) return;

  const r = await window.api.deleteQueue(id);
  if (!r.ok) {
    cfgTip.textContent = r.reason ?? '删不掉';
    return;
  }
  db = await window.api.getDb();
  if (currentQueueId === id) {
    currentQueueId = db.queues[0]!.id;
    selectedId = cur().notes[0]?.id ?? null;
    renderedEditorId = null;
  }
  render();
}

function render() {
  void applyAllSkin(db);
  renderQueues();
  renderList();
  renderEditor();
  renderArchive();
  syncSkinName();
  syncSize();
}

function flashSaved() {
  const el = editor.querySelector('.ed__saved');
  if (!el) return;
  el.classList.add('is-on');
  if (savedTimer) window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => el.classList.remove('is-on'), 1200);
}

async function commitText(id: string, text: string) {
  if (!id) return;
  await window.api.updateNote(id, { text }, currentQueueId);
  flashSaved();
}

function scheduleSave(id: string, text: string) {
  if (saveTimer) window.clearTimeout(saveTimer);
  // 停顿 420ms 才落盘。打中文时每敲一个字都触发一次 input，
  // 不防抖就是一字一次 IPC、一次全量写盘。
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void commitText(id, text);
  }, 420);
}

function flushSave(id: string, text: string) {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  void commitText(id, text);
}

/**
 * 把编辑器里还没落盘的内容立刻存掉。
 *
 * 切换选中项、摘掉、新建、拖动排序之前都必须先调它，否则当前这张的最后几个字会丢。
 *
 * 它读的是 textarea 自己身上的 noteId，不是 selectedId —— 这条很关键：编辑器重建时
 * 旧 textarea 的 blur 会晚一步触发，那时 selectedId 已经指向新卡片了，读全局选中项
 * 就会把旧内容写进新卡片。
 */
function flushCurrent() {
  const cur = currentEditor();
  if (cur) flushSave(cur.id, cur.text);
}

function select(id: string) {
  if (selectedId === id) return;
  flushCurrent();
  selectedId = id;
  renderList();
  renderEditor();
}

async function completeNote(id: string) {
  flushCurrent();

  const idx = cur().notes.findIndex((n) => n.id === id);
  // 摘掉后选中它后面那张；没有了选前面；前后都没有就清空选中
  const fallback = cur().notes[idx + 1]?.id ?? cur().notes[idx - 1]?.id ?? null;

  await window.api.completeNote(id, currentQueueId);

  if (selectedId === id) {
    selectedId = fallback;
    renderedEditorId = null;
  }
  db = await window.api.getDb();
  render();
}

async function createNew() {
  flushCurrent();

  const note = await window.api.createNote('', undefined, currentQueueId);
  db = await window.api.getDb();
  if (!note) return;
  selectedId = note.id;
  renderedEditorId = null;
  render();

  requestAnimationFrame(() => {
    const ta = editor.querySelector<HTMLTextAreaElement>('.ed__text');
    ta?.focus();
    list.querySelector('.it.is-active')?.scrollIntoView({ block: 'nearest' });
  });
}

/** 热键显示成 Ctrl + Alt + Space 这样，原样是 Control+Alt+Space。 */
function prettyHotkey(accel: string) {
  return accel.replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');
}

/**
 * 修饰键本身。它们单独按下不代表任何热键 —— 只是一次组合里的组成部分。
 *
 * 录制时必须先跳过它们：按 Ctrl 的那一瞬间 e.ctrlKey 已经是 true，
 * 如果拿它当主键，拼出来就是 `Control+Control`，注册必失败，
 * 而且老代码在这里就把录制结束了 —— 用户连第二个键都没机会按。
 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'OS']);

/**
 * 主键名。用 e.code（物理键位）而不是 e.key：
 * 中文输入法下 e.key 可能变成 `Process`，大小写还会跟着 CapsLock 漂。
 * e.code 是 `KeyA` / `Digit1` / `F5` / `Space` 这种，正好对得上 Electron 的写法。
 */
const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

function keyNameOf(e: KeyboardEvent): string {
  const c = e.code;
  if (c.startsWith('Key')) return c.slice(3); // KeyA → A
  if (c.startsWith('Digit')) return c.slice(5); // Digit1 → 1
  if (c.startsWith('Numpad')) return `num${c.slice(6)}`; // Numpad0 → num0
  if (/^F\d{1,2}$/.test(c)) return c; // F5
  return CODE_KEYS[c] ?? e.key;
}

/**
 * 把一次按键翻译成 Electron 的 accelerator 字符串。
 * 不带修饰键的单击不给过 —— 那会吞掉用户在别处的所有输入（单按 A 就呼出便签）。
 */
function accelFromEvent(e: KeyboardEvent): string | null {
  if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.metaKey) parts.push('Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(keyNameOf(e));
  return parts.join('+');
}

/**
 * 真正提交：检测能不能注册、能就存下来。
 * 只有成功才结束录制 —— 失败时停在「录制中」，让用户直接换一组重按，
 * 不用再点一次「录制」。
 */
async function applyHotkey(accel: string) {
  const r = await window.api.setHotkey(accel);
  cfgHotkey.textContent = r.active ? prettyHotkey(r.active) : '未绑定';
  hint.textContent = r.active
    ? `按 ${prettyHotkey(r.active)} 随时呼出便签`
    : '热键未绑定成功，可从托盘图标呼出';

  if (r.ok) {
    stopRecording();
    cfgTip.textContent = '已生效';
  } else {
    cfgTip.textContent = `「${prettyHotkey(accel)}」没设成：${r.reason ?? '被别的程序占了'}。直接再按一组`;
  }
}

function stopRecording() {
  recordingHotkey = false;
  pendingAccel = null;
  btnHotkey.textContent = '录制';
  btnHotkey.classList.remove('is-recording');
}

async function changeDataDir(dir: string | null) {
  const r = await window.api.setDataDir(dir);
  cfgDataDir.textContent = r.dir;
  cfgTip.textContent = r.ok
    ? dir
      ? '已搬到新位置，原位置没留副本'
      : '已回到默认位置'
    : (r.reason ?? '没换成');
  if (r.ok) {
    db = await window.api.getDb();
    render();
  }
}

function onSizeInput() {
  const w = Number(sizeW.value);
  const h = Number(sizeH.value);
  sizeWOut.textContent = String(w);
  sizeHOut.textContent = String(h);

  if (sizeTimer) window.clearTimeout(sizeTimer);
  sizeTimer = window.setTimeout(() => {
    sizeTimer = null;
    void window.api.setQueueBounds(currentQueueId, { cardWidth: w, cardHeight: h });
  }, 140);
}

function wire() {
  btnNew.addEventListener('click', () => void createNew());

  btnSettings.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
  });

  sizeW.addEventListener('input', onSizeInput);
  sizeH.addEventListener('input', onSizeInput);

  document.addEventListener('click', (e) => {
    if (settingsPanel.hidden) return;
    const target = e.target as Node;
    if (settingsPanel.contains(target) || btnSettings.contains(target)) return;
    settingsPanel.hidden = true;
  });

  cfgAutoLaunch.addEventListener('change', () => {
    void (async () => {
      const on = await window.api.setAutoLaunch(cfgAutoLaunch.checked);
      cfgAutoLaunch.checked = on;
      cfgTip.textContent = on ? '开机会自动启动' : '已关掉开机自启';
    })();
  });

  btnDataDir.addEventListener('click', () => {
    void (async () => {
      const dir = await window.api.chooseDataDir();
      if (dir) await changeDataDir(dir);
    })();
  });

  btnDataDirDefault.addEventListener('click', () => {
    void changeDataDir(null);
  });

  btnHotkey.addEventListener('click', () => {
    recordingHotkey = true;
    pendingAccel = null;
    btnHotkey.textContent = '按下组合键…';
    btnHotkey.classList.add('is-recording');
    cfgTip.textContent = '按下想要的组合键，全部松开后生效；Esc 取消';
  });

  // 版本号放在这儿，是为了让人自己就能判断「要不要更新」——
  // 不联网查，只把当前版本摆出来，点一下去发布页看最新的。
  void window.api.getVersion().then((v) => {
    cfgVersion.textContent = `v${v}`;
  });

  // 已经下好、等重启才生效的更新（上次点完安装但没重启）
  void window.api.pendingUpdate().then(async (p) => {
    if (!p) return;
    // 上次安装失败过的话，pending 还留着（留着才能重试）。
    // 这时必须把失败原因说出来 —— 否则用户只会看到「点了重启，什么都没变」。
    const err = await window.api.lastUpdateError();
    if (err) {
      const first = err.split('\n').filter(Boolean).pop() || err;
      cfgTip.textContent = `v${p.version} 安装失败：${first}`;
      btnRelaunch.textContent = '再试一次';
      btnRelaunch.hidden = false;
      return;
    }
    cfgTip.textContent = `v${p.version} 已下载，重启后生效`;
    btnRelaunch.hidden = false;
  });

  btnCheckUpdate.addEventListener('click', () => {
    void (async () => {
      btnCheckUpdate.disabled = true;
      btnCheckUpdate.textContent = '检查中…';
      const r = await window.api.checkUpdate();
      btnCheckUpdate.disabled = false;
      btnCheckUpdate.textContent = '检查更新';

      if (!r.ok) {
        cfgTip.textContent = `检查失败：${r.error}（没联网或 GitHub 不通时可以下完整包）`;
        return;
      }
      if (!r.info) {
        cfgTip.textContent = `已是最新（v${r.current}）`;
        return;
      }
      updateInfo = r.info;
      cfgTip.textContent = `发现 v${r.info.version}，增量包 ${Math.round(r.info.size / 1024)} KB`;
      btnInstallUpdate.hidden = false;
    })();
  });

  btnInstallUpdate.addEventListener('click', () => {
    void (async () => {
      if (!updateInfo) return;
      btnInstallUpdate.disabled = true;
      btnInstallUpdate.textContent = '下载中…';
      const r = await window.api.downloadUpdate(updateInfo);
      btnInstallUpdate.disabled = false;
      btnInstallUpdate.textContent = '安装';
      if (!r.ok) {
        cfgTip.textContent = `装不上：${r.error} —— 可以把完整包下下来手动覆盖`;
        return;
      }
      btnInstallUpdate.hidden = true;
      cfgTip.textContent = `v${updateInfo.version} 已就位，重启后生效`;
      btnRelaunch.hidden = false;
    })();
  });

  btnRelaunch.addEventListener('click', () => void window.api.relaunchApp());

  btnSkin.addEventListener('click', () => void window.api.openSkinWindow());

  document.addEventListener('keydown', (e) => {
    if (recordingHotkey) {
      e.preventDefault();

      if (e.key === 'Escape') {
        stopRecording();
        cfgTip.textContent = '已取消';
        return;
      }

      // 按下的只是修饰键本身：记下就好，一个字都别提交。
      // 用户这时还在往组合上加键，程序不该有任何动作。
      if (MODIFIER_KEYS.has(e.key)) {
        cfgTip.textContent = '继续按，全部松开后生效';
        return;
      }

      const accel = accelFromEvent(e);
      if (!accel) {
        cfgTip.textContent = '至少要带一个修饰键（Ctrl / Alt / Shift）';
        return;
      }

      // 主键按下了，但**还不提交** —— 只把读到的组合报给用户看，
      // 真正的检测和保存留到「全部松开」（见下面的 keyup）。
      // 这样按住不放的时候还来得及改主意：再按一个键就覆盖这一组。
      pendingAccel = accel;
      cfgHotkey.textContent = prettyHotkey(accel);
      btnHotkey.textContent = '松开生效…';
      cfgTip.textContent = '松开全部按键后生效，按 Esc 取消';
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      void createNew();
    }
  });

  /**
   * 全部松开才算「按完」。
   *
   * 只要还有修饰键按着就继续等 —— 用户可能按完 Space 又想加一个键。
   * 等最后一个修饰键也松手，这一次组合才定下来，再去检测能不能注册。
   */
  document.addEventListener('keyup', (e) => {
    if (!recordingHotkey || !pendingAccel) return;
    if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    const accel = pendingAccel;
    pendingAccel = null;
    btnHotkey.textContent = '检测中…';
    void applyHotkey(accel);
  });

  // 录制中途窗口失焦：keyup 可能一个都收不到，状态会一直挂着
  window.addEventListener('blur', () => {
    if (!recordingHotkey) return;
    stopRecording();
    cfgTip.textContent = '录制已取消（窗口失去焦点）';
  });

  // 粘贴图片：贴到当前选中的那张
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    const id = selectedId;
    if (!file || !id) return;
    e.preventDefault();
    void (async () => {
      try {
        const buf = await file.arrayBuffer();
        const name = await window.api.saveImage(buf, file.type || 'image/png');
        await window.api.setImage(id, name, currentQueueId);
      } catch (err) {
        console.warn('[paste] 图片存盘失败', err);
      }
    })();
  });

  archiveEl.addEventListener('toggle', () => {
    if (archiveEl.open && cur().archive.length === 0) {
      archiveEl.open = false;
    }
  });
}

async function boot() {
  db = await window.api.getDb();
  currentQueueId = db.queues[0]!.id;
  selectedId = cur().notes[0]?.id ?? null;
  await applyAllSkin(db);
  render();
  wire();

  // 从便签窗点卡片 / 新建便签进来：把光标直接放进编辑器，
  // 省掉「点开管理窗 → 还得再点一下编辑区」这一步。
  window.api.onFocusEditor(() => {
    requestAnimationFrame(() => {
      const ta = editor.querySelector<HTMLTextAreaElement>('.ed__text');
      if (!ta) return;
      ta.focus();
      // 光标落到末尾：点进来多半是想接着往下写
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    });
  });

  const key = await window.api.getHotkey();
  cfgHotkey.textContent = key ? prettyHotkey(key) : '未绑定';
  hint.textContent = key
    ? `按 ${prettyHotkey(key)} 随时呼出便签`
    : '热键未绑定成功，可从托盘图标呼出';
  cfgAutoLaunch.checked = await window.api.getAutoLaunch();
  cfgDataDir.textContent = await window.api.getDataDir();
  // 面板宽度有限，路径会被截断 —— 完整的悬停可见
  cfgDataDir.title = cfgDataDir.textContent;

  window.api.onDbChanged((next) => {
    db = next;
    // 选中的卡片可能被别处删了或进了归档。只有它两张列表里都找不到时才换选中项，
    // 否则每次 db 变化都会把选中重置回第一张。进了归档的保持选中，编辑器显示空提示。
    if (selectedId && !cur().notes.some((n) => n.id === selectedId)) {
      if (!cur().archive.some((n) => n.id === selectedId)) {
        selectedId = cur().notes[0]?.id ?? null;
        renderedEditorId = null;
      }
    }
    render();
  });
}

void boot();
