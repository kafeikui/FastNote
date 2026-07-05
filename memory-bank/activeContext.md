# Active Context — FastNote

## 当前工作焦点（最新会话，2026-07-05 第三轮：版本 bump + Vercel 部署方案）

用户要求 bump 版本、准备 git 提交、并给出 Web 前端的 Vercel 部署方案：

- **版本号**：所有 workspace 的 `package.json`（根 + `packages/*` 十二个包 + `apps/web` + `apps/desktop` + `server`）从 `0.1.0` 统一 bump 到 `0.2.0`——上一个 `0.1.0`/"first commit" 之后这一批加的功能（i18n、CSP 修复、表格公式与统计、侧边栏收起、四套主题、聊天送达/已读回执、聊天历史云同步、新建/导入下拉菜单+强制导入、加密库标签/真实存储路径说明等）体量上明显是 minor 版本，不是 patch。`pnpm-lock.yaml` 不需要跟着变（workspace 内部包之间是 `workspace:*`/`link:` 引用，lockfile 里不固化这些内部包的版本号），`pnpm install --frozen-lockfile` 验证过通过。
- **Vercel 部署方案**：新增仓库根目录 `vercel.json`（`installCommand: pnpm install --frozen-lockfile` + `buildCommand: pnpm --filter @fastnote/web build` + `outputDirectory: apps/web/dist`），已经用完全相同的命令在本地跑通验证过。新增 `docs/VERCEL.md` 详细说明：
  - **只部署 Web 前端**，中继服务器（`server/`，长连接 WebSocket + 本地 JSON 文件持久化）架构上就不适合 Vercel 的无状态 serverless/edge 模型，必须继续按 `docs/DEPLOYMENT.md` 部署到自己的 VPS。
  - 两者是完全独立的部署单元：前端连哪个中继服务器，是用户在设置里自己填、存在浏览器 `localStorage` 里的（`fastnote_server_url`），不是构建期注入的，所以 Vercel 项目**不需要配置任何环境变量**。
  - 服务器端 CORS 已经是 `{ origin: true }`（`server/src/index.ts`），Vercel 域名和中继服务器域名不同源也能直接跨域访问，不需要额外改服务器配置。
  - Vercel 项目的 "Root Directory" 必须保持仓库根目录（不要设成 `apps/web`），否则 Vercel 找不到 `pnpm-workspace.yaml`，workspace 包解析会失败——这是本文档里特别强调的一个坑。
  - 没有引入新的对外网络访问，CSP 逻辑不受影响（CSP 是运行时从 `localStorage` 生成并写入 `<meta>` 的，不是 HTTP 响应头，Vercel 侧不需要配置 header）。
- README（英文主版本 + `README.zh-CN.md`）都新增了指向 `docs/VERCEL.md` 的链接和一小段说明；`docs/DEPLOYMENT.md` 顶部加了一句话澄清"本文档只讲中继服务器，前端部署见 VERCEL.md"。
- 以上改动已通过 `pnpm build`（全仓）+ 单独模拟 `vercel.json` 里那条 `buildCommand` 验证产物能正确生成在 `apps/web/dist`。

## 更早会话焦点（2026-07-05 第二轮）

用户反馈上一轮改动里 3 个新问题：

1. **勾选状态语义不对**：`ChatPanel.tsx` 之前是 `m.status === 'sent' ? '✓' : '✓✓'`，导致"已送达"和"已读"都显示双对勾，无法区分。改为 `m.status === 'read' ? '✓✓' : '✓'`（`sent`/`delivered` 都是单对勾，只有 `read` 才是双对勾），并新增 `.fn-chat__status--delivered` 样式（用 `--text` 而非 `--muted`，让"已送达"比"已发送"视觉上更实一点，"已读"保持 `--accent` 强调色）。
2. **新建/导入下拉点击没反应**：根因是 `DropdownMenu.tsx` 用 `onClickCapture={() => setOpen(false)}` 挂在菜单容器上"点击菜单里任何东西就关闭菜单"——capture 阶段是从外到内先于目标元素的 bubble 阶段执行的，这种"祖先 capture 先于目标 bubble"的顺序不是很多人假设的那样安全（尤其是配合子元素在同一次点击事件里可能有副作用，如触发隐藏 `<input type=file>` 的 `.click()`）。改成 `onClick`（bubble，非 capture）：DOM 规范保证 bubble 阶段永远是"目标元素自己的 onClick 先执行，父级 onClick 后执行"，从而保证菜单项自身的业务逻辑（`handleCreate`/`openImportNoteFile` 等）一定先跑完，菜单才关闭。
3. **导入笔记文件/导入文件夹增加"强制导入"选项**：之前"导入笔记文件"文件选择框写死 `accept=".txt,text/plain"`，导致原生文件选择对话框会把非 .txt 文件过滤掉/不好选；"导入文件夹"批量导入时无扩展名/`.txt` 当笔记、`.csv` 当表格、其它一律跳过。新增 `importNoteForceRef`/`importFolderForceRef` 两个 ref 追踪"强制模式"，`openImportNoteFile(parentId, force)` 在强制模式下把 `<input>` 的 `accept` 属性直接清空（允许选择任意文件），`openImportFolder(parentId, force)` 把 `force` 一路传到 `handleImportFolder`，强制模式下无视扩展名、统一把每个文件的文本内容当笔记导入（不再按 `.csv` 特殊处理成表格）。工具栏"导入"下拉菜单里新增了两个对应的强制导入菜单项。

以上 3 项已通过 `pnpm build`（全仓）验证，无新增 lint 错误。

## 更早会话焦点（2026-07-05 第一轮）

用户一次性反馈了 6 个问题，逐条修复：

1. **解锁页焦点丢失**：切换服务器地址/数据目录标签后原先调用 `window.alert()`，在 Electron 里会造成 OS 级焦点陷阱，导致 `UnlockScreen` 的 `autoFocus` 失效且不可恢复。改为 `window.confirm()` + `window.location.reload()`，靠整页刷新拿到干净的焦点状态。
2. **笔记内附件拖拽失效**：上一版为了支持"表格单元格内拖拽排序"给 `EmbeddedAttachmentChip` 的内部拖拽手柄加了 `onMouseDown={(e) => e.stopPropagation()}`，这个 stopPropagation 无条件生效，误伤了笔记编辑器（ProseMirror node view）的原生拖拽——因为编辑器的整节点拖拽依赖 mousedown 冒泡到 ProseMirror 自己的 view 监听器。修复：`data-drag-handle`/`draggable`/该 `onMouseDown` 全部改为只在传入了 `onDragStart`（只有表格会传）时才生效，笔记编辑器场景天然不受影响。
3. **聊天送达/已读状态**：`packages/im` 新增 `read_ack` 类型、`onDeliveryAck`/`onReadAck` 回调、`sendReadAck()`；服务端 `server/src/index.ts` 新增转发 `delivery_ack`/`read_ack` 给发送方在线连接，并在收到 `delivery_ack` 时顺带清理 `message_queue`；`ChatPanel` 气泡新增送达/已读勾选图标。
4. **批量导入支持 `.txt` + 新建/导入下拉菜单**：导入逻辑里 `.txt`（以及无扩展名文件）当笔记读取正文导入；新增通用 `packages/ui/src/DropdownMenu.tsx`，把工具栏里原本平铺的"新建笔记/表格/文件夹"和"导入笔记/表格/文件夹"收进两个下拉菜单，并新增单文件导入入口（此前只能整个文件夹批量导入）。
5. **云账号同步看不到历史聊天记录**：这是缺失功能，不是 bug——聊天记录此前从未参与任何云同步管线。新增服务端 `chat_blobs` 存储（`server/src/store.ts` 的 `upsertChatMessage`/`listChatMessages`）+ `PUT/GET /api/v1/sync/chat`(`:messageId`) 两个端点；`packages/storage` 给 `StoredChatRow` 加 `synced?: boolean` 字段 + `listPendingChatMessages`/`getChatMessageWire`/`markChatMessageSynced`/`hasChatMessage`/`saveChatMessageFromRemote`；`packages/sync` 新增 `SyncClient.syncChatMessages()`（push-once + pull-if-missing 的简化模型，聊天消息视为不可变，没有笔记那套 version/冲突副本机制）；`VaultApp.tsx` 的 `runCloudSync`/`handleSync` 都会在同步笔记+附件之后调用 `loadChatHistory()` 刷新 `chatMessages` state。
6. **"本地数据到底存哪"**：设置面板里原来的"数据目录"其实只是一个**标签**，用来派生 IndexedDB 的 namespace，应用从不写文件进去（所以用户打开发现是空目录，属于设计如此但极易误导）。修复：改名为"加密库标签目录"并在 hint 里明确说明"不会写入任何文件"；新增 Electron `getUserDataPath`/`openUserDataFolder` IPC（`apps/desktop/electron/settings.ts` 用 `app.getPath('userData')` + `shell.openPath`），设置面板新增只读的"真实存储位置"字段 + "在文件管理器中打开"按钮，指向 Electron/Chromium 实际写入 IndexedDB 数据库文件的目录。Web 版没有类似 API 可读，hint 改为说明数据在浏览器自己的 IndexedDB 里、路径由浏览器管理、无法从页面内获取。

以上 6 项均已通过 `pnpm build`（全仓）验证，`packages/storage`/`packages/api` 的 `pnpm typecheck` 单独跑也通过（`packages/sync` 缺 `tsconfig.json` 是既有已知问题，见 `progress.md` 已知问题 §1，不受本次改动影响）。

## 更早会话焦点（2026-07-04）

修复用户反馈的两类 bug：

1. **CSP 阻止本地/远程服务器连接**：`connect-src 'self'` 拦截了对用户配置服务器（如 `http://localhost:8787`）的请求，且控制台反复出现 `frame-ancestors` 通过 `<meta>` 传递被忽略的警告。根因是最初的"运行时更新 meta CSP"设计从未真正生效（浏览器只在解析阶段应用一次 `<meta>` CSP）。修复方式见下方"本次会话的实质性变更"及 `systemPatterns.md` §7。
2. **表格编辑体验问题**：
   - 输入 `=` 开始公式时，因为 `TableCellContent` 在 `isFormula` 切换时返回结构不同的 JSX（分支渲染），导致 React 卸载/重建 `<input>`，丢失焦点、显示 `#ERROR!`。已改为让文本片段始终用同一个 `<input>`（同 key、同类型），只是内部按 `isFormula` 切换 value/onChange 逻辑。
   - 回车后焦点应移动到下一行同列单元格：新增 `data-row-idx`/`data-col-idx` 属性 + `TableEditor` 里的 `focusCellInput`/`handleCellKeyDown`（基于 `querySelector` 定位下一个 `<input>` 并 `.focus()`）。
   - 表格单元格内的附件应可拖拽调整顺序：给 `EmbeddedAttachmentChip` 加了可选的 `onDragStart`/`onDragOver`/`onDrop`/`onDragEnd`/`dragOver` props（挂在原有的 "⠿" 拖拽手柄上），`TableCellContent` 用它们在同一单元格内重新排序 `ContentSegment[]`。

以上均已完成并通过 `pnpm build:web` / `pnpm build:desktop` 验证。

**追加修复（同日，第一版修复不彻底）**：用户反馈公式输入仍然"焦点乱跑"、附件拖拽"松开后无变化、也不能跨格"。排查后发现：

- 公式焦点问题的真正原因不是"结构切换导致 remount"（这部分已经修对），而是 `editing` 这个本地 state 只在**公式态**的 `onFocus` 里被置 `true`；用户在空单元格里先获得焦点（此时还是非公式态，`onFocus` 只调用了外部传入的 `onFocus` prop，没有 `setEditing(true)`），再敲下 `=` 导致 `isFormula` 变 `true` 时，`editing` 依然是 `false`，显示值瞬间从正在输入的 `"="` 跳成 `#ERROR!`，光标错位。修复：不再区分公式/非公式两种 `onFocus`，任何一次聚焦都统一 `setEditing(true)`，只用一份 `<input>` 渲染逻辑（`value={isFormula && !editing ? displayValue : seg.text}`）。
- 附件拖拽"松开无变化"是 `moveSegment` 的插入位置算法错了：把索引 0 拖到索引 1（比如两个附件互换）时，`insertAt = to - 1 = 0`，插入位置和移除前一样，等于没动。正确算法是**始终 `insertAt = to`**（不需要按方向区分/减一），验证：`[A,B]` 从 0 拖到 1 → 先移除 A 得 `[B]` → 在下标 1 插入 A → `[B,A]`，正确互换。
- "不能拖到别的格子"是因为原设计里拖拽状态（`dragIndex`）是 `TableCellContent` 组件本地 state，天生只能感知同一个单元格内的拖拽。改为通过 `e.dataTransfer.setData()` 携带 `{rowId, colId, index}` payload（自定义 MIME `application/x-fastnote-table-attachment`），拖到任意单元格（哪怕原本没有附件、只有纯文本）都能在 `onDrop` 里解析出来源坐标；实际的增删逻辑上移到 `TableEditor.tsx` 的 `handleMoveAttachment`（能访问整个 `doc`，可以同时改源格和目标格两处 cell 内容）。单元格 wrapper div 也加了兜底的 `onDragOver`/`onDrop`（附加到末尾），这样即使目标格没有现成的附件 chip 可以当放置目标，也能接住拖进来的附件。

## 更早会话（已完成，供参考）

用户提出两件事：

1. 加入 i18n 支持，先支持中文和英文
2. 更新 `docs/` 中已经不再适用的文档（`ARCHITECTURE.md`/`PHASE1.md`/`DATABASE.md`/`PROTOCOL.md`）

两项均已完成。

## 本次会话的实质性变更

### i18n

- 新增 `packages/i18n` 包：`locales/zh.ts`（权威词典，`as const`）+ `locales/en.ts`（结构对齐）+ `index.ts`（`translate()` 纯函数、`I18nProvider`/`useT()`/`useLocale()`、`loadLocale()`/`saveLocale()` 基于 `localStorage` 的 `fastnote_locale`、`detectDefaultLocale()` 按浏览器语言自动探测）。
- `packages/ui`/`packages/app`/`packages/editor`/`packages/table`/`packages/api` 均加了对 `@fastnote/i18n` 的 workspace 依赖并跑过 `pnpm install`。
- 重构了几乎所有面向用户的组件/工具函数以移除硬编码中文字符串，改用 `t()`（组件内，走 `useT()`）或 `translate(locale, key, vars)`（非组件的纯函数/类，如 `packages/table/src/utils.ts`、`packages/api` 的 `ApiClient`）。完整清单见 `systemPatterns.md` §10 和下方"已完成"记录。
- `SettingsModal` 新增语言切换 UI（在 `LOCALES` 之间切换，即时生效）。
- 已验证全仓 `typecheck`/`build` 通过（`packages/im`/`packages/sync`/`packages/table` 缺 tsconfig 的已知问题不受影响，见 `techContext.md`）。

### 文档更新

- 重写 `docs/ARCHITECTURE.md`：修正客户端存储（统一 IndexedDB，非"Electron 用 SQLite"）、服务端持久化（JSON 文件，非 SQLite）、IM 密钥交换（静态 X25519 ECDH + HKDF 计数器密钥，非 X3DH/Double Ratchet）、monorepo 结构（补充 `i18n`），新增 §9 i18n 章节。
- 重写 `docs/DATABASE.md`：按 `packages/storage/src/index.ts` 和 `server/src/store.ts` 的真实 schema 重写所有表结构（`vault_meta`/`notes_local`/`attachments_local`/`chat_messages_local`/`chat_attachments_local`；服务端 `users`/`note_blobs`/`attachment_blobs`/`message_queue`），删除不存在的 `prekeys`/`devices`/`manifests`/`sync_queue`/`chat_sessions` 表，新增 `localStorage` 配置项一览。
- 重写 `docs/PROTOCOL.md`：对齐 `server/src/index.ts` 实际路由（字段名、错误码、无分页游标、无 prekey bundle 接口、`delivery_ack` 服务端当前不处理等细节）。
- 重写 `docs/PHASE1.md`：保留作为历史规划记录，但逐条标注实际完成情况与技术选型调整（存储引擎、IM 加密方案简化等），并补充 MVP 之后新增的能力清单（主题、i18n、通知设置、CSP 白名单等）。

## 本次会话的实质性变更（CSP + 表格）

- `packages/shared/src/csp.ts`：`buildContentSecurityPolicy` 去掉了无效的 `frame-ancestors` 指令；删除了从未真正生效的 `applyContentSecurityPolicy()`（运行时改 meta 内容对已应用的 CSP 没有任何效果——这是浏览器规范行为，不是 bug），改为新增 `serverUrlNeedsReload(serverUrl)` 用来检测"当前 CSP 是否已经覆盖这个地址"。
- `apps/web/index.html` + `apps/desktop/index.html`：删除写死的静态 `<meta>` CSP，改为文档最顶部一段内联、非 module 的 `<script>`，在解析阶段同步读取 `localStorage.fastnote_server_url`（无则回退 `http://localhost:8787`）、拼出策略字符串、`document.write()` 写入 `<meta>`。同时把算出的地址存进 `window.__FASTNOTE_CSP_SERVER_URL__` 供 `serverUrlNeedsReload` 读取。
- `packages/app/src/VaultApp.tsx`：新增 `commitServerUrl(next)`（保存 + `setServerUrl` + 必要时 `confirm()` 提示刷新），替换了原来分散在 `handleCloudSync`/`onSaveServer` 里的 `saveServerUrl`+`setServerUrl` 调用；删除了不起作用的 CSP `useEffect`。
- `packages/table/src/TableCellContent.tsx`：不再按 `isFormula` 整体切换返回的 JSX 结构；`segments` 无条件计算，每个文本片段固定渲染同一个 `<input>`（同 key），公式态只是切换它的 value/className/事件。附件片段的 `EmbeddedAttachmentChip` 现在接了拖拽事件用于同格内重新排序。
- `packages/table/src/TableEditor.tsx`：新增 `tableWrapRef`、`focusCellInput`、`handleCellKeyDown`，把 `rowIdx`/`colIdx`/`onKeyDown` 传给每个 `TableCellContent`，实现回车换行聚焦下一格。
- `packages/ui/src/EmbeddedAttachmentChip.tsx`：新增可选的 `onDragStart`/`onDragEnd`/`onDragOver`/`onDrop`/`dragOver` props（向后兼容，其它调用方——聊天、笔记编辑器——不受影响）。
- `packages/i18n`：新增 `vaultApp.serverUrlReloadConfirm`（中英文）。
- `docs/ARCHITECTURE.md` §CSP 段落、`memory-bank/systemPatterns.md` §7 已同步改写，记录了"meta CSP 不能运行时更新"这个教训。

## 活跃的技术决策 / 约定（后续开发请遵守）

- **新增持久化设置**一律走 `packages/api/src/index.ts` 的 `loadXxx`/`saveXxx` 命名对模式，`VaultApp.tsx` 里用 `useState(() => loadXxx())` 初始化。
- **新增任何对外网络访问**（新的 API 端点、CDN 资源、第三方服务）必须同步更新 `packages/shared/src/csp.ts` 的 `buildContentSecurityPolicy` **以及** `apps/web/index.html` / `apps/desktop/index.html` 里手写的引导脚本（两处逻辑必须保持一致，否则会被浏览器直接拦截）——这是刻意设计的摩擦，防止无意中引入非自托管依赖。**切勿**尝试在 React 里"运行时更新" meta CSP，浏览器会静默忽略，见 `systemPatterns.md` §7。
- **不引入埋点/统计/崩溃上报/自动更新类库**，这是产品的核心卖点之一，新增依赖前应先确认其网络行为。
- **本地存储统一走 IndexedDB**（`packages/storage`），不要为 Electron 单独实现 SQLite 存储路径。
- **新增面向用户的字符串**：React 组件用 `useT()` 拿 `t()`；非组件的纯函数/类显式接受 `locale: Locale` 参数并调用 `translate()`。两种语言的词典都要同步更新（`packages/i18n/src/locales/zh.ts` + `en.ts`），缺失的 key 会在运行时回退到中文而不是报错，但应避免长期遗留缺口。
- **文档与实现出现分歧时**：以源码为准去更新 `docs/*.md`，不要反过来把实现"改回去"迁就旧文档，除非确认是真的 bug。

## 下一步（可选，未在本次会话范围内）

- `docs/DEPLOYMENT.md` 尚未逐字核对是否有过时内容（本次未涉及，用户只点名了 ARCHITECTURE/PHASE1/DATABASE/PROTOCOL 四份）。
- i18n 目前只有中/英文，且只覆盖了主要交互路径；如果之后要加第三种语言，参考 `systemPatterns.md` §10 末尾的"新增语言"步骤。
- Apple Developer 证书签名/公证、GitHub 私有仓库可见性等历史遗留问题（见更早的会话）仍待用户自行推进，未在本次会话内处理。
- 聊天历史云同步（`chat_blobs`）目前是 push-once/pull-if-missing 的简化模型：本地消息的后续 `status` 更新（送达/已读）不会重新推送到服务端，也就不会同步到其它已登录设备；如果之后需要跨设备同步已读状态，需要重新设计成类似笔记那样的带版本号/更新时间的模型。
- 数据目录相关的 UI 已经加了"真实存储位置"只读展示，但没有做"迁移工具"（比如把旧的、误以为是数据目录的那个空文件夹里可能存在的用户自己手动放进去的文件搬过去）——目前认为没有必要，因为那个目录本来就没有任何 FastNote 数据。
