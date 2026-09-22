# ZCode Android

ZCode 的手机伴侣客户端：在手机上连接你电脑上正在使用的 ZCode，浏览项目会话、下发新任务、实时跟进 AI 的执行进度。不是又一个独立的 AI 编程 App——你的 ZCode、你的 GLM 配置、你电脑上的项目，手机只是遥控器和进度看板。

仓库：https://github.com/rickylxw/Zcode-Android

## 架构

```
手机 App (Kotlin + Compose)  ←── REST + WebSocket ──→  PC 桥接服务 (Node.js, bridge/)
                                                          │ 无头运行 ZCode CLI（-p / --resume / --json）
                                                          │ 读取会话数据库（SQLite）
                                                          │ tail 实时运行日志（工具调用/回合事件）
                                                          ▼
                                                    电脑上的 ZCode Agent（沿用你现有的 GLM 模型配置）
```

- **`bridge/`** — 电脑端桥接服务。默认以 app-server 引擎（ZCode Protocol 常驻子进程，字符级流式、与桌面端共享运行时）驱动任务，保留无头 CLI 作为回退引擎（`bridge.config.json` 加 `"engine": "headless"` 或环境变量 `BRIDGE_ENGINE=headless` 切换）。通过 REST 提供会话/消息/项目查询，通过 WebSocket 提供任务下发与实时进度流。API Key 只留在电脑端，手机仅凭配对 token 连接。
- **`app/`** — 安卓客户端（仓库根目录即 Android 工程）。Compose + Material 3，界面全中文。

## 三分钟上手

### 1. 电脑端：启动桥接服务

要求：Node.js ≥ 23（推荐 24，需要内置 `node:sqlite`）。

```bash
cd bridge
npm install        # 仅安装 ws 一个依赖
npm start
```

首次启动会：
- 检测 ZCode CLI 路径（默认 `E:\Program Files\ZCode\resources\glm\zcode.cjs`，可用环境变量 `ZCODE_CJS` 覆盖）；
- 若 `~/.zcode/cli/config.json` 不存在，自动从桌面版配置（`~/.zcode/v2/config.json`）生成无头模式所需配置；
- 生成配对 token（写入 `bridge/bridge.config.json`）并在控制台打印连接地址，例如：

```
手机 App 中填写以下任一地址：
  http://192.168.1.5:8787   token: a1b2c3d4e5   （示意，以你控制台输出为准）
```

> token 改错/想换：删掉 `bridge/bridge.config.json` 重启即可重新生成；也可用环境变量 `BRIDGE_TOKEN` / `BRIDGE_PORT` 覆盖。

### 2. 手机端：连接

1. 安装 APK（本地构建产物 `app/build/outputs/apk/release/app-release.apk`，或直接用 GitHub Release 里下载的包，`adb install` 即可）；
2. 打开 App，填入上面打印的「电脑地址」和「token」，点连接；
3. 看到（电脑上全部项目的）会话列表即成功。

### 3. 用起来

- **继续项目**：会话列表按项目分组，点开任意会话＝以 `--resume` 续接原上下文，在底部输入框下发新指令；
- **跟进进度**：任务执行中会实时显示工具调用流（如「调用工具 Edit」），结束后展示完整回复与变更统计；
- **新任务**：右下角「+」选项目目录（或手输路径）、选权限模式（规划/构建/编辑/全自动）、写下任务目标后发起；
- **归档**：会话太多？在会话页右上角切到「归档」视图；聊天页 ⋮ 菜单可归档/取消归档。与电脑端 ZCode 的归档状态双向同步（电脑端归档的会话手机主列表同样隐藏）；
- **停止**：执行中点「停止」即可终止电脑上的执行进程。

### 4. mini 桌面看板（电脑端）

不想拿起手机也能盯进度：桥接自带一个迷你看板页，电脑上开个小窗口常驻，实时显示手机连接状态、运行中的任务、工具调用/流式输出和待发送队列。

```bash
cd bridge
npm run mini        # 桥接需已在运行；用 Edge/Chrome 开一个无地址栏的独立小窗口
```

也可以直接在浏览器打开启动桥接时控制台打印的 `http://127.0.0.1:8787/mini#<token>`。看板具备：

- **手机在线指示**：手机 App 的 WebSocket 连上即「在线」，断开显示最近在线时间；
- **运行中任务**：任意端（手机/电脑 ZCode 桌面端）发起的回合都会显示，含运行时长、最新工具调用、流式回复预览，并可直接「停止」；
- **最近动态**：全项目的工具调用事件流。

> 看板与手机端走同一套 token 鉴权；token 经 URL `#` 片段传给页面，不会随请求发到服务器。在本机直接打开 `http://127.0.0.1:8787/mini` 也可以——页面会从仅限回环访问的 `/mini/bootstrap` 自动取 token（局域网设备不行，仍需手动输入）。
>
> **点任务卡片标题可展开详情**：权限模式/模型/任务 ID、任务原文、完整流式回复、待发送队列内容（📱手机 / 🖥电脑端发起）、最近 30 条事件时间线；顶栏还有今日回合数与 token 用量。开发时可跑 `node test/mini-mock.mjs` 起一个假数据模拟器验证页面。

## 远程访问（不在同一局域网）

桥接服务只做了 token 认证，**不要直接把端口暴露到公网**。推荐两种方式：

- **Tailscale（推荐，零配置）**：电脑和手机都装 Tailscale 登录同一账号，手机端填电脑的 Tailscale IP（100.x.x.x:8787）；
- **frp/云服务器转发**：务必开启转发端的 HTTPS/加密，并使用强 token。

## 安全须知

- token 等于「电脑控制权」：只在可信网络使用，不要泄露；
- 全自动（yolo）模式下 AI 在你电脑上无需确认地执行操作，敏感项目建议用「规划/构建」模式；
- 桥接服务对你的 ZCode 数据库**只读**，执行任务一律通过官方 CLI 完成。

## 从源码构建 App

```bash
# 电脑上（需要 JDK 17+ 和 Android SDK）
gradlew :app:assembleDebug        # Windows: gradlew.bat
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

> Gradle wrapper 已指向腾讯镜像（国内可直接下载）；本机调试可在启动 App 时带上参数自动连接：
> `adb shell am start -n com.zcode.mobile/.MainActivity --es server "192.168.x.x:8787" --es token "<token>"`

## 自动更新与发布流程

App 内置更新器：设置页（右上角齿轮）可填写更新源并手动检查；会话页每 24 小时自动检查一次，发现新版本会在列表顶部提示。

**发新版本的完整流程：**

1. 改代码，更新 `app/build.gradle.kts` 里的 `versionCode`（+1）和 `versionName`（如 0.2.0 → 0.3.0）；
2. 提交并打标签：`git tag v0.3.0 && git push origin main --tags`；
3. GitHub Actions 自动构建**签名** APK（`ZCode-v0.3.0.apk`）并发布到 Release；
4. 手机 App 下次检查更新（或手动点「检查更新」）即可下载安装。

**首次 Public 仓库时需要做的一次性配置：**

- 把 `app/release.jks` 的 base64 存为仓库 Secret `KEYSTORE_BASE64`
  （PowerShell 生成：`[Convert]::ToBase64String([IO.File]::ReadAllBytes("app\release.jks")) | Set-Clipboard`）；
- 再配三个 Secret：`KEYSTORE_PASSWORD=zcode-update-2026`、`KEY_ALIAS=zcode`、`KEY_PASSWORD=zcode-update-2026`（若你自定义过密码则填自定义值）；
- 在 App 设置页确认更新源：已内置默认仓库 `rickylxw/Zcode-Android`，无需修改（除非换仓库）。

> ⚠️ `app/release.jks` 已被 .gitignore 排除，**绝不会也不应提交到仓库**。它是所有已发布 APK 的签名来源，丢了就无法再给老用户发覆盖更新——请把它备份到仓库之外的安全位置（网盘/密码管理器）。
> 国内下载慢时，App 设置页有「下载加速前缀」（如 `https://mirror.ghproxy.com/`）可选。

## 常见问题

- **连接失败**：确认电脑防火墙放行 8787 端口；确认手机与电脑在同一 Wi-Fi（或已配置 Tailscale）。
- **任务一直无进度**：桥接服务依赖 tail `~/.zcode/cli/log/` 下当日日志，确认该目录存在且 ZCode CLI 版本 ≥ 0.16。
- **提示「模型配置缺失」**：删除 `~/.zcode/cli/config.json` 后重启桥接服务，会自动从桌面版配置重新生成。

## 已知限制 / 后续计划

- App 在前台时才能收到实时进度（后台常驻通知暂未做）；
- `bridge/bridge.config.json`（含 token）已加入 `.gitignore`，请勿提交；
- ZCode CLI 升级可能改变无头参数或日志字段，届时需同步调整 `bridge/src/zcode.js`、`bridge/src/logtail.js`。
