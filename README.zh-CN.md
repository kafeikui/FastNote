# FastNote

[English](README.md) | 简体中文

加密笔记 + 1:1 端到端加密即时通讯。个人/小圈子使用，零知识，自托管，无埋点/无遥测。

- **本地优先**：笔记、聊天记录都先加密存在本地（IndexedDB），联网只是可选的同步/中继手段。
- **零知识服务器**：自托管中继只存密文和无法反推明文的元数据，忘记主密码数据不可恢复（严格模式，无后门/无恢复码）。
- **无异常外部通信**：不引入任何埋点/统计/崩溃上报/自动更新类库；所有网络请求都必须经过你自己配置的服务器地址，并受运行时 CSP 白名单约束。

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [协议规范](docs/PROTOCOL.md)
- [数据库 Schema](docs/DATABASE.md)
- [Phase 1 任务](docs/PHASE1.md)
- [部署文档](docs/DEPLOYMENT.md)（自托管中继：HTTPS + nginx 共存 + certbot 自动续期）
- [Vercel 部署](docs/VERCEL.md)（仅 Web 前端——中继服务器无法跑在 Vercel 上，原因见文档内说明）
- [Memory Bank](memory-bank/)（项目背景、当前进度、技术约定的持久化记录，AI 协作/新贡献者上手请先读这里）

## 功能一览

**笔记**
- 树状目录（文件夹/笔记/表格），拖拽排序、多级目录
- 编辑器：Tiptap WYSIWYG（默认）↔ CodeMirror 源码模式，自动保存
- 表格节点：列排序/筛选、增删行列（新行/新列插入于选中单元格的上方/左侧或下方/右侧，可选）；列/选中区域的统计条（计数、求和、平均值）；类电子表格公式（`=SUM(A1:A3)`、`AVERAGE`、`COUNT`、`MIN`、`MAX`、四则运算与乘方、整列引用 `=SUM(C:C)`），**输入 = 后点击其他单元格即插入引用、拖动引用多行多列区域、点击列号引用整列**；列数字格式（数字/货币/小数位）、一键插入当前时间、一键清除格式；多格复制与智能粘贴分列（生效分隔符可多选自定义：Tab/分号/逗号/空格）；Shift+Enter 单元格内换行，多行单元格通过 Excel 风格引号在复制/粘贴中完整往返；Alt+方向键调整行/列顺序或与相邻单元格交换内容，Shift+方向键移动选中格并直接进入编辑；Esc 撤销本次单元格编辑或清除选区；公式提交（Enter/移开焦点）时自动补全未闭合的小括号；固定表头/首列、行高列宽调节（行高可统一设置且最小可缩至 12px，列宽边缘双击自动适应内容）、单元格加粗/字号/颜色/填充；导出 CSV（明文）/ `.fnxt`（加密），支持导入
- 批量导入文件夹：保留目录结构，无扩展名文件作为笔记、`.csv` 作为表格导入
- 本地全文搜索（加密索引快照，不上传服务器）
- 两分组标签页分栏视图：标签可拖拽排序，预览（斜体）/固定两种模式，重启和锁定/解锁后保留
- 可选 LaTeX 公式渲染（KaTeX，默认关闭）、行号、JSON 格式化、行级快捷键（Ctrl+D 删行、Alt+↑/↓ 移动行）
- 快捷键可在设置中自定义（重命名、上锁、表格重复/撤销/恢复、删除、焦点跳转等）
- 编辑焦点历史：编辑、打开/点选标签页、在内容中点选都会记录，Ctrl+Alt+←/→（可自定义）跳转上一个/下一个焦点，目标标签页自动激活并固定，已关闭则重新打开
- 大库快速解锁（1000+ 篇笔记）：WebCrypto 硬件加速 AES-GCM、IndexedDB 批量读取、搜索索引后台加载
- 全面的查找替换（Ctrl+F，可自定义）：笔记（渲染/源码模式）、表格（命中单元格高亮、支持替换）、AI 会话（逐处高亮与跳转）均可用；按下时选中的文本自动预填查找框，支持多行查询（查找栏内 Ctrl/⌘+Enter 插入换行）；全局搜索结果点击后跳转到源码视图并定位关键词
- 笔记内容区宽度可拖拽调整；左侧目录侧边栏可一键收起，为内容区腾出更大空间
- 多本地保险库（vault），解锁页可切换
- 跨库传输：验证目标库密码后，可将笔记/文件夹（含附件）复制或移动到另一个本地保险库
- **实时协作（笔记/表格）**：发起方点击标题栏「👥 协作」→ 🎲 生成随机房间号，连同线下协商的协作密码一起告知对方；双方输入相同的房间号 + 密码即可加入同一房间（随机房间号保证不同文档即使密码相同也不会互相串通）；本地没有该文档的一方新建一个**同类型**的空白文档（笔记对笔记、表格对表格）后加入，内容自动同步为会话最新内容；内容变更以 diff 增量实时互通，**文件名（标题）同样实时同步**，侧边栏对协作中的条目显示醒目的 👥 徽标，随时可退出。房间号作为盐 + 密码在本地派生房间 ID 与 AES-GCM 密钥（PBKDF2 600k），中继服务器只在内存中转发密文——不落盘、不知道密钥、看不到内容，零知识语义不变（表格合并前校验 JSON 结构，坏补丁自动回退全量重传）

**AI 工作台（可选功能，不配置则完全不启用）**
- 应用内直接与 Claude 模型对话：填入你自己的 Anthropic API key（用主密钥加密，只存在当前保险库内）
- 侧边栏可折叠的会话树，支持文件夹、重命名、拖拽整理；对话记录与笔记同级加密存储
- 流式回复 + Markdown 渲染（含 LaTeX 公式）+ 中止按钮；切换会话或切回笔记时回复在后台继续，不会中断
- 请求可携带附件：图片 / PDF / doc / docx / 文本文件（全部本地解析，8MB 上限）
- 回复过程可联网搜索（Anthropic 服务端 `web_search` 工具，客户端零新增网络连接）：实时显示"正在联网搜索"状态，单次回复搜索次数上限可在设置中调整
- 消息级管理：逐条删除、导出为 Markdown 或 Word 文档；问答（选定范围或全部）可一键转为笔记；消息显示发送/开始接收/接收完毕时间
- `max_tokens` 可在设置中调整（上限 128k）；长时间生成显示思考进度与耐心提示
- `api.anthropic.com` 是 CSP 白名单中唯一的第三方例外，且在你保存 key 并主动发消息之前不会产生任何请求
- **Android 移动版（Capacitor）**：`apps/mobile` 是聚焦 AI 助手的移动壳——加密库解锁/创建、加密 AI 会话、流式回复、附件、设置均复用同一套 packages 与库格式；移动端的"转为笔记"改为分享/复制 Markdown

**聊天（1:1 端到端加密）**
- 本地永久保存聊天记录（手动删除前不丢失），与是否登录云账号无关
- 附件收发（图片预览、文件下载，可编辑/删除，删除收到的附件需二次确认）
- 会话列表 + smart scroll（贴底自动追新 / 悬浮"新消息"提示跳转）
- 未读消息提醒：主导航红点 + 会话列表未读数 + 可配置的提示音效/音量/气泡开关
- 消息输入框支持多行文本，Shift+Enter 换行、Enter 发送

**界面**
- 五套 UI 主题（温馨/典雅/商务/清新/简洁），选中/未选中的深浅色规范贯穿主界面和解锁页；「简洁」主题为白底浅灰配色，仿 Google Docs/Sheets 默认观感，表格内容区纯白
- 笔记/表格无标题栏（重命名统一走侧边栏），表格功能栏紧凑布局、筛选栏可一键收起、表头单行紧凑显示（列名过长省略号截断）、总行数并入统计栏，尽量为内容区腾出空间
- 智能全选（Ctrl/⌘+A）：焦点不在输入框时按当前内容全选——笔记选全文、表格选所有单元格、AI 会话选整段对话，而不是全选整个软件界面
- 网络代理（设置 → 账户与同步）：桌面版可配置 HTTP / SOCKS5 代理访问服务器（含 wss 消息与协作通道），保存即生效；浏览器网页版受限于浏览器安全模型无法由页面指定代理，请配置系统/浏览器代理
- 多语言：中文/英文，可在设置中随时切换，偏好本地持久化
- 设置界面按选项卡分组：通用 / 账户与同步 / AI 助手 / 快捷键 / 存储
- 登录过期（401）自动识别：清除本地登录状态并用顶部横幅提示重新登录，不再显示虚假的已登录状态
- 桌面版原生右键菜单：剪切/复制/粘贴/粘贴并匹配格式/全选
- 内置运行日志查看器（设置按钮旁的 📋）：在内存中捕获控制台输出，桌面打包版没有 DevTools 也能查看/复制/导出日志——除非你主动导出，不会写入任何文件

**安全**
- 主密码仅用于本地派生密钥，绝不上传服务器
- 全 E2E：笔记、聊天与实时协作服务端均只见密文
- 运行时 CSP 白名单：只允许连接到你配置的服务器地址，其它任何网络目的地（包括依赖引入的）都会被浏览器直接拦截
- Electron 硬化：`contextIsolation`/无 `nodeIntegration`、拒绝所有系统权限请求、应用内链接一律用系统浏览器打开、禁用 webview

## 快速开始

```bash
# 安装依赖
corepack enable && pnpm install

# Web 版（快速验证）
pnpm dev:web

# Electron 桌面版
pnpm dev:desktop

# 自托管中继（另开终端）
pnpm dev:server
```

### 云同步验证

1. 启动中继：`pnpm dev:server`
2. Web 端解锁本地库 → ⚙ 设置 → 保存服务器 `http://localhost:8787`
3. 登录/注册（需输入本地密码验证）
4. 点击「立即同步」；另一浏览器同账号登录后可双向拉取笔记

### 聊天验证（M7）

1. 设置 → 登录账号（会上传交换公钥）
2. 切到「聊天」→ 输入对方用户名 → 发起聊天
3. 消息经密钥交换 + AEAD 端到端加密，中继只见密文

### 实时协作验证

1. 双方都登录云账号（协作经中继服务器转发，需要登录态）
2. 发起方打开要协作的笔记/表格 → 标题栏「👥 协作」→ 🎲 生成房间号 → 输入协商好的协作密码（≥6 位）→ 加入，然后把房间号和密码一起告知对方（加入后弹层内始终显示房间号）
3. 另一方新建一个**同类型**的空白文档 → 同样点「👥 协作」→ 填入对方提供的房间号和密码 → 内容自动同步为会话最新内容
4. 双方实时互通编辑；弹层内可随时「退出协作」，锁库自动断开

## 项目结构

```
apps/web        — 浏览器版（Vite + React）
apps/desktop    — Electron 桌面版（macOS / Windows / Linux）
apps/mobile     — Android 移动版（Capacitor WebView，聚焦 AI 助手的壳层）
packages/*      — Web / Electron / Android 共享的业务逻辑（crypto / storage / editor / im / sync / ui / …）
server/         — 自托管中继（Fastify + WebSocket，仅存密文）
```

所有壳层**共享** `packages/*`，只有壳层不同；桌面版额外通过 `window.fastnote` IPC 提供"选择本地数据目录"等原生能力。移动版沿用完全相同的加密库格式（Android WebView 内同样的 IndexedDB 布局），当前仅提供解锁 + AI 助手；笔记/表格/聊天/云同步暂时仍为桌面与 Web 功能。

## 构建三端

```bash
pnpm build:web       # apps/web/dist            — 静态资源，任意静态托管 + 反代皆可部署
pnpm build:desktop   # apps/desktop/dist(-electron) — Electron 渲染层 + 主进程/preload 产物
pnpm build:server    # server/dist               — 编译后的中继服务

# 或者一次性构建所有 workspace 包
pnpm build
```

### 桌面安装包（需在对应平台本机执行）

```bash
pnpm dist:mac      # macOS dmg
pnpm dist:win      # Windows nsis
pnpm dist:linux    # Ubuntu: AppImage + deb
```

### Android 移动版（Capacitor）

构建 APK 的机器需要安装 Android Studio（或至少 Android SDK + JDK 21）：

```bash
pnpm dev:mobile      # 浏览器内预览移动壳层（http://localhost:5174）
pnpm android:sync    # 构建 Web 资源并同步进 apps/mobile/android 原生工程
pnpm android:open    # 用 Android Studio 打开原生工程（在其中构建/运行/签名）
pnpm android:apk     # 或直接用 Gradle 构建 debug APK
```

**JDK 说明**：Android Gradle Plugin 要求 Gradle 运行在 JDK 17–21 上——过新的 JDK（如 26）会报 `JdkImageTransform`/`androidJdkImage` 错误。从 Android Studio 内启动的构建自动使用 IDE 自带 JDK；命令行构建（`pnpm android:apk`）如果系统默认 JDK 过新，请在**用户级** `~/.gradle/gradle.properties` 中指定受支持的 JDK（机器特定路径不要提交进仓库）：

```properties
# macOS 示例：使用 Android Studio 自带的 JBR 21
org.gradle.java.home=/Applications/Android Studio.app/Contents/jbr/Contents/Home
```

### 自托管中继部署（HTTPS）

```bash
cd server
cp .env.example .env   # 填入 JWT_SECRET（openssl rand -hex 32）
docker compose up -d   # 只监听 127.0.0.1:8787，不直接暴露公网
```

面向公网部署时，中继本身只监听本机端口，由 nginx 负责 443/80 的 TLS 终止与反向代理。完整的「和已有 nginx 站点共存 + certbot 申请/自动续期证书」步骤见 **[部署文档](docs/DEPLOYMENT.md)**，nginx 站点配置示例在 `server/deploy/nginx/fastnote.conf`（独立文件，不影响你已有的其它站点配置）。

> ⚠️ **`JWT_SECRET` 没有默认值**，`docker-compose.yml` 会在缺失时直接拒绝启动，避免生产环境不小心用了占位符导致任何人都能伪造登录令牌。

### Web 前端部署到 Vercel（可选，与上面的中继部署相互独立）

`apps/web` 的静态构建产物也可以托管到 Vercel，而不是自己找静态托管——仓库根目录的 `vercel.json` 已经适配好了 pnpm monorepo 的构建方式（`pnpm --filter @fastnote/web build` → `apps/web/dist`）。完整步骤和"为什么中继服务器本身不能部署到 Vercel"（需要长连接 WebSocket + 真实本地磁盘持久化，都不符合 Vercel 无状态 serverless/edge 模型）见 **[docs/VERCEL.md](docs/VERCEL.md)**。

### 桌面客户端发布（CI）

推送到 `publish` 分支会触发 `.github/workflows/release-desktop.yml`：并行在 macOS / Windows / Ubuntu runner 上分别构建 dmg / nsis / AppImage+deb，然后汇总发布成一个 GitHub Release（未做代码签名，macOS 首次打开需要"右键 → 打开"绕过 Gatekeeper）。

## 安全说明

- 主密码仅用于本地派生密钥，不上传服务器
- **忘记密码无法恢复数据**（严格模式）
- 服务端只见密文；笔记与聊天均为 E2E 加密
- 应用运行时受 CSP 约束，只能连接到你自己配置的服务器地址；依赖库审计详见 [Memory Bank / techContext](memory-bank/techContext.md)
- `server/data/`（本地开发时的中继运行数据）已加入 `.gitignore`，不会被提交

## 请作者喝杯咖啡 ☕

如果 FastNote 对你有帮助，欢迎请作者喝杯咖啡（完全自愿，不影响任何功能）：

- **加密货币地址（EVM 通用，支持 ETH / BNB / MATIC / USDT 等 ERC-20/BEP-20 代币）**：

  ```
  0x9bdb90629ee0967A97e7db89F44A32fe7a822117
  ```

  转账前请自行核对网络（Ethereum / BNB Chain / Polygon 等）与代币类型，转错网络可能导致资产丢失。

## License

[MIT](LICENSE) — 欢迎自行审查代码、自托管部署、二次开发。
