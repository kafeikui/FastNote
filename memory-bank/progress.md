# Progress — FastNote

## 状态总览

MVP（`docs/PHASE1.md` M1–M8）已全部完成并在 M8 之后继续做了大量体验/安全类增强。当前版本号 `0.10.0`（2026-07-13 提交，覆盖 0.9.1–0.9.4 全部本地改动 + AI 查找导航修复：AI 会话查找从消息级导航改为**逐个 `<mark>` 命中导航**（长消息 block:center 居中导致的"跳到不知道哪里"根治，↑↓ 逐处跳转、当前命中橙色高亮、流式重建 mark 不拽动视口）；server 保持 0.7.1（bodyLimit 32MB，需重新部署））。此前 `0.9.4`（2026-07-13 本地 patch，3 项：查找替换支持多行内容（查找栏改自增高 textarea，Ctrl/⌘+Enter 换行；Ctrl+F 预填保留完整多行选中；渲染模式 `findMatchesInDoc` 重写为扁平化匹配——跨段落/跨 mark 边界均可命中，hardBreak/块边界视为 `\n`）；表格/AI 会话查找高亮（表格命中单元格黄色蒙层+当前格橙色描边 `fn-table__cell--find(-current)`；AI 消息体 TreeWalker 注入 `<mark class="fn-ai-find-mark">` 文本级高亮，幂等解包重打）；表格 Enter 下移时选区焦点框跟随（补 setSelAnchor/setSelFocus））。上一版 `0.9.3`（2026-07-13 本地 patch，未提交，4 项：Ctrl+F 立即聚焦查找框且选中文本自动预填（`FindReplaceBar.focusNonce`，已打开也重新聚焦/预填）；表格支持查找/替换（`TableEditor.onRegisterFindReplace` 实现 `FindReplaceController`，出现级匹配、单格选区高亮+滚动定位、replace/replaceAll 走统一 undo，表格分支复用同一 `FindReplaceBar`）；AI 会话查找（Ctrl+F 转发 `aiFindRequest` → AiWorkbench 内置 `.fn-ai-findbar`，消息级匹配、`data-msg-idx` 滚动定位+描边高亮）；同步 413 修复（server Fastify `bodyLimit` 1MB → 32MB，需重新部署，server 版本 0.7.1；客户端 413 抛专用文案 `apiClient.payloadTooLarge`））。上一版 `0.9.2`（2026-07-13 本地 patch，未提交，3 项跟进：AI 联网搜索次数上限可在设置中配置（1–50，默认 5，`AiSettings.webSearchMaxUses` → tools.max_uses）；笔记附件改为 📎 按钮+弹窗（与表格一致，移除下方内联面板，state 更名 `showAttachmentsModal`）；多行单元格复制/粘贴 Excel 风格引号语义（`encodeCellForCopy` + `parsePasteGrid` 引号感知重写，Shift+Enter 换行的单元格复制粘贴不再拆成多行，单格全选复制自动加引号）。0.9.1 内容（7 项：AI 联网搜索（Anthropic 服务端 web_search 工具，`AiSettings.webSearch` 设置开关，流式显示"正在联网搜索（第 N 次）"，客户端零新增网络连接）；渲染模式长文查找跳转修复（rAF 后直接滚动 `.fn-find-match--active` 装饰元素）；全局搜索点击结果 → 源码视图定位关键词（`locateNoteInSource` 切分组到 source + FindReplaceBar `initialQuery` 轮询控制器）；文件夹 F2 重命名焦点修复（F2 目标 `treeAnchorIdRef ?? activeIdRef`，selectTabInGroup 同步 anchor）；同步失败详细原因入运行日志（`ApiClient.httpError` 记端点/状态/响应体，`handleSync` catch 记完整错误）；运行日志本地时间（`formatLocalTs`）；表格单元格 Shift+Enter 格内换行（cell input → 自增高 textarea））。上一版 `0.9.0`（2026-07-12 提交，覆盖 0.8.1–0.8.7 全部改动，README 中英双语功能清单已同步。0.8.7：**修复关闭公式解析导致笔记公式文本永久丢失的严重 bug**——@tiptap/markdown 默认把扩展 tokenizer 注册到 marked 全局单例且不可逆，关闭数学后 `$$` token 无处理器被静默丢弃、autosave 写盘；现给每个编辑器注入独立 `new Marked()` 实例（editor 包直接依赖 marked@^17 与 tiptap 同 major）。KaTeX 两处渲染加 `strict: false`，消除公式含中文/长破折号时的控制台警告刷屏。此前：焦点历史记录扩展——点选标签页、光标在内容区点选、打开标签页（openNoteInGroup，覆盖侧栏点选/双击/新建/导入）都记录焦点，跳转热键 focusPrev/focusNext（默认 Ctrl+Alt+←/→）加入快捷键设置可自定义。0.8.4 内容：表格分隔符多选自定义（⌗ 工具栏弹层，Tab/分号/逗号/空格，优先级取第一个出现的分列，复制用最高优先级项，localStorage 持久化）；AI 消息导出菜单——Markdown (.md) / Word 文档 (.doc，HTML+msword MIME 包装，公式保留 TeX 源码)，图片导出按用户许可搁置。0.8.3 内容：表格 Alt+方向键调序——整行 Alt+↑/↓、整列 Alt+←/→、单格与相邻格交换内容和样式（`swapRows/swapColumns/swapCells`，走统一 undo）；AI 会话"转为笔记"——全部问答或按问答组选范围，拼 markdown（角色+时间标题、附件引用、`---` 分隔）建根级笔记并打开；Ctrl+Alt+←/→ 编辑焦点历史跳转——`updateNoteById` 记录编辑 note id（去重+分支截断，上限 100），跳转目标标签页设为活跃并固定、已关闭则重新打开。0.8.2 内容：表格右键不再取消多格选区/卡住拖选状态（mousedown 只响应主键），桌面右键菜单加"粘贴并匹配格式" role；登录过期（401）识别为 `ApiAuthError` → 清除本地 session、顶部 banner 提示重新登录（不再伪装成"上传公钥失败"）；设置界面选项卡化（通用/账户与同步/AI/快捷键/存储，760px 宽，tab 栏和页脚固定、内容区滚动））。上一版 `0.8.0`（2026-07-12 提交，覆盖 0.7.1/0.7.2 及本版：表格多格复制修复 + Mod+C 兜底、桌面右键菜单（Electron context-menu + role 菜单）、AI 消息流粘性吸底滚动、响应超 30s 耐心提示、AI 回复 KaTeX 公式渲染（latexDelimiters 移入 shared + extractMathSegments）、AI 消息时间戳（发送/开始接收/接收完毕，`AiMessage.startedTs`）。此前详情：AI Workbench 消息流粘性吸底滚动（翻阅历史不被拽回底部）、响应超 30s 耐心提示（`aiRun.startedAt` + `patience/patienceThinking` i18n）、AI 回复 KaTeX 公式渲染（`latexDelimiters` 移入 shared + `extractMathSegments` 占位符抽取，MarkdownView 接入 katex）。同版本 0.7.1 改动：修复表格多格复制——去掉误伤的"单元格内文字选区让位"guard 并补 Mod+C keydown 兜底（整行/列选中时无 copy 事件可依赖，走隐藏 textarea + execCommand）；桌面端新增原生右键菜单——Electron main 进程 `context-menu` 事件按 editFlags 弹 cut/copy/paste/selectAll，role 型菜单不受渲染进程剪贴板权限全拒策略影响）。上一版 `0.7.0`（2026-07-12 提交 `959bc70`，本地开发期间曾短暂为 0.6.1 patch；本版覆盖：表格数字格式/时间插入/统计栏固定/帮助按钮/附件弹窗/取消外部滚动条、AI 附件/后台流式/消息删除导出/超时与思考流加固/max_tokens 设置化（上限 128k）/模型列表更新、桌面打包 npmRebuild 修复、内容区最大宽度 2400px。此前 0.6.1 的 7 项详情：表格粘贴不再按逗号分列、公式/统计支持千分位逗号数字（`parseNumericValue`）、列数字格式 number/currency/小数位（`TableColumnFormat`，仅显示层格式化，原始值不变）、🕒 一键插入本地时间；AI 请求附件（图片/PDF 原生 content block，docx 用 fflate 本地解压提取文本，旧版 .doc 启发式 UTF-16LE 提取，8MB 上限）、流式回复上提到 VaultApp（切 session/切视图不中断，单并发 + busy 提示）、消息逐条删除/导出 md。顺手修复 `apps/desktop/tsconfig.json` 缺 `@web/*` paths 导致的 typecheck 报错，全仓 typecheck 现全绿。上一版 `0.6.0`（2026-07-10 bump，覆盖：AI Workbench（Claude 对话，加密会话树 + API key 库内加密）、跨密码库文件传输/移动、笔记查找替换（Ctrl+F 双模式）、渲染工具栏 prompt 失效修复，以及随后的 6 项反馈——AI 面板置顶固定、AI 回复渲染/源码切换、AI/笔记快速切换按钮、渲染模式查找失效修复、Ctrl+点击链接开系统浏览器、绿点仅云登录显示；此前 0.2.0 → 0.5.0 历史见下方清单与 `activeContext.md`）。**桌面打包脚本已修复**：`apps/desktop` 的 `dist:mac`/`dist:win`/`dist:linux`/`pack`/`dist` 原来只跑 `electron-builder`、直接打包上一次遗留的 `dist/` 产物（不重新构建），导致打出的包不含最新代码；现在全部改为 `pnpm build && electron-builder ...` 先重建再打包（CI workflow 本来就先跑 build，不受影响）。Web 前端有 Vercel 部署方案（`vercel.json` + `docs/VERCEL.md`），与自托管中继服务器（`docs/DEPLOYMENT.md`）完全独立、互不影响。

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
- **标签页系统（2026-07，0.3.0）**：固定两分组分栏视图；标签拖拽排序/关闭/预览(斜体)与固定(双击)两种模式；按 vault 持久化；分组分隔条可拖拽；锁定后固定标签保留
- **侧边栏增强（2026-07，0.3.0/0.4.0）**：展开/折叠全部、按名称/修改时间排序（破坏性重写 sortOrder）、宽度实时拖拽、定位文件（搜索/选标签自动展开+滚动+高亮）、Ctrl/Shift 多选 + Del 删除、拖拽自动滚动、新建/导入按焦点层级创建、工具栏 sticky、图标严格对齐
- **编辑器增强（2026-07，0.3.0/0.4.0）**：KaTeX 数学公式（默认关闭、设置可开，`latexDelimiters.ts` 兼容裸括号与 `%` 转义）、行号、Ctrl+D 删行、Alt+Up/Down 换行、JSON 格式化（选中/全文）、选中字符计数、空行保留（`blankLines.ts`）、单笔记导出明文 markdown、标题/工具栏/标签栏 sticky
- **表格大改造（2026-07，0.4.0）**：Excel 式下拉填充与智能粘贴（`fill.ts`）、撤销/恢复（快捷键可自定义）、行高列宽拖拽、固定表头/首列、单元格加粗/字号/字色/填充色（`TableCellStyle`）、行删除按钮左置+确认对话框（F4 重复免确认）、第一行提升为表头、选区非空计数、常驻横向滚动条
- **快捷键系统（2026-07，0.4.0）**：`ShortcutBindings`（重命名 F2、上锁 Ctrl+L、表格重复 F4、表格撤销/恢复、删除选中 Del），设置面板可自定义
- **硬删除架构（2026-07，0.4.0）**：本地库直接硬删；云库轻量墓碑（清空明文）→ 推送 `deleted: true` → 本地 purge；解锁跳过墓碑行
- **解锁/上锁性能优化（2026-07-09）**：WebCrypto 原生 AES-GCM（与 noble 线格式兼容，已验证互解）、IndexedDB `getAll()` 批量读取 + 24 篇并行解密、~16ms 时间片 yield + 进度条、搜索快照新鲜度指纹（命中跳过 MiniSearch 全量重建）、索引 dirty 标记（上锁无变化跳过快照保存）；第二轮把网络请求（盐值回填/IM 握手）、聊天历史解密、搜索索引准备（`loadJSONAsync`/`addAllAsync` 分块后台构建 + 编辑重放队列）全部移出解锁关键路径，DB v5 加 `by_deleted` 索引让 `purgeDeleted` 只取键；1000+ 篇笔记实现秒开（用户确认）
- **内置日志查看器（2026-07-09）**：`packages/shared/logBuffer.ts` 内存环形缓冲捕获 console 输出（上限 2000 条，不落盘）+ `LogsModal` 弹窗（复制/导出 .txt/清空），右上角 📋 按钮打开——桌面打包版无 DevTools 也能查看解锁耗时日志和报错
- **AI Workbench（2026-07-10）**：新包 `packages/ai`（`AnthropicClient` SSE 流式直连 api.anthropic.com，CSP 三处放行——唯一第三方例外，仅用户配置 key 后才有流量）；API key/模型 masterKey 加密存 `vault_meta`（`META_KEYS.aiSettings`）；DB v6 新增 `ai_sessions_local`（notesKey 加密会话树：文件夹 + 会话，payload 为完整消息数组）；侧栏可折叠"AI 助手"分区（`AiSessionTree`：嵌套文件夹/新建/重命名/删除/拖拽移动）+ `AiWorkbench` 主界面（流式渲染、可中止、`MarkdownView` = marked + dompurify）
- **跨库传输/移动（2026-07-10）**：NoteTree 行级 ⇄ 按钮（含多选批量）→ `VaultTransferModal`（目标库 + 密码验证 + 复制/移动）→ 子树收集去重、全新 UUID、parentId 重映射、附件目标库重加密 + `fnattach:` 引用重写；移动 = 复制后走 `handleDeleteMany`
- **查找替换（2026-07-10）**：`findInNote` 快捷键（默认 Ctrl+F，可自定义）；共享 `FindReplaceBar`（计数/上下个/替换/全部替换/Esc）；源码模式 `@codemirror/search` 程序化驱动（吞掉 CM 自带 Mod-f 面板）；渲染模式自研 ProseMirror 插件（`FindReplaceExtension`，Decoration 高亮，匹配不跨节点）
- **渲染工具栏 prompt 修复（2026-07-10）**：链接/公式插入与公式点击编辑全部改为 `InlineInputBar` 内联输入（Electron 下 `window.prompt` 返回 null 不可用——项目约定禁止 prompt）

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

1. ~~`packages/im`、`packages/sync`、`packages/table` 缺少 `tsconfig.json`~~ **已修复（2026-07-09）**：三个包都已补上标准 `tsconfig.json`，typecheck 通过。
2. **`apps/desktop` 独立 `pnpm typecheck` 报 `@web/App` 找不到**（路径别名只在 Vite 构建时生效，`tsc --noEmit` 单独跑时未配置该别名）——现在是 `pnpm -r typecheck` 唯一剩余的失败项。
3. **`server` 默认 `JWT_SECRET` 是明文占位符**，生产部署必须显式覆盖，目前只在文档里提示，没有启动时的强校验/警告。
4. **主 JS bundle 体积较大**（~1.46MB，gzip ~480KB），Vite 已给出分包建议，尚未实施代码分割。
5. **群聊、加密文件传输（聊天里更大的文件）、多设备 Ratchet 同步优化**——按 `docs/PHASE1.md` Phase 2 预留，明确不在当前范围。

## Phase 2 候选（未开始）

- 群聊
- 聊天文件传输（超出当前 32MB WebSocket 单帧限制的场景，需要分片）
- 多设备间 Ratchet 状态同步
- TLS 证书固定、更完整的安全审计
