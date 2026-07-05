# Progress — FastNote

## 状态总览

MVP（`docs/PHASE1.md` M1–M8）已全部完成并在 M8 之后继续做了大量体验/安全类增强。仓库已有首次提交（"first commit"），当前版本号 `0.2.0`（2026-07-05 从 `0.1.0` bump，覆盖本文件下方"体验增强"里列出的所有新功能）。Web 前端新增了 Vercel 部署方案（`vercel.json` + `docs/VERCEL.md`），与自托管中继服务器（`docs/DEPLOYMENT.md`）完全独立、互不影响。

## 已完成 — 核心功能（MVP）

- Monorepo 骨架、TypeScript 严格模式、`packages/shared` 类型层
- 密码解锁 + 密钥派生 + 严格模式（无恢复码）
- 本地存储（IndexedDB，Web/Electron 统一）
- 笔记树（folder/note CRUD、拖拽排序、多级目录）
- 编辑器：Tiptap WYSIWYG ↔ CodeMirror 源码模式双向切换，autosave 防抖
- 本地全文搜索（MiniSearch + 加密快照）
- 自托管中继服务端（Fastify + WebSocket），注册/登录 API
- 笔记云同步（push/pull、manifest、冲突标记为"冲突副本"）
- 1:1 端到端加密聊天（密钥交换 + AEAD，服务端只见密文）
- Electron 打包（macOS dmg / Windows nsis / Linux AppImage+deb）

## 已完成 — 体验增强（MVP 之后新增）

- **聊天体验**：本地永久历史（可手动删除）、附件（图片预览/文件下载，可编辑删除、不可拖拽）、左侧会话侧栏、smart scroll（贴底自动滚 vs. 悬浮"新消息"提示跳转）、收发双方附件均可见、二次确认删除收到的附件、修复"删除后再次添加同一附件不显示"的 bug
- **未读与通知**：主导航"聊天"图标红点未读数、会话列表逐条未读数、设置里可配置气泡开关+音效开关+音效种类（chime/bell/pop/soft）+音量，带试听按钮
- **多保险库 / 解锁页**：支持多个本地保险库切换；云登录会校验用户名是否与保险库绑定匹配，不匹配则拒绝登录；解锁页"选中深色/未选中浅色"的视觉规范（深色为主题色的深色变体，不是纯黑）
- **UI 主题**：温馨/典雅/商务/清新四套主题，`data-theme` 属性 + CSS 变量实现，覆盖主界面工具栏和解锁页
- **保险库改名**：解锁后可在设置里编辑当前保险库名称
- **笔记批量导入**：整个文件夹拖入/选择导入，保留目录结构；无扩展名文件当笔记导入，`.csv` 当表格导入，其它类型跳过并统计
- **可调节布局**：笔记内容区宽度可拖拽调整并持久化；设置弹窗内容溢出时可滚动
- **大文件/大附件修复**：`toBase64` 分块处理避免 `btoa` 对超大 `Uint8Array` 报错；服务端 WebSocket `maxPayload` 提到 32MB
- **数据健壮性**：`decodeChatWire` 对不完整/畸形附件做归一化校验（`normalizeWireAttachment`）；`listChatMessagesDecrypted` 在消息 payload 缺失附件引用时会回查 `chat_attachments_local` 兜底
- **隐私/安全加固（2026-07）**：
  - 全仓依赖与网络调用审计（无遥测/自动更新/硬编码外部域名）
  - 运行时 CSP：`packages/shared/src/csp.ts` 动态放行"用户自己配置的服务器"，`index.html` 静态基线 CSP 兜底脚本加载前的窗口期
  - Electron 主进程硬化：拒绝所有权限请求、拦截应用内导航与 `window.open`（改用系统默认浏览器打开外链）、禁用 webview
- **国际化 i18n（2026-07）**：新增 `packages/i18n`（自研，无第三方库），支持中文/英文；`SettingsModal` 内可切换，语言偏好持久化到 `localStorage`；`VaultApp`/`ui`/`editor`/`table`/`api` 全面接入 `t()`/`translate()`，详见 `systemPatterns.md` §10
- **README 双语化 + 赞助（2026-07）**：`README.md` 改为英文主版本，原中文内容移至 `README.zh-CN.md`，两者互相链接；均新增"请作者喝杯咖啡"章节（EVM 兼容加密货币地址）
- **侧边栏可收起（2026-07）**：`AppShell` 新增 `sidebarCollapsed`/`onToggleSidebar`，侧边栏与内容区之间加一个常驻的折叠/展开小按钮；折叠状态持久化到 `localStorage`（`fastnote_sidebar_collapsed`，`packages/api` 的 `loadSidebarCollapsed`/`saveSidebarCollapsed`），折叠后内容区自动占满剩余宽度
- **表格公式与统计（2026-07）**：`packages/table/src/formula.ts` 新增轻量公式引擎（递归下降解析器），支持 `+ - * / ^`、括号、单元格引用（如 `B3`）、区域引用（如 `B2:B10`）、`SUM`/`AVERAGE`/`COUNT`/`MIN`/`MAX` 函数，公式以 `=` 开头存入单元格原始值，编辑态显示公式原文、失焦显示计算结果；列/行采用**稳定编号**（基于 `doc.columns`/`doc.rows` 数组下标，不随排序/筛选改变，避免公式引用错位）；`TableEditor` 新增行号列 + 列字母表头，支持拖拽/整行/整列三种方式选中区域，并在下方展示选区的计数/求和/平均值统计条
- **解锁页焦点修复（2026-07）**：切换服务器地址/加密库标签目录后不再用 `window.alert()`（Electron 下会造成焦点陷阱），改为 `confirm()` + `location.reload()`
- **笔记内附件拖拽修复（2026-07）**：`EmbeddedAttachmentChip` 的拖拽手柄 `stopPropagation` 改为只在表格传入 `onDragStart` 时才生效，不再误伤笔记编辑器里 ProseMirror 原生的整节点拖拽
- **聊天送达/已读回执（2026-07）**：`packages/im` 新增 `delivery_ack`/`read_ack` 处理与 `sendReadAck()`；服务端 WebSocket 层实时转发两种 ack 给发送方在线连接，`delivery_ack` 顺带清理 `message_queue`；`ChatPanel` 气泡展示送达/已读状态图标
- **批量导入 .txt + 新建/导入下拉菜单（2026-07）**：无扩展名文件与 `.txt` 均当笔记导入；新增可复用的 `packages/ui/src/DropdownMenu.tsx`，工具栏"新建"“导入”改为下拉菜单，并新增单文件导入（笔记/表格）入口
- **聊天历史云同步（2026-07）**：新增服务端 `chat_blobs` 存储 + `PUT/GET /api/v1/sync/chat`；`packages/storage` 的 `StoredChatRow` 加 `synced` 标记；`SyncClient.syncChatMessages()` 用 push-once/pull-if-missing 简化模型（消息视为不可变，无版本冲突机制）同步聊天历史，登录云账号新设备后可看到历史聊天记录
- **数据存储位置说明（2026-07）**：设置面板"数据目录"更名为"加密库标签目录"并明确其只是标签、不写文件；新增 Electron `getUserDataPath`/`openUserDataFolder` IPC，展示并可一键打开真正保存加密数据的 `userData` 目录（Chromium IndexedDB 存储位置）
- **聊天勾选状态修正 + 新建/导入下拉修复 + 强制导入（2026-07）**：`ChatPanel` 送达/已读勾选逻辑修正为"已读才是双对勾"；`DropdownMenu` 关闭菜单的时机从 `onClickCapture` 改为 `onClick`（冒泡），修复点击菜单项没反应的问题；"导入笔记文件"/"导入文件夹"新增"强制导入（忽略扩展名）"选项
- **Vercel Web 前端部署方案（2026-07）**：新增仓库根 `vercel.json`（pnpm monorepo 构建适配）+ `docs/VERCEL.md`；明确中继服务器不适合部署到 Vercel（需要长连接 WebSocket + 本地磁盘持久化），只有 `apps/web` 静态前端托管在 Vercel，两者通过用户自己配置的服务器地址 + 已开放的 CORS 互联
- **版本号 bump（2026-07）**：全部 workspace 包 `0.1.0` → `0.2.0`

## 进行中 / 本次会话任务

- [x] 更新 `.gitignore`（排除 `server/data/`、`.npmrc`、`*.tsbuildinfo` 等不该上传的本地/运行时内容）
- [x] 建立 Memory Bank（本文件所在目录）
- [x] 更新 `README.md`
- [x] 构建 Web / Electron 桌面 / 服务端三端产物
- [x] HTTPS 部署方案：`docs/DEPLOYMENT.md` + `server/deploy/nginx/fastnote.conf` + `server/.env.example` + `docker-compose.yml` 改为只监听本机、强制要求 `JWT_SECRET`
- [x] `.github/workflows/release-desktop.yml`：`publish` 分支触发，Mac/Windows/Ubuntu 三端构建并汇总发布 GitHub Release
- [x] i18n 基础设施 + 全面接入（`packages/i18n` 新增，`ui`/`app`/`editor`/`table`/`api` 改造）
- [x] 更新过时文档：`docs/ARCHITECTURE.md`/`docs/DATABASE.md`/`docs/PROTOCOL.md`/`docs/PHASE1.md`（修正存储引擎、IM 加密方案、真实 API/数据 schema 等与实现不符之处）
- [x] README 英文主版本 + `README.zh-CN.md` 中文版 + 咖啡赞助地址
- [x] 侧边栏收起/展开（`AppShell` + `VaultApp` + `localStorage` 持久化）
- [x] 表格公式引擎 + 列/选区统计条（`packages/table/src/formula.ts` + `TableEditor` 行号/列字母/区域选择）

## 已知问题 / 技术债

1. **`packages/im`、`packages/sync`、`packages/table` 缺少 `tsconfig.json`**，导致 `pnpm -r typecheck` 失败在这几个包上（不影响实际构建，只影响 typecheck 质量门禁）。
2. **`apps/desktop` 独立 `pnpm typecheck` 报 `@web/App` 找不到**（路径别名只在 Vite 构建时生效，`tsc --noEmit` 单独跑时未配置该别名）。
3. **`server` 默认 `JWT_SECRET` 是明文占位符**，生产部署必须显式覆盖，目前只在文档里提示，没有启动时的强校验/警告。
4. **主 JS bundle 体积较大**（~1.46MB，gzip ~480KB），Vite 已给出分包建议，尚未实施代码分割。
5. **群聊、加密文件传输（聊天里更大的文件）、多设备 Ratchet 同步优化**——按 `docs/PHASE1.md` Phase 2 预留，明确不在当前范围。

## Phase 2 候选（未开始）

- 群聊
- 聊天文件传输（超出当前 32MB WebSocket 单帧限制的场景，需要分片）
- 多设备间 Ratchet 状态同步
- TLS 证书固定、更完整的安全审计
