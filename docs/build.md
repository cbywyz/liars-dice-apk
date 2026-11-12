# 结构与发版

[← 回首页](../README.md)

界面尺寸全部用 `vw`（1rpx = 100/750vw，和小程序的 rpx 等价），换任何屏幕比例都不变形。

## 结构

```
app/src/main/java/com/cbywyz/liarsdice/MainActivity.java   一个 WebView 壳（两版共用）
app/src/full/assets/www/                                    完整版的界面与逻辑
app/src/clean/assets/www/                                   纯净版的界面与逻辑
app/src/full/res/mipmap-*/ic_launcher.png                   完整版图标（骰子 4 点）
app/src/clean/res/mipmap-*/ic_launcher.png                  纯净版图标（骰子 6 点）
app/src/main/res/values/styles.xml                          主题
docs/shots/                                            README 与分页里的截图
LICENSE                                                    许可条款（摘要，全文见本文末）
.github/workflows/build.yml                                 只在要发 APK 时手动触发
```

界面是用网页写的，壳只负责全屏加载 `assets/www/index.html`。同一份代码：
- 打成 APK 给安卓装
- 用手机浏览器打开、或 Safari「添加到主屏幕」，iPhone 也能玩

### 网页源码在哪

APK 里的 `assets/www` 是从仓库外的两个源码目录同步来的（`liars-dice-h5` / `liars-dice-h5-clean`），
纯净版由 `make_clean_h5.py` 从完整版自动裁剪生成 —— 改了完整版，跑一遍脚本纯净版就跟着更新。

## 改代码 / 发版

界面尺寸全部用 `vw`（1rpx = 100/750vw，和小程序的 rpx 等价），换任何屏幕比例都不变形。

### 2026-11-10 起：只发网页版，APK 不跟着编

网页版加到桌面之后跟 APK 没区别（全屏、无地址栏、断网可玩），更新还是「刷新即最新」，
那每版都编一次几分钟的包没什么意义。所以平时改完直接发网页，APK 停在最后一版等以后再说。

**当前状态（2026-11-10 定）**：APK **暂不发新版**，停在 `1.10.22`。下面「发 APK 之前要做的三件事」
是留给以后真要发的时候用的清单 —— 第 2 条那个联机决定还没拍，先搁着，不影响网页版。

| 想做什么 | 怎么做 |
|---|---|
| 发一版网页（**日常就这个**） | 在源码工程里 `python make_clean_h5.py` → `sync_site.py` → `wrangler deploy`，**云端是 Cloudflare**；这个仓库只是镜像，push 上来不会发网页 |
| 发新版 APK（以后要发时） | 先按下面把版本号对齐 → Actions → build → Run workflow，**勾上 `with_apk`** |

工作流现在**只有 APK 一个 job**，`push` 不触发（2026-11-12 去掉了「顺手再发一份静态镜像」那条线：
同一个游戏没必要留两个公开地址，网页只从 Cloudflare 发）。要编 APK 必须手动 dispatch
并勾 `with_apk`，手滑点一下不会把包发出去。

### 发 APK 之前要做的三件事

1. **版本号对齐**：`app/build.gradle` 里两个 flavor 的 `versionName` 改成网页版当前的版本号
   （就是 `index.html` 里 `page-ver` 那个），`versionCode` 各 +1。
   网页版会一直往上涨，APK 停在最后一版，不对齐的话 Release 里的包和线上网页号对不上。
   目前网页版 `1.24.23`，APK 停在 `1.10.22`。
2. **先定联机怎么办**：`assets/www` 里已经有联机那两块（`net.js` / `net.css`），但
   `AndroidManifest.xml` **没有 `INTERNET` 权限** —— 编出来的包装上，点「联机模式」会连不上。
   两条路：① 给 APK 加 `INTERNET` 权限（那就得把「不含网络权限」这个说法从文档里改掉）；
   ② 在 `file://` 下把联机入口挡住、只留一句「联机请用网页版」。**没定之前不要编包**。
3. **网页副本不用手动管**：`app/src/*/assets/www/` 每次推送时由 `push.py` 自动调
   `sync_www.py` 同步，不会过期。想单独确认就跑一次 `python sync_www.py` 看它打印的文件清单。

> 两套源目录：`liars-dice-h5`（完整版）和 `liars-dice-h5-clean`（纯净版）。
> **纯净版是 `make_clean_h5.py` 从完整版裁出来的**，别直接改它 —— 下次生成就覆盖了。
