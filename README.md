# 苍泽便签 · CZ Desktop Notes

![Grab a corner, fold it inward — past the crease it tears off and the next note comes up](media/demo.gif)

A desktop sticky note for the small stuff you would otherwise lose — a question you haven't figured out yet, a reminder you can't afford to forget.

Most note apps want you to **collect**. This one wants you to **finish**.

A single always-on-top window that shows one note at a time. Grab a corner, fold it inward — the paper folds under your cursor, and past a certain crease it tears off and the next note comes up. You can't scroll, browse, or hoard: you can only deal with the one in front of you.

- **Nothing piles up.** A dismissed note goes to an archive, not back onto the stack. Clear them all and the window says *no notes yet* — that's the goal, not a failure.
- **Fold to dismiss.** Grab anywhere and drag inward. The crease runs perpendicular to `grab point → card centre` and follows your pull. Past 42% of the card diagonal it tears off — before that it springs back.
- **Summon from anywhere.** `Ctrl + Alt + Space` over any app, `Esc` to put it away.

Windows 10+ · portable build, no installer · no account, no network, no telemetry. Everything lives in one readable JSON file at `%APPDATA%\cz-desktop-notes\data.json` — back it up, sync it, or hand-edit it.

<sub>Fold rendering uses Chromium's experimental `CanvasDrawElement`; where unavailable it silently falls back to a CSS 3D flip, so the app still works.</sub>

---

## 这是什么

一款桌面便签，用来顺手记下没弄懂的问题、或者留个备忘 —— 那种不立刻写下来就会忘的小事。

大多数笔记软件希望你**积累**，这个希望你**清空**。窗口里永远只显示一张便签：捏住一角朝里折，折深了就撕掉，下一张顶上来。不能滚动、不能翻列表、不能囤 —— 你只能处理眼前这一张。

## 获取

暂无预编译包，从源码构建（需要 Node.js）：

```bash
npm install
npm run dist
```

产物在 `release/CZNotes/`，整个目录拷到任何地方都能双击 `CZNotes.exe` 运行，不需要安装。

## 用法

| 操作 | 动作 |
| --- | --- |
| `Ctrl + Alt + Space` | 呼出 / 收起便签窗 |
| 捏住便签任意位置，朝卡片内部拖 | 纸从抓取点那一角折起，折痕垂直于「抓取点 → 卡片中心」 |
| 折角没到阈值就松手 | 回弹，不摘 |
| 折过阈值（卡片对角线的 42%）松手 | 摘掉，下一张顶上来 |
| 轻点便签 | 打开管理界面 |
| `Esc` | 收起便签窗 |
| 拖顶部细条 | 移动窗口位置 |

窗口位置、卡片尺寸、所有内容都会记住。

## 管理界面

点便签上的 `⋯`，或者托盘图标双击打开。

- **新建便签**：`Ctrl + N` 或右上角按钮，新卡片排在列表最后
- **调整顺序**：直接拖动左侧列表项，越靠上越先显示
- **改内容**：右侧编辑区，输入即自动保存（停顿 0.4 秒落盘）
- **换颜色**：五个色点
- **摘掉**：列表项右侧的 ✓，或编辑器下方「完成并摘掉」
- **已完成**：底部折叠区，可以「放回」或彻底「删除」
- **卡片尺寸**：右上角「卡片尺寸」，宽 220–520、高 150–480

## 数据

`%APPDATA%\cz-desktop-notes\data.json`

纯文本 JSON，可以直接备份、手改。写盘是原子写（先写 `.tmp` 再改名），程序崩了不会写出半个文件。

想把数据放到别处（便携版、放网盘同步、几套数据轮换），设环境变量 `NOTES_DATA_DIR` 指向目录即可。

## 托盘

- 左键：呼出 / 收起
- 右键：显示便签 / 管理便签 / 打开数据文件夹 / 退出

关掉窗口不会退出程序，要退出走托盘菜单。

## 开发

```bash
npm install
npm run start     # 构建并启动
npm run build     # 只构建
npm run dist      # 组装免安装版到 release/CZNotes/
```

`npm run dist` 走的是 `tools/pack.mjs`：把 Electron 运行时复制一份，重命名为 `CZNotes.exe`，再把 `dist/` + `assets/` + 精简后的 `package.json` 放进 `resources/app/`。等价于 electron-builder 的 `--dir` 产物，但不依赖它。整个 `release/CZNotes/` 目录拷到任何地方都能双击运行，数据存在 `%APPDATA%`，不在程序目录。

`tools/` 下是构建脚本：`pack.mjs` 组装免安装版，`run.mjs` 启动，`gen-icon.mjs` / `gen-ico.mjs` 生成图标。

## 几个实现上的取舍

**为什么是「折」而不是「卷」。**
卷曲需要网格顶点变形（WebGL，或逐像素重绘），而本项目默认关闭硬件加速（原因见下）。折纸用一次镜像反射就能精确表达：折痕是一条直线，折过去的那半张纸就是它关于这条线的镜像，没有任何近似。整套渲染只有两次 `drawImage`，没有接缝，耗时约等于零。

**为什么折痕方向固定指向卡片中心。**
如果折痕跟着拖动方向转，横向拖动会让折痕竖起来横扫整张卡片，一拖就折掉半边。固定朝中心后，从左下角抓就往右上折，从右下角抓就往左上折。代价是垂直于折痕方向的拖动分量不响应。

折痕推进的深度是拖动距离的 0.85 倍（`FOLD_DAMP`）。这个值刻意不是 0.5 —— 0.5 才是严格的中垂线折叠、抓取点精确贴住手指；0.85 让折角略微超过手指，观感更跟手。想更钝就往下调，调到 0.5 就是纯几何意义下的精确折纸。

**为什么只有一个窗口装所有卡片，而不是每张一个窗口。**
每张便签一个 BrowserWindow 在 Windows 上就意味着每张一个渲染进程，每张约 50MB。现在是单窗口 + 卡片绝对定位，只占一个渲染进程的量。

**为什么默认关掉硬件加速。**
这是个静态界面，翻页动画只有一张 320×250 的卡片，软件光栅化足够。而 Windows 上透明无边框窗口在硬件加速下容易出现黑边和 GPU 进程崩溃。想要 GPU 渲染可以设环境变量 `NOTES_GPU=1`，但透明窗口在部分显卡驱动上会黑边或让 GPU 进程崩掉，不保证稳定。

**为什么摘掉是两步。**
点一下就消失的设计误触率太高，而便签的全部价值就是「别忘了」。所以摘掉的卡片进归档而不是删除，随时能放回。

**为什么保存绑定卡片 id 而不是「当前选中项」。**
编辑器重建时旧 textarea 从 DOM 移除会触发 blur。如果 blur 回调去读全局的「当前选中项」，旧内容就会写进新选中的卡片。所以保存绑定卡片 id，见 `src/renderer/manager.ts` 的 `flushCurrent`。

**折叠依赖一个实验 API。**
把真卡片渲染进 canvas 用的是 Chromium 的 HTML-in-Canvas（`ctx.drawElementImage`），通过 `--enable-features=CanvasDrawElement` 开启。检测不到这个 API 时自动回落到 `rotateX` 掀纸动画，功能降级但界面不会坏。

它是实验特性，实测在 Electron 42 / Chromium 148 上的三条结果，以及两个必踩的坑，一并记在这里：

| 结论 | 影响 |
| --- | --- |
| `ctx.drawElementImage` 可用，需 `--enable-features=CanvasDrawElement` | 折叠方案成立的前提 |
| 伪元素 `::before` 会被画进 canvas，`mask-image` 不会 | 底部渐隐必须改用纸色渐变覆盖层，不能用遮罩 |
| 单帧 320 次 `drawImage` 约 1.8ms | 软件光栅化下够用，不需要 WebGL |

坑一：元素放进 `layoutsubtree` 后仍会在页面上自行渲染，而且忽略 `position`。要挪走它只有 `transform: translateX(-2000px)` 有效 —— `opacity: 0` 会让绘制记录消失，`visibility: hidden`、`margin-left`、`clip-path: inset(100%)` 全都画不出内容。

坑二：首次绘制完成前调用会抛 `No cached paint record for element`，必须带重试（50ms 间隔，上限 25 次）。另外别用 `requestAnimationFrame` 等待 —— 在某些上下文里它不触发。

## 已知限制

- **仅 Windows**，多显示器与高 DPI 未适配
- 折叠依赖 Chromium 实验特性，API 若被移除会降级为 `rotateX` 掀纸
- 数据文件损坏后无备份，下次写入即覆盖
- 归档不会自动清理
- 无开机自启
- 打包体积 353MB、常驻内存约 278MB，是 Electron 运行时的固有成本
