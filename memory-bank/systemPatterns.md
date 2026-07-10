# System Patterns — FastNote

## Monorepo 结构（pnpm workspaces）

```
FastNote/
├── apps/
│   ├── web/                 # Vite + React 浏览器版壳层
│   └── desktop/             # Electron 壳层（主进程 + 复用 web 一样的 React 渲染层）
├── packages/
│   ├── shared/               # 跨包类型定义、常量、纯函数工具（含 CSP 构建）
│   ├── crypto/               # 密钥派生 / AES-GCM / X25519 等原语封装（@noble/*）
│   ├── storage/              # IndexedDB 适配层（idb），Web/Electron 共用同一实现
│   ├── search/               # MiniSearch 封装的本地全文索引
│   ├── sync/                 # 笔记云同步客户端（push/pull manifest + notes）
│   ├── im/                   # 聊天协议客户端（WebSocket 封装、消息编解码、重连）
│   ├── editor/               # Tiptap（WYSIWYG）+ CodeMirror（源码模式）封装
│   ├── table/                # 表格文档模型、CSV/.fnxt 导入导出
│   ├── api/                  # HTTP ApiClient + 所有 localStorage 设置的读写函数
│   ├── i18n/                 # 中/英文词典、I18nProvider、useT()/useLocale() hook、语言持久化（2026-07 新增）
│   ├── ai/                   # AnthropicClient：Claude Messages API 直连 + SSE 流式解析（2026-07-10 新增，唯一的第三方网络包）
│   ├── app/                  # VaultApp：整个应用的顶层状态机和业务编排（最大的包）
│   └── ui/                   # 纯展示型 React 组件（NoteTree、ChatPanel、SettingsModal…）
└── server/                    # 自托管中继：Fastify + WebSocket + JSON 文件存储
```

**依赖方向**：`app` 依赖几乎所有其它 package，是唯一的"编排层"；`ui` 是纯组件，不直接访问 storage/api，靠 props 回调与 `app` 通信；`ui`/`editor`/`table`/`app`/`api` 都直接依赖 `i18n` 做文案翻译；`shared` 和 `i18n` 是所有包共同的底座，不依赖任何其它内部包。

## 关键架构模式

### 1. 壳层与业务逻辑分离

`apps/web` 和 `apps/desktop` 的 `App.tsx` 几乎是空壳，只 `return <VaultApp />`。所有状态管理、数据流、业务规则都在 `packages/app/src/VaultApp.tsx` 里（目前 ~1650 行，是全仓最大的单文件——後续如果继续膨胀，应考虑拆分成多个 hook/context）。这样 Web 和 Electron 天然保持行为一致，桌面壳层只额外提供"选择本地数据目录"这类原生能力（通过 `window.fastnote` IPC bridge）。

### 2. 本地存储：统一 IndexedDB，不做 Electron/Web 差异化

> 与 `docs/ARCHITECTURE.md` 中"Electron 用 better-sqlite3"的原始设计不同——**实际实现里 Electron 和 Web 都用 `idb`（IndexedDB 封装）**，因为 Electron 的渲染进程本身就是 Chromium，可以直接用 IndexedDB。桌面版的"选择数据目录"功能（`electron/settings.ts`）目前只影响需要落盘的辅助设置，不是笔记数据本身的存储引擎。这个简化减少了两条代码路径的维护成本。

`packages/storage/src/index.ts` 是唯一的存储适配层：负责保险库命名空间（不同 vault → 不同 IndexedDB 数据库名）、笔记/表格/聊天消息/聊天附件/通用附件等 object store 的 CRUD，以及必要时的解密读取（`listChatMessagesDecrypted` 等函数名里的 "Decrypted" 后缀表示这一层会做密文→明文转换后再返回给上层）。

### 3. 密钥体系（详见 `docs/ARCHITECTURE.md` §4，实现未变）

```
用户主密码 → Argon2id/HKDF 派生 → 主密钥 MK（仅内存）
  ├─ notes_key   → 笔记/表格内容 AES-256-GCM
  ├─ index_key   → 搜索索引快照 AES-256-GCM
  └─ identity/exchange keypair → 聊天密钥交换
```

严格模式：无 MK 无法解密任何东西；不做恢复码/后门。

### 4. 设置持久化的两层结构

- **`localStorage`**：纯 UI 偏好和不敏感的会话态——服务器地址、UI 主题、聊天通知设置（音效/音量/气泡开关）、未读计数、笔记内容区宽度、保险库注册表。全部集中在 `packages/api/src/index.ts` 里以 `loadXxx`/`saveXxx` 命名对的函数导出。
- **IndexedDB（加密）**：真正的用户内容——笔记树、表格、聊天消息、附件。

新增任何一项持久化设置时的**约定模式**：在 `packages/api/src/index.ts` 加一对 `loadXxx()`/`saveXxx()` 函数 + 必要的类型/常量导出，`VaultApp.tsx` 用 `useState(() => loadXxx())` 初始化 state，变更时调用 `saveXxx()`，需要跨闭包读最新值时用 `useRef` 镜像（参见 `chatNotifyRef`、`activePeerRef` 等模式）。

### 5. 聊天：本地持久化 + 云中继双轨

聊天消息**本地永久保存**（除非用户手动删除），与是否登录云账号无关。登录后，`packages/im` 通过 WebSocket 连接自托管中继实时收发，离线消息走 HTTP 轮询补拉（`pullPendingMessages`）。收发的 wire payload 用 `packages/shared/src/chatPayload.ts` 编解码，并做了防御性校验（`normalizeWireAttachment`）避免损坏数据导致渲染异常。

### 6. 未读计数 / 通知：ref 镜像 + localStorage 双工

`VaultApp` 用 `appViewRef` / `activePeerRef` / `chatNotifyRef` 三个 ref 让 `useCallback` 包裹的 `processIncomingChat` 能读到"此刻"的 UI 状态（当前在哪个会话、通知设置是什么），而不需要把这些回调重新绑定。未读数与通知设置都持久化到 `localStorage`，页面刷新后仍保留。

### 7. Content-Security-Policy 作为运行时网络白名单（2026-07，07-04 修正引导方式）

`packages/shared/src/csp.ts` 的 `buildContentSecurityPolicy(serverUrl)` 根据用户当前配置的服务器地址生成 CSP 字符串，只放行 `'self'` + 该服务器的 HTTP(S)/WS(S) 源。

**重要教训**：浏览器只在 HTML 解析阶段应用一次 `<meta http-equiv="Content-Security-Policy">`，之后无论用 JS 怎么修改/重新插入这个 `<meta>` 标签都会被 CSP 引擎忽略（DOM 节点本身会更新，但不会重新生效）。最初的实现在 `VaultApp` 的 `useEffect` 里调用 `applyContentSecurityPolicy(serverUrl)` 更新已存在的 meta 标签，这**完全不起作用**——`connect-src` 永远停留在 `index.html` 静态基线的 `'self'`，导致连接用户自己配置的本地/远程服务器都会被拦截。现已改为：`apps/web/index.html` 和 `apps/desktop/index.html` 顶部各放一段内联、非 module 的 `<script>`，在解析到此处时同步读取 `localStorage.fastnote_server_url`（取不到则回退默认值 `http://localhost:8787`），算出策略后用 `document.write()` 写入 `<meta>`——这发生在解析任何其他资源标签之前，因此能真正生效。运行时改地址（设置面板/解锁页云同步）无法让已生效的策略变宽，`serverUrlNeedsReload()` 检测到这种情况后会提示用户刷新页面（`packages/app/src/VaultApp.tsx` 的 `commitServerUrl`）。CSP 里也去掉了 `frame-ancestors`（通过 `<meta>` 传递时规范规定必须忽略，写了只会在控制台产生噪音警告；真正的防点击劫持需要在服务静态资源的 Web 服务器上设置 HTTP 响应头）。Electron 主进程额外加了权限请求拒绝、导航拦截、禁用 webview 等硬化措施（`apps/desktop/electron/main.ts`）。

**这是一个强约束**：以后如果要接入任何新的第三方网络服务（字体 CDN、图床、AI API 等），必须同步更新 `csp.ts` 和两份 `index.html` 里的引导脚本，否则浏览器会直接拦截请求——这是刻意设计的摩擦，用来防止"顺手"引入非自托管的外部依赖。

**唯一的功能性例外（2026-07-10，用户明确要求）**：`https://api.anthropic.com` 已在三处 CSP 中静态放行，供 AI Workbench（`packages/ai`）直连 Claude Messages API。只有用户在设置里主动保存 Anthropic API key 并发送消息时才会产生流量；key 用 masterKey 加密存 `vault_meta`，锁定后不可读。

### 8. 服务端持久化：JSON 文件存储，非直接 SQLite 表

`server/src/store.ts` 的 `JsonRelayStore` 实际用 JSON 文件（`data/relay.json`）做持久化（配合 `data/relay.db.bak` 之类的历史/迁移文件，见 `server/src/migrate.ts` 做旧格式迁移）。`sql.js` 依赖存在于 `server/package.json`，主要用于迁移/兼容旧数据，不是主存储路径。这个数据目录默认是 `./data`（`DATA_DIR` 环境变量可覆盖），**已加入 `.gitignore`**，因为里面是真实的（哪怕是密文的）用户数据。

### 9. UI 主题：CSS 变量 + `data-theme` 属性

`document.documentElement` 上设置 `data-theme` 属性（warm/elegant/business/fresh），配合 `apps/web/src/styles.css` 里针对每个主题定义的 `--accent-dark` / `--on-accent-dark` 等变量，实现"选中深色、未选中浅色"的统一交互反馈，同时保留每个主题自己的色相（不是简单地用黑/白兜底）。解锁页和主界面共用同一套变量。

### 10. i18n：自研轻量方案，无第三方库（2026-07 新增）

刻意没有引入 `react-i18next`/`formatjs` 等第三方 i18n 库（延续"最小依赖 + 隐私优先"的产品原则），而是在 `packages/i18n` 里手写了一套最小实现：

- **词典**：`locales/zh.ts` 是权威源（`as const` 字面量类型，按功能域分命名空间，如 `noteTree.*`/`chatPanel.*`/`settingsModal.*`），`locales/en.ts` 结构对齐。为了让 `en.ts`（普通 `string`）能结构性兼容 `zh.ts`（字符串字面量类型）的类型，`zh.ts` 里定义了一个递归映射类型 `DeepStringRecord<T>` 把所有叶子字符串字面量类型放宽成 `string`，`Dictionary = DeepStringRecord<typeof zh>`。
- **纯函数核心**：`translate(locale, key, vars?)` 做 dot-path 查找（如 `'unlock.hint.selectVault'`）+ `{var}` 占位符插值；查不到时按 `locale` 回退到中文兜底，而不是抛错或显示 key 本身（除非中文里也没有，此时才原样返回 key）。
- **React 集成**：`I18nProvider`（持有当前 `locale`）+ `useT()`（返回绑定好 locale 的 `t` 函数）+ `useLocale()`；`VaultApp.tsx` 是唯一的 Provider 挂载点，`locale` state 用 `loadLocale()`/`saveLocale()` 读写 `localStorage`（key `fastnote_locale`），未设置时按 `navigator.language` 自动探测（`zh-*` → 中文，其它 → 英文）。
- **非组件场景**：像 `packages/table/src/utils.ts`（CSV/`.fnxt` 导入导出的错误提示、默认列名）、`packages/api/src/index.ts` 的 `ApiClient`（HTTP 错误提示）这类不在 React 渲染树里的纯函数/类，**不使用 hook**，而是显式接受一个 `locale: Locale` 参数（默认 `'zh'`），内部直接调用 `translate()`。这是本项目里"组件用 hook、工具函数传参数"这条约定的第一个也是目前唯一的例外来源。
- **已知取舍**：极少数发生在 `useState` 初始化阶段、`locale` 状态本身还不可用的边缘调用（例如 `VaultApp.tsx` 里 `ensureLegacyVaultInRegistry()` 在 `useState` initializer 里的调用）会硬编码走中文兜底，未做进一步重构——影响面仅限于极少数遗留库迁移时生成的默认显示名称。
- **新增语言**：加一个 `locales/xx.ts`（对齐 `Dictionary` 类型）+ 在 `index.ts` 的 `LOCALES`/`LOCALE_LABELS`/`DICTIONARIES` 里注册即可，`SettingsModal` 的语言选择器会自动出现新选项，无需改动其它组件。

### 11. 侧边栏可收起：`AppShell` 承载折叠状态，`VaultApp` 负责持久化（2026-07 新增）

`AppShell`（`packages/ui/src/AppShell.tsx`）新增可选的 `sidebarCollapsed`/`onToggleSidebar` props，在侧栏与内容区之间渲染一个常驻的折叠/展开小按钮（不依赖侧栏内部实现，`NoteTree`/`ChatSidebar`/搜索结果列表都共用同一个 `sidebar` slot，无需各自实现折叠逻辑）。侧栏内容始终挂载在 DOM 里（`fn-sidebar__content` 固定 280px 宽度），折叠时只是外层 `<aside>` 宽度收到 0 + `overflow: hidden`，这样折叠/展开不会丢失 `NoteTree` 的滚动位置或展开状态。折叠偏好持久化在 `localStorage`（`fastnote_sidebar_collapsed`，`packages/api` 的 `loadSidebarCollapsed`/`saveSidebarCollapsed`，与 `noteWidth` 同样的 load/save 命名对约定）。

### 12. 表格公式引擎：稳定行列编号 + 递归下降解析器（2026-07 新增）

`packages/table/src/formula.ts` 是一个独立的、不依赖 UI 的纯函数模块：

- **列/行编号必须稳定**：列字母（`columnLetter`）基于 `doc.columns` 数组下标，行号基于 `doc.rows` 数组下标——都不是当前显示顺序（`displayRows` 会因排序/筛选而变化）。这是刻意设计：如果编号跟着视图变，用户排序表格后所有公式引用的含义会静默改变，属于危险的 bug 来源。代价是排序后显示的行号可能看起来不连续（这与 Excel"排序即改变物理行序"的行为不同，因为本项目的排序/筛选是纯展示层操作，不修改 `doc.rows` 本身）。
- **公式即字符串**：单元格原始值以 `=` 开头即视为公式（`isFormulaValue`），存储和普通文本一样是 `TableRow.cells[colId]` 里的字符串，不需要额外的 schema 字段。`TableCellContent` 编辑态（focus）显示公式原文，失焦显示 `evaluateCellFormula` 算出的结果，方式类似电子表格"点击显示公式、看结果需要失焦"。
- **递归求值 + 环检测**：单元格可以引用另一个公式单元格，`resolveCellOrNull` 用一个 `visiting: Set<"rowId:colId">` 做环路检测，检测到自身或间接循环引用会抛 `#CIRCULAR!`，而不是死循环/栈溢出。
- **两种数值解析路径**：直接算术引用（如 `A1+A2`）用 `resolveCellStrict`，非数字/空单元格会报 `#VALUE!`；聚合函数（`SUM`/`AVERAGE`/`COUNT`/`MIN`/`MAX`）用 `resolveCellOrNull`，静默跳过非数字/空单元格（贴近多数电子表格软件里 `SUM` 忽略文本的习惯）。
- **选区统计条与公式引擎共享同一套解析逻辑**：`TableEditor` 的拖拽/整行/整列选择只是收集 `{rowId, colId}` 列表交给 `computeRangeStats`，内部同样调用 `resolveCellOrNull`（包括递归求值公式单元格），因此选中一段包含公式的区域时统计条里的计数/求和/平均值也是"计算后的值"而不是原始字符串。
- **加公式函数**：只需要在 `formula.ts` 里给 `SUPPORTED_FUNCTIONS` 加名字 + 在 `applyFunction` 里加一个 `case`，`Parser.parseFunctionCall` 会自动识别（函数名后紧跟 `(` 就走函数调用分支，否则按单元格引用 `[A-Z]+[0-9]+` 解析）。

### 13. 解锁/上锁性能模式：原生加解密 + 批量读取 + 快照指纹（2026-07-09 新增）

1000+ 篇笔记的库解锁曾出现秒级卡顿，根因和对策（都已落地）：

- **加解密热路径必须走 WebCrypto 原生 AES-GCM**（`packages/crypto` 的 `encryptNative`/`decryptNative`/`*StringNative`），与 noble 纯 JS 实现线格式完全一致（12B nonce + 密文尾部 16B tag），新旧数据互解无需迁移。`CryptoKey` 用 `WeakMap` 按原始密钥 `Uint8Array` 对象缓存，避免每篇笔记重复 `importKey`。**约定**：新增批量加解密场景一律用 native 版本；一次性/低频场景（如密钥包装）可继续用 noble 同步版本。
- **IndexedDB 禁止在循环里逐条 `get()`**：`StorageAdapter.loadAllNotesDecrypted()` 用一次 `getAll()` 拉全表再内存过滤墓碑行，按 24 篇一批 `Promise.all` 并行解密，配 ~16ms 时间片 yield（`performance.now()` 预算 + `setTimeout(0)`）让解锁进度条能重绘。
- **搜索快照指纹**：快照（`vault_meta.search_index_snapshot`，`indexKey` 加密）旁边存一份 `search_index_fingerprint` = SHA-256(所有非删除笔记 `id:version` 排序 join)。解锁时指纹一致 → 直接反序列化快照、**跳过 MiniSearch 全量重建**；不一致（异常退出等）→ 全量重建兜底。指纹只含随机 UUID 和版本号（本就明文存在 IndexedDB 行内），**不泄露任何明文内容**——这个项目里任何落盘的新数据都必须过这道"是否泄露明文"的审查。
- **索引 dirty 标记**：`VaultApp.searchDirtyRef`，所有索引变更点置 true，`saveSearchSnapshot` 在非 dirty 时整体跳过（序列化+加密+写入）；同步后只在 `pulled > 0 || conflicts > 0` 时才 rebuild。
- **解锁关键路径上禁止网络 `await`**：`fetch` 没有配超时，服务器不可达时一个被 `await` 的请求就能把解锁挂几十秒。盐值回填、聊天历史解密、IM 握手都放在 `loadNotes` 返回后的后台 async IIFE 里跑（保持原顺序，`keysRef.current !== derived` 时中止防止上锁后污染状态）。**约定**：解锁必需的只有"笔记 + 标签页恢复"，其它一律后台化。
- **搜索索引准备也不在关键路径上**：快照因 `storeFields` 存了全部正文，几十 MB 的 `MiniSearch.loadJSON()` 同步反序列化和全量重建一样是数秒级。`prepareSearchIndexInBackground` 用 `loadJSONAsync`/`addAllAsync` 分块后台构建；期间的 upsert/remove 进 `pendingSearchOpsRef` 队列、就绪后重放；`searchGenRef` 代际守卫防交错；`saveSearchSnapshot` 在索引未就绪时拒绝写盘（宁可让下次解锁走重建兜底，也不能把空索引+新指纹持久化）。
- **IndexedDB 大 value 的表禁止用 `getAll` 查标记位**：`attachments_local` 的 value 内联了整个加密二进制（base64），`getAll` 会全部反序列化进内存。要按标记位（如 `deleted`）批量操作时建索引 + `getAllKeysFromIndex` 只取主键（DB v5 的 `by_deleted` 索引，`purgeDeleted`/`listDeletedNoteStubs`）。
- **解锁链路有常驻耗时日志**（`[FastNote] unlock: ...`）：笔记解密、首帧渲染、后台索引就绪三个阶段各打一条 console.info，性能回归时先看控制台。
- **内置日志查看器**（桌面打包版没有 DevTools）：`packages/shared/logBuffer.ts` 的 `installConsoleCapture()` 在 `VaultApp` 模块顶层调用，包装 console 四个方法写入内存环形缓冲（2000 条上限，绝不自动落盘）；右上角 📋 按钮打开 `LogsModal`（复制/导出/清空）。用户报问题时让他从这里导出日志。
- **Electron 权限硬化是无例外的全拒**（用户明确决策，2026-07-09）：`apps/desktop/electron/main.ts` 拒绝一切权限请求，**包括剪贴板写入**——不开任何白名单。因此渲染层任何"复制到剪贴板"功能都**不能用 `navigator.clipboard`**（桌面版必抛 `NotAllowedError`），必须用无需权限的 `document.execCommand('copy')`（隐藏 textarea + select，见 `LogsModal.handleCopy`）。

### 14. 禁止 window.prompt；内联输入代替（2026-07-10 确立）

Electron 渲染进程**不支持 `window.prompt()`**（同步返回 null，无任何 UI），`confirm()`/`alert()` 可用。历史上渲染工具栏的链接/公式按钮和表头重命名都因此静默失效。**约定**：任何需要用户输入一小段文本的场景一律用内联输入组件——通用的 `packages/ui/src/InlineInputBar.tsx`（label + input + 确认/取消，Enter/Esc），或像表格列重命名那样的就地 input。编辑器内部事件（如 Mathematics 扩展的公式点击编辑）通过回调 prop（`onEditFormula(latex, apply)`) 把输入请求抛给宿主 `VaultApp` 渲染。

### 15. AI Workbench 架构（2026-07-10 新增）

- **网络层**（`packages/ai`）：无任何内部包依赖的纯客户端。`AnthropicClient.streamMessage()` 手写 SSE 解析（按行切 `data:`、处理 `content_block_delta.text_delta`），支持 `AbortSignal` 中止；浏览器直连需要 `anthropic-dangerous-direct-browser-access: true` 请求头。模型列表 `CLAUDE_MODELS` 内置 + 设置里可填自定义 ID。
- **密钥存储**：`META_KEYS.aiSettings`（`vault_meta`），`{apiKey, model}` 用 **masterKey** 加密（与身份密钥包装同级别）；解锁后在后台 IIFE 里解密进内存 state，上锁清空。
- **会话存储**：DB v6 的 `ai_sessions_local`，行结构仿 chat（`titleEnc/payloadEnc` + nonce，**notesKey** 加密），`kind: 'folder' | 'session'`，payload 是完整 `AiMessage[]`（每次消息变更全量重写——会话体量小，不做增量）。
- **UI 编排**：`AiSessionTree`（侧栏可折叠分区，树渲染自包含，不复用 NoteTree）+ `AiWorkbench`（`activeAiSessionId` 非空时替换 main 插槽；`openNoteInGroup`/`selectTabInGroup` 会将其置空切回笔记视图）。流式期间助手消息实时用 `MarkdownView`（marked + dompurify，均为纯本地库）渲染；中止保留已流出的部分文本。网络调用在 `VaultApp.handleAiSend` 中进行，`AiWorkbench` 只拿一个 `sendMessage(messages, onDelta, signal)` 回调（ui 包不依赖 packages/ai）。

### 16. 跨库传输：双 storage 适配器 + 全量重生成 ID（2026-07-10 新增）

`createStorage({namespace})` 可同时打开第二个库的 IndexedDB（已验证可并存）。`handleTransferToVault` 流程：读目标库 salt/verifier → `deriveKeysFromPassword` 验密 → 收集选中子树（多选中互为后代的去重）→ **所有节点/附件都生成全新 UUID**（防目标库冲突），parentId 在映射表内重映射、子树根落到目标库根层级 → 附件先解密再用目标 notesKey 重加密保存，正文中 `fnattach:<uuid>` 引用做 old→new 字符串替换 → 笔记以 `version: 1 / serverVersion: 0 / syncStatus: 'pending'` 写入（目标库若有云账号，下次同步自然推送）→ 移动模式复用 `handleDeleteMany`（本地库硬删 / 云库墓碑）。

### 17. 查找替换：统一 controller 接口 + 双模式驱动（2026-07-10 新增）

`shared` 定义 `FindReplaceController`（search/next/prev/replace/replaceAll/close，同步返回 `{total, current}`），`NoteEditor` 按当前模式注册到宿主（`onRegisterFindReplace`），共享 `FindReplaceBar` 通过 **getter prop**（`getController`）拿最新 controller（模式切换会换实例，不能捕获）。源码模式：`@codemirror/search` 程序化驱动（`setSearchQuery`/`findNext`/`replaceNext`/`replaceAll`），`Prec.high` 吞掉 `Mod-f` 阻止 CM 自带面板；当前匹配靠选中呈现，basicSetup 的 `highlightSelectionMatches` 高亮其余匹配。渲染模式：`FindReplaceExtension` ProseMirror 插件（meta 驱动、Decoration 高亮、docChanged 自动重算；**匹配不跨文本节点**为已知限制）。快捷键 `findInNote`（默认 Ctrl+F）走全局 window keydown（编辑器内也生效），仅 notes 视图响应。

## 组件关系速览（`packages/ui`）

- `UnlockScreen` — 多保险库选择 + 密码解锁 / 云账户同步 tab
- `AppShell` — 顶层布局壳（工具栏、侧栏、内容区）
- `NoteTree` — 笔记/文件夹树，含拖拽排序、批量导入入口
- `EditorToolbar` / editor（来自 `packages/editor`）— 笔记编辑
- `ChatSidebar` / `ChatPanel` / `ChatAttachmentContent` — 聊天会话列表、消息流、附件渲染
- `SettingsModal` — 服务器地址、通知、主题、保险库改名、快捷键、AI key/模型等所有设置的聚合入口
- `AuthModal` / `AboutModal` / `LogsModal` — 登录注册 / 关于 / 日志查看弹窗
- `NoteAttachments` / `EmbeddedAttachmentChip` — 笔记内附件的展示/嵌入
- `InlineInputBar` — 通用内联文本输入行（prompt 替代品）
- `FindReplaceBar` — 查找替换条（双模式共享，经 `getController` 驱动编辑器）
- `AiSessionTree` / `AiWorkbench` / `MarkdownView` — AI 会话树 / 对话主界面 / 安全 markdown 渲染
- `VaultTransferModal` — 跨库传输弹窗（目标库 + 密码 + 复制/移动）
