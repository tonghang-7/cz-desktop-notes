/**
 * 看图窗：一整块屏幕只放一张图。
 *
 * 为什么单独开一扇窗，而不是在便签窗里弹层：便签窗是 360 宽的常驻小窗，
 * 16:10 的图在里面按比例塞进去只有 380×237 —— 比卡片上那张还矮，等于没放大。
 * 撑大便签窗又会踩到 queue.cardWidth/cardHeight 的自动记录（看图不该动用户的数据）。
 * 所以干脆另开一扇，只负责「这张图铺满屏幕」，关掉就销毁。
 *
 * 关窗用 window.close()，不需要额外的 IPC：窗口关自己，主进程在 closed 事件里清引用。
 */

const img = document.getElementById('ivw-img') as HTMLImageElement | null;
const file = new URLSearchParams(location.search).get('file') ?? '';

if (img) {
  if (file) {
    void window.api.readImage(file).then((url) => {
      if (url) img.src = url;
    });
  }
  // 图还没读回来就有人点了：关掉就完了，不用管。
}

const closeViewer = () => window.close();

// 点任意处关闭是唯一的操作 —— 没有缩放、没有拖动，所以不需要犹豫手势冲突。
document.addEventListener('click', closeViewer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeViewer();
});
