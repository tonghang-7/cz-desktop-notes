# 发版流程

只有一条路：**草稿 → 传附件 → 核对 → 发布**。不要一步到位直接公开发布。

## 四步

```bash
# 0. 改版本号 + 写正文
#    package.json → "version": "0.3.1"
#    CHANGELOG.md  → 加一节
#    release/v0.3.1-notes.md → 新正文（正文里要带 sha256）

cd <仓库根>
npm run dist          # 构建 + 组装免安装版到 release/CZNotes/
npm run pack          # 打成 release/CZNotes-win64.zip，并打印 sha256
npm run pack-app      # 打成增量包 release/app-<version>.tar.gz（热更新用），打印 sha256
node tools/verify-dist.mjs   # 独立再校验一次产物完整性

# 1. 建草稿（先别带附件！）
gh release create v0.3.1 --draft --target main \
  --title "v0.3.1 · <标题>" --notes-file release/v0.3.1-notes.md \
  --repo tonghang-7/cz-desktop-notes

# 2. 传附件（约 1~5 分钟，取决于网速）
#    两个都要传：完整包给首次安装，增量包给已经在用旧版的人热更新
gh release upload v0.3.1 "release/CZNotes-win64.zip" "release/app-0.3.1.tar.gz" \
  --repo tonghang-7/cz-desktop-notes

# 3. 核对（见下），通过后发布
gh release edit v0.3.1 --draft=false \
  --repo tonghang-7/cz-desktop-notes
```

在 WorkBuddy 会话里执行时，每条 gh 命令前加
`env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy`，
沙箱代理会让 gh 的 OAuth 轮询返回 502。你自己的终端不需要。

## 发布前必须核对的四项

1. **附件字节数** = `npm run pack` 打印的大小（线上 `state` 要是 `uploaded`）
2. **正文里的 sha256** = `npm run pack` 打印的 sha256
3. **tag 指向** = main 的 HEAD（`gh api repos/.../git/ref/tags/<tag>`）
4. **正文与本地文件逐字节一致**（`gh api repos/.../releases/tags/<tag>` 取 `body` 对比）

## 铁律：改过产物形态就必须做干净目录复现测试

v0.3.0 首次发布只上传了 `CZNotes.exe`，别人下载后缺 `icudtl.dat` 等 89 个文件，
启动即崩（exit 3，无弹窗，只在 exe 旁边留一个 `debug.log`）。`CZNotes.exe`
**不能单独拷走**，它依赖同目录的一整套运行时文件。

所以每次改了打包方式、换了 Electron 版本、动了 `tools/pack.mjs`，都要：

```bash
npm run dist && npm run pack
# 解压到全新目录，然后：
cd <解压出来的>/CZNotes
env -u ELECTRON_RUN_AS_NODE timeout 10 ./CZNotes.exe
```

判据（三条都要满足）：

- 退出码 **124**（被 timeout 杀掉，说明进程还活着，不是秒退）
- 同目录**没有** `debug.log`
- 窗口真的起来了（看 `%APPDATA%\cz-desktop-notes\` 下 GPU 缓存有没有被写）

**`ELECTRON_RUN_AS_NODE=1` 必须去掉。** 带着它，Electron 会以纯 Node 模式启动，
主脚本根本不会执行，进程却照样活着 —— 看起来「启动成功」，其实什么都没跑。
某些编辑器/终端会预设这个变量（`tools/run.mjs` 里有专门清它的代码）。
只看到「进程还在」不算通过，要确认窗口起来了。

## 增量包（热更新用）

`npm run pack-app` 只打 `resources/app`（约 90KB，完整包是 146MB）。客户端拉到它、
校验 sha256、解到 `update/app.new/`，**下次启动时**把整个 `resources/app` 换掉；
换失败自动退回 `app.old`，换成功且新版本能正常启动则清掉 `app.old`。

三条硬要求：

1. **两个包必须出自同一次 `npm run dist`。** 分两次跑会得到代码不一致的两份产物，
   热更新上去之后用户看到的是混合版本 —— 这种问题极难排查。
2. **`update.json` 里的 `electronVersion` 决定这个包能不能装。** 客户端比对运行时版本，
   对不上就拒绝（防止新代码跑在旧 Electron 上直接崩）。升级 Electron 版本时，
   必须发完整包，不能指望热更新。
3. **发版时两个附件都要传。** 缺增量包，老用户点「检查更新」会看到
   「这个版本没提供增量包，只能下完整包」。

## 其它约定

- **不要重用 tag。** 出了错就发下一个版本号。确实要覆盖同一版本的附件，
  用 `gh release upload --clobber`，但下载计数会归零。
- **`npm run dist` 会先删掉整个 `release/` 目录**（`tools/pack.mjs` 里的 `rmSync`）。
  上一版的 zip 会被一起删掉 —— 这没问题，GitHub Release 本身就是永久归档。
- 正文里的「已知限制」不要删。GPU 崩溃、体积这些如实写出来，才是可信度的来源。
