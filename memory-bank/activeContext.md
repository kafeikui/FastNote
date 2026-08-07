# Active Context — FastNote

## 当前工作焦点（最新会话，2026-07-12：表格数字格式/时间插入 + AI 附件/后台流式/消息管理 + 多格复制修复/桌面右键菜单 + AI 滚动/耐心提示/公式渲染/消息时间戳 + 登录过期处理/设置选项卡 + Alt+方向键调序/AI转笔记/编辑焦点历史 + 自定义分隔符/AI导出文档 + 焦点历史扩展/热键自定义 + 公式丢失修复，随 git 提交按约定 minor bump 至 **v0.9.0**，README 双语功能清单已同步 0.8.x 全部新特性）

**追加（2026-07-28 第三十八轮，五项需求：表格 Excel 风格编辑 / 数字格式百分比 / 单元格对齐 / 公式千分位逗号清除 / 登录有效期 30 天，随 git 提交 minor bump 至 **v0.19.0**，server bump 至 **0.8.1**（JWT 30 天）需重新部署）**：
1. **表格 Excel 风格编辑**（`TableEditor.tsx` + `TableCellContent.tsx`）：交互模型重构——**非编辑态单元格 textarea 设 `readOnly`**（idle 光标 default + `user-select:none`），单击只选中不进入编辑（`handleCellMouseDown` 对非正在编辑格 `preventDefault` + blur 其他编辑格 + 聚焦容器；Shift+单击从锚点扩选；点击附件 chip `.fn-embed-attach` 豁免以保拖拽/点击）。**双击 / 选中后 Enter / 直接输入可打印字符**进入编辑（`startEditCell(row,col,caret)`，输入字符走 type-to-edit：替换格内容+光标置尾，rAF 后回写 `editStartValueRef` 保 Esc 还原原值；IME 无法在非编辑容器上起composition，中文需先双击/Enter）。**容器级键盘**（均要求焦点不在 input/textarea）：方向键移动选区（Shift+方向键扩选，替换了原"移动并编辑"）、Enter 开始编辑、**Del/Backspace 清除选区内容**（`clearSelectedCells`）。编辑中 Enter 改为**提交并把选区下移一格但不进入编辑**（Excel 语义；焦点回容器）；格内 Shift+方向键"移动并编辑"保留。Alt+方向键单格交换仅在原本就在编辑时才重新聚焦输入。**右键菜单**（`handleCellContextMenu`→自绘 `.fn-table__ctx-menu`，正在编辑的格保留原生文本菜单；readOnly 恰好让桌面端 main.ts 原生菜单不弹出——`isEditable=false` 且无选中文本）：**复制（raw，公式复制源码）/ 仅复制值（求值结果）/ 粘贴替换内容 / 清除内容**；右击选区外单元格先重定位选区。复制走 `buildRangeTsv(mode:'values'|'raw', allowSingle)` + `copyTextToClipboard`（execCommand 隐藏 textarea，免权限），同时写 `internalClipboardRef`；菜单粘贴优先 `navigator.clipboard.readText()`，被拒（桌面端全拒剪贴板权限）回退内部缓冲，仍无则 alert `tableEditor.pasteUnavailable`。`onPaste/onCopy` 从 `.fn-table-wrap` 上移到容器 div（容器持焦时 Ctrl+V 也可用；`handleGridPaste` 支持无编辑格时锚定选区左上角，单值包成 1x1 grid 替换；input 目标豁免走原生）。行号/列字母选择现在会 `containerRef.focus()` 让键盘立即可用。工具栏时间/附件插入目标改为"选中格优先、后备最近编辑格"（`insertTargetCell`）。帮助弹层新增 `helpExcel` 首行。
2. **数字格式百分比**：`TableColumnFormat.kind` 增 `'percent'`（shared），`formatColumnNumber` percent 分支 ×100 后 `toPrecision(15)` 修浮点（1.2345→123.5% 而非 123.44999→123.4%）再拼 `%`；工具栏数字格式下拉加"百分比"选项（小数位共用，货币符号仍仅 currency）。i18n `numberFormatPercent`。冒烟 12 例全过。
3. **单元格对齐**：`TableCellStyle` 增 `align?('left'|'center'|'right')` / `valign?('top'|'middle'|'bottom')`（shared；`applyCellStyle` 泛型合并无需改）。水平走 textarea `textAlign`（`textStyleFor`），垂直走 td `vertical-align`（tdStyle 与 fill 合并）。工具栏两个紧凑下拉（复用 `.fn-table-fmt__size` 样式），清除格式一并清 align/valign。i18n `alignH/alignV` + 6 个选项键。
4. **公式千分位逗号清除**：`finalizeFormulaParens`（Enter/失焦/Shift 移动时触发）在补括号前先 `raw.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, 去逗号)`——严格 3 位分组才清（`=1,000+5`→`=1000+5`、`SUM(1,234)`→`SUM(1234)`），参数逗号 `SUM(A1,B2)`、非分组 `12,34` 不动；只改存储源码，列格式化显示层不受影响。
5. **登录有效期 30 天**：`server/src/index.ts` 注册/登录两处 JWT `expiresIn: '7d'`→`'30d'`（**server 需重新部署**才生效；客户端无改动，401 过期处理沿用既有 ApiAuthError 流程）。
- 其它：`.fn-table__ctx-menu` 样式（仿 `.fn-chat__ctx-menu`，disabled 态灰显）；全仓 typecheck 通过；README 功能描述未更新（用户本轮未要求）。
- **首轮反馈修复（同日第二批）**：a) **回车无法确认编辑（根因）**——单元格 Enter 处理里先 `blur()` + `containerRef.focus()`，事件随后冒泡到容器级 keydown 时 `document.activeElement` 已经是容器，新加的"Enter 开始编辑"分支误判为非编辑态、把刚提交的格又 `startEditCell` 重新打开（公式因此永远显示源码"无法确认"，仅复制值也因该格滞留编辑态弹不出自绘菜单而"失效"）。修复：容器级按键判定从 `document.activeElement` 改为 **`e.target`**（按键时刻真正持焦的元素，不受同一事件内 blur/refocus 时序影响），方向键/Enter/Del/type-to-edit 四个分支统一走该判定。b) **工具栏货币符号输入框（$）移除**——用户不要这个控件；`TableColumnFormat.symbol` 字段保留（老文档自定义符号仍生效，新建货币格式默认 `$`），i18n `currencySymbol` 键保留未用。c) **工具栏撑高**——`.fn-table-editor__tools` 是 flex-wrap，新增两个对齐下拉 + 货币态的小数位/符号控件把一行挤到换行；对齐下拉选项文案压缩（zh：水平/左/中/右、垂直/上/中/下）+ 移除符号输入框后恢复单行。
- **二轮反馈修复**：d) **右键仍进编辑态**——`handleCellMouseDown` 只对左键 preventDefault，右键 mousedown 的默认行为把（只读）textarea 聚焦了 → 聚焦即编辑态 → contextmenu 判定"正在编辑"让位原生菜单。修复：非左键且该格未在编辑时也 preventDefault（不拦 contextmenu 事件本身）。e) **选中单格 Ctrl+C 无作用**——键盘兜底 `copyRangeViaExecCommand` 原来 `buildRangeTsv()` 默认不允许单格（旧模型单格靠原生文本复制）；改为 `buildRangeTsv('values', true)`：**Ctrl+C 默认复制计算值、单格也生效**；公式源码复制走右键"复制"。

**追加（2026-07-22 第三十七轮，四项需求：搜索索引重建 / 空链接取消 / AI session 云同步 / 插入删除行列公式引用调整 + 整列引用忽略自身，随 git 提交 minor bump 至 **v0.18.0**，server bump 至 **0.8.0** 需重新部署）**：
1. **全局搜索清缓存重建**：用户报告全局搜索出现两份结果、其一指向不存在的文档（陈旧快照）。两层修复：a) `VaultApp.searchResults` memo 现在按当前 `notes` 过滤——不在存活（未删除）笔记集合里的 id 一律不显示，并按 id 去重（依赖加了 `notes`）；b) 设置→存储页新增"全局搜索索引"区块（`SettingsModal` 新 prop `onRebuildSearchIndex`，i18n `settingsModal.searchIndexLabel/Hint/rebuildSearchIndex/searchIndexRebuildStarted`），`VaultApp.handleRebuildSearchIndex` 把 `META_KEYS.searchIndexSnapshot/Fingerprint` 置空（空串按缺失处理）后调 `prepareSearchIndexInBackground` 全量后台重建，锁定时写新快照。
2. **空链接=取消链接**（`EditorToolbar.confirmPending`）：链接输入条确认空值时改调 `unsetLink()`（此前空值直接 return，无法去掉已有链接）。
3. **AI session 随账户同步（E2E 加密）**：完整移植 chat_blobs 模式。服务器 `JsonRelayStore` 新增 `ai_blobs`（`{user_id, session_id, ciphertext, deleted, updated_at}`，`upsertAiSession` 服务端 LWW：旧于现存 `updated_at` 的推送直接忽略；`importAll` 兼容无 ai_blobs 的迁移数据）+ 端点 `PUT/GET /api/v1/sync/ai(/:sessionId)`（内容为 notesKey 加密的不透明 blob，服务器零知识）。`ApiClient` 增 `pushAiSession/pullAiSessions` + `SyncAiSessionItem`。存储层 `StoredAiSession` 增 `synced?/deleted?` 字段：`saveAiSession` 置 `synced:false`（可选参数 `{synced}` 供远端写入用），`deleteAiSession` 改为**墓碑**（deleted+updatedAt=now，`listAiSessions` 过滤墓碑），新接口 `listPendingAiSessions/markAiSessionSynced（墓碑推完即硬删）/getAiSessionSyncMeta/saveAiSessionFromRemote/purgeAiSession`。`SyncClient.syncAiSessions(storage, notesKey)`：整节点单 blob（`AiSessionSyncPayload`）LWW 合并（按 `updatedAt`，先推后拉；远端墓碑仅当本地不更新时清除本地，本地更新的编辑会复活服务器条目），并入 `syncAll`（`SyncResult` 增 `aiPushed/aiPulled`）。触发点：桌面手动同步（拉到后刷新 `aiSessions` 并校验 activeAiSessionId）、登录后/解锁后后台同步（与聊天历史同批）、以及**防抖 5s 的后台推送** `scheduleAiSessionPush`（`persistAiSession`/`handleAiDelete` 触发，未登录 no-op，锁定时清定时器；桌面为此加了 `sessionRef`）；移动端同样三处接入（`syncChatHistory` 内、防抖推送、handleLock 清理）。已写两设备模拟冒烟测试 15 项全过（加密不可见明文/双向 LWW/墓碑传播/删后编辑复活/文件夹同步/陈旧推送忽略）。
4. **插入/删除行列公式引用自动调整**（第一版 token 级平移被用户报 bug：`=sum(b1:b6)` 上方插行没变 `b1:b7`，已重写）：`formula.ts` 现以**引用单元**为粒度改写——`rewriteFormulaRefs(raw, cb)` 扫描器把 `B1:B6`/`C:C`/`C1:C` 两端点配对成 range 单元（孤立 `C5` 为 cell 单元，字母后跟 `(` 的函数名跳过），重写后统一大写重排（`b1`→`B1`）。**插入**（`rewriteFormulaRefsForInsert`）：cell 引用 idx≥insertIndex 平移；range 的**行轴用吸收语义**——起点仅当插入点严格在其上方才下移、终点在 `insertIndex ≤ hi+1` 时扩展，所以在 b1 上方/范围内/b6 正下方插行都得 `B1:B7`（正是用户的期望），列轴保持纯平移（新列是新数据系列，Excel 同）。**删除**（`rewriteFormulaRefsForDelete`，接入 `utils.removeColumn/removeRow`，先取被删下标再过 `rewriteDocFormulasForDelete`）：删除点在 range 前→整体 -1、在内→收缩终点、单行/列 range 被删中→整体替换为 `#REF!`；孤立 cell 引用命中即 `#REF!`；tokenize 认识 `#REF!` 前缀并抛 `FormulaEvalError('#REF!')`，单元格显示 `#REF!` 而非 `#ERROR!`。混合 `C1:C` 行操作只动有界端点。冒烟 38 例全过（吸收边界、reversed 端点 `B6:B1`、`C:C` 前删列平移/命中删列 #REF!、函数名不动等），`cellDisplayValue` 验证 `#REF!` 展示，包内 typecheck 全绿。**追加：整列引用忽略自身**——`EvalContext` 新增 `current`（当前正在求值公式所属单元格的 `rowId:colId`，嵌套求值时随 `resolveCellOrNull` 递归切换/还原），`parseArg` 的整列展开（`C:C` 及混合 `C1:C`）经 `expandRange(..., skipSelf=true)` 跳过该格——列 B 里可以放 `=SUM(B:B)` 汇总行不计自身也不报 #CIRCULAR!；从其他列引用 `B:B` 仍包含该汇总格的计算结果；有界范围 `B1:B4` 含自身保持 #CIRCULAR! 语义不变；同列两个 `SUM(B:B)` 互相包含仍正确报 #CIRCULAR!。自跳过冒烟 10 例 + 回归 38 例全过。注意既有语义：混合形式 `B2:B` 求值按整列处理（起始行被忽略）。

**追加（2026-07-19 第三十六轮，八项需求：搜索精确匹配 / 新建焦点跳转 / 表格 Enter 后焦点 / 标签页视口 / 聊天历史同步+右键复制 / Android 聊天 / AI 树增强 / Tab 制表符，随 git 提交 minor bump 至 **v0.17.0**）**：
1. **全局搜索精确匹配**（`packages/search/src/index.ts`）：MiniSearch 选项改为 `combineWith:'AND'` + `fuzzy:false`（候选收紧），`search()` 末端加**逐字包含过滤**——查询串（NFKC 小写、空白折叠）必须完整出现在标题或正文里才算命中；snippet 优先围绕完整查询串截取。已用编译后 JS 冒烟测试 5 例全过（含"估值模型"不误中只含散字的笔记）。
2. **sidebar 新建焦点跳转**（`VaultApp.handleCreate`）：新建笔记/表格/文件夹后 `treeSelectedIds`/`treeAnchorIdRef` 指向新节点（F2 可直接重命名），父文件夹自动从 `collapsedFolderIds` 移除并持久化；并复用 `revealId` 机制让侧边栏滚动到新行（带短暂闪烁高亮）；笔记/表格仍照旧打开固定标签页。
3. **表格 Enter/Esc 后键盘失效修复**（`TableEditor.tsx`）：根因是最末行 Enter、以及 Esc 取消编辑时只 `blur()`，焦点落到 `<body>`，容器级 keydown（Shift 移动/Alt 交换/Esc）全都收不到。两处 blur 后补 `containerRef.current?.focus()`。
4. **标签页视口保存/恢复**（`VaultApp`）：分组根节点 `onScrollCapture`（scroll 不冒泡，只能捕获阶段代理）按 `${groupId}:${tabId}` 记录 `.fn-tab-group__scroll` / `.fn-table-wrap` 的 scrollTop/Left 到 `viewportByTabRef`；`activeTabsKey` 变化的 effect 在 rAF 后恢复（无记录的新标签页归零），恢复期间 `restoringViewportRef` 屏蔽记录，防止内容切换时浏览器 clamp 触发的 scroll 事件污染数据。
5. **聊天历史登录后全量同步**：`handleLogin` 与解锁后台初始化（已有 session 时）都补调 `SyncClient.syncChatMessages(storage)`（服务端 `chat_blobs` 全量拉取 + 按消息 id 去重）并在有拉取时 `loadChatHistory` 刷新。此前该同步只挂在手动"立即同步"按钮上，新设备登录后看不到历史。**右键复制完整消息**：`ChatPanel` 气泡 `onContextMenu`（无文字选区时接管，有选区仍走桌面原生菜单）弹自绘菜单 `.fn-chat__ctx-menu`，复制正文+附件名（execCommand 兜底剪贴板权限）。
6. **Android 版聊天**（`apps/mobile`，新增依赖 `@fastnote/im`/`@fastnote/sync`）：`MobileApp.tsx` 移植了桌面 VaultApp 的聊天全链路（setupIdentityKeys/initIM/processIncomingChat/收发/已读回执/未读数/附件下载改走 `navigator.share` 优先）；解锁页 `onCloudSync` 从"不支持"改为真实登录（新设备用 `getVaultSaltInfo` 采用账号盐值建库→login→initIM→聊天历史同步；已有库则校验密码后登录）；顶栏加 💬/🤖 视图切换按钮（带未读角标 `.fn-mobile__badge`），抽屉在聊天视图复用 `ChatSidebar`，主区复用 `ChatPanel`；`index.html` CSP 引导脚本改成与 web 相同的"读 localStorage 服务器地址放行 http(s)+ws(s) origin"，换服务器地址需整页重载（`serverUrlNeedsReload` + confirm）。`serverUrl` 在 MobileApp 里是**函数**（调用时读 `loadServerUrl()`），因为登录 handler 存完新地址马上要用。**设置内也可登录**（用户反馈：ChatSidebar 提示"请先在设置中登录"但设置里只有 AI 项）：`MobileSettings` 新增"账户与同步"区块——已登录显示账号名+退出按钮（`handleLogout`：清 session/断 IM）；未登录给服务器地址/用户名/主密码表单走同一个 `handleCloudLogin`（已解锁路径跳过 `loadAiState`/`setKeys` 不动当前 AI 状态），用户名用 `META_KEYS.boundUsername` 预填（登录成功时两条分支都持久化该 meta，此前移动版漏存）。i18n 新增 `mobileApp.accountHint`。
7. **AI 会话树增强**（`AiSessionTree.tsx`）：新增内部 `focusId`（最后点击的节点，含文件夹，浅色高亮 `--focus`）；工具栏"新建会话/文件夹"在焦点条目同层级创建（焦点是文件夹则进入其内部，与笔记侧边栏一致）；用 `prevIdsRef` 检测 sessions 数组新增节点→自动聚焦并展开祖先文件夹（AI 会话纯本地，数组增长必是用户操作）；树容器 `tabIndex={-1}`+`onMouseDown` 自聚焦，F2 对焦点节点进入重命名（stopPropagation 防全局 F2 重命名笔记）；**新建后键盘焦点主动移到 AI 树容器**（`rootRef.focus()`，否则 F2 会落到全局 handler 去重命名笔记/表格文件）并 `scrollIntoView` 滚到新行（行上有 `data-ai-node-id`）；工具栏新增 ⊞/⊟ 一键展开/收起全部按钮。
8. **Tab 制表符**：笔记 WYSIWYG（`editorProps.handleKeyDown` 插入 `\t`）、源码模式（CodeMirror `indentWithTab`：单光标插 Tab，多行选区缩进/Shift+Tab 反缩进）、表格单元格（`TableCellContent` textarea 层拦截，经 `updateTextSegment` 写回+rAF 恢复光标）、聊天输入框、AI 输入框（各自 textarea onKeyDown 分支）。注意表格多格复制的 Tab 分隔与格内 `\t` 靠 Excel 风格引号往返，不冲突。

**追加（2026-07-15 第三十五轮，表格交互精修：12px 最小行高 + Esc/Shift+方向键 + 公式补括号 + 内容区扩容 + 智能全选，随 git 提交 minor bump 至 **v0.16.0**）**：
1. **最小行高 12px**：`MIN_ROW_HEIGHT` 26→12。关键（用户实测卡在 28px）：CSS 表格的 tr height 只是最小值，且 `.fn-table-cell` 基础样式有 `min-height: 1.75rem`（=28px），**min-height 优先级高于 max-height** 导致上限从未生效。修复：固定高度的行加 `fn-table__row--fixed` 类 + `--fn-row-h` CSS 变量，该行内 `.fn-table-cell` 置 `min-height:0; max-height:var(--fn-row-h); overflow:hidden`，td 上下 padding 归零、textarea 上下 padding 归零、行删除按钮缩到 0.75rem；行号/删除按钮列 `vertical-align: middle` 垂直居中。6px 底部拖柄仍可用。
2. **Esc 取消编辑/选区**：单元格 textarea 聚焦时记录快照（`editStartValueRef`），Esc 恢复该值（emitChange 进 undo 历史）+ blur + 清空选区/focusCell（`skipFinalizeRef` 防止 blur 又触发公式补括号）；无编辑仅有选区（行/列头选中）时容器级 Esc 清选区。cell 层 stopPropagation 防双处理。
3. **Shift+方向键移动选中格并进编辑**：cell textarea 的 Shift+↑↓←→ preventDefault 后移动 selAnchor/selFocus 并 `focusCellInput`（原格内容已按键提交保留，公式先补括号）；容器级兜底（选区存在但焦点不在 textarea）。代价：格内 Shift+←/→ 选字不可用（用鼠标）。
4. **公式自动补右括号**：`finalizeFormulaParens`（数 `(`/`)` 差额补 `)`），挂在 Enter 提交、Shift+方向移动、textarea blur（`TableCellContent` 新 `onEditBlur` prop）三处；公式点选引用（formula-pick preventDefault 不触发 blur）不受影响。
5. **内容区扩容**：删除表格底部提示行（footerHint，i18n 键删除），"共 shown/total 行"并入统计栏常驻首位（占位提示 stats.placeholder 删除，统计栏仍恒高）；`.fn-tab-group__scroll--table` padding-top 1rem→0（工具栏上方空白）、底部 1.5rem→0.5rem；表头 th 上下 padding 0.35→0.15rem + `white-space: nowrap`，列名按钮（`.fn-table__sort`）`min-width:0 + overflow:hidden + text-overflow:ellipsis`——列名过长省略号截断，表头恒单行。
6. **智能全选（Ctrl/⌘+A）**：VaultApp 全局 keydown 新分支——焦点在 input/textarea/contentEditable 内不拦截（原生/组件行为不变：编辑器内选正文、表格格内两段式）；否则按当前内容分发：AI 会话打开→DOM Range 选中 `.fn-ai-workbench__messages` 整段对话；否则调用活动分组注册的 select-all——`NoteEditor` 新 `onRegisterSelectAll` prop（WYSIWYG 用 Tiptap selectAll，源码模式必须走 CM state dispatch——CM 只渲染可见行，DOM 选区不可行）、`TableEditor` 新 `onRegisterSelectAll`（全格选区 + focus 容器使后续 Mod+C/Esc 生效），注册模式同 findReplaceByGroupRef（`selectAllByGroupRef`）。
7. README 双语同步（表格条目 + 界面条目 + 智能全选），版本随提交 minor bump **v0.16.0**（server 不变 0.7.2），全仓 typecheck 全绿。

**追加（2026-07-15 第三十四轮，表格三连：统一行高/双击自适应列宽 + 插入方向选项 + 公式点选引用与整列引用，随 git 提交 minor bump 至 **v0.15.0**）**：
1. **整列公式引用**：`formula.ts` 的 `parseArg` 增列-only token 支持（`parseColOnlyToken`，纯字母），`C:C`、`A:C`、混合 `C1:C` 均展开为该列（组）全行范围（空表返回 []）；`=A+1` 这类裸列名仍报 `#NAME?`（只有函数参数里的 `X:Y` 语法生效）。冒烟测试 9 断言全过（编译 formula.ts 为 CJS 后 node 跑）。
2. **公式点选引用（Excel 式）**：`TableEditor` 新增 formula-pick 机制——`activeFormulaEdit()` 用 `document.activeElement`（cell textarea 且值以 = 开头，data-row/col-idx 定位）判定"正在编辑公式"；此时 `handleCellMouseDown` 对其他单元格 `e.preventDefault()`（阻止焦点转移）并写入引用（`writeFormulaRef`：插入到光标处；若光标仍停在上次插入的引用末尾则**替换**上次引用，Excel 连续点选换目标语义）；`handleCellMouseEnter` 在按住拖动时把引用扩为规范化 `A1:B3` 区间（drag 中走 `onChangeRef` 不进 undo 栈，mousedown 那次才 emitChange 进历史）；window mouseup 结束 pick。**列号按钮**（`fn-table__col-letter`）onMouseDown 在公式编辑态插入 `C:C` 并用 `suppressColSelectRef` 吃掉后续 click 的 selectColumn。行引用一律用**文档序行号**（`docRowNumber`，与行号列显示一致），排序/筛选下引用不漂移。光标用 rAF 在重渲染后 setSelectionRange 到引用末尾。
3. **统一行高**：utils 新 `setAllRowHeights(doc, h|undefined)`（undefined 清所有显式行高恢复自动）；工具栏 ↕ 弹层（number 输入 + 应用到所有行/恢复自动，`.fn-table-rowheight-pop`）。
4. **双击自适应列宽**：列宽拖柄 `onDoubleClick` → `autoFitColumn`：canvas measureText 测量表头名（+76px 按钮空间）与每格显示值（公式取计算结果、数字格式取格式化后文本、多行取最长行，尊重 bold/fontSize 单元格样式），+16px padding 后 `setColumnWidth`（内部 clamp 48-1200）。顺带修复：拖柄 mouseup 未移动时不再 emit 无操作宽度提交（避免双击污染 undo 历史）。
5. **插入方向选项**：`insertDir`（'before'|'after'，localStorage `fastnote_table_insert_dir` 全局持久化，默认 before 与旧行为一致）；工具栏 +列/+行旁的下拉（插入于上方/左侧 / 下方/右侧）；`handleAddColumn` at=colStart 或 colEnd+1，`handleAddRow` 映射显示行→文档行后取 edge±；before 时选区顺移，after 时选区不动。
6. i18n 新增 insertDir*/uniformRowHeight*/helpFormulaRef/clearFormatting 等，colResizeTitle 提示双击自适应；帮助弹层加公式点选引用说明；README 双语表格条目重写。版本随提交 minor bump **v0.15.0**（server 不变 0.7.2），全仓 typecheck + web build 全绿。

**追加（2026-07-15 第三十三轮，聊天多行输入 + 桌面代理 + 去标题栏/表格紧凑化 + 清除格式 + 简洁主题，随 git 提交 minor bump 至 **v0.14.0**）**：
1. **聊天多行输入**：`ChatPanel` 输入框由 `<input>` 换成自动增高 `<textarea>`（max-height 9.5rem 后内部滚动），Enter 发送（尊重 IME composing）、Shift+Enter 换行；消息体 `.fn-chat__text` 本就 pre-wrap 无需改。placeholder 双语提示 Shift+Enter。
2. **网络代理（桌面版）**：`packages/api` 新增 `ProxySettings{mode:'none'|'http'|'socks5',host,port}` + load/save（localStorage `fastnote_proxy`）+ `proxyRulesFromSettings`（生成 Chromium proxyRules 如 `socks5://127.0.0.1:1080`）。Electron main 新增 IPC `fastnote:setProxy` → `session.defaultSession.setProxy` + `closeAllConnections()`（强制存量 wss 走新路由重连），preload/`window.fastnote.setProxy` 暴露，`packages/storage` 的 Window 声明同步。VaultApp 启动即应用并随保存实时生效。设置 → 账户与同步 加「网络代理」区（模式下拉 + host + port，`.fn-proxy-row`）。**关键限制**：浏览器不允许页面自行指定代理，网页版此设置仅展示 + 提示用系统/浏览器代理（hintWeb 明示）——用户原话要求网页版支持，实际只能做到桌面版，README/设置里都写清了。
3. **去标题栏 + 表格紧凑化**：笔记/表格面板头部的 `fn-note__title` 大标题输入框整个移除（改名统一走侧边栏 F2/✎/双击），相关 CSS 删除；`.fn-tab-group__header` padding 0.9→0.5rem、表格工具栏/导出栏按钮 padding 与 gap 全面收紧（0.35/0.75→0.22/0.5rem 等）、统计栏 margin/padding 减小。**筛选栏可收起**：`TableEditor` 新 `showFilters` state（localStorage `fastnote_table_filters_visible` 全局持久化，默认显示），工具栏 ▽ 按钮切换；**收起时清空 filters**，避免行被看不见的筛选条件隐藏。
4. **清除格式按钮**：工具栏新按钮（删除线 T 图标 `.fn-table-fmt__clear`），`clearFormatting()` 清 formatTargets 的 bold/fontSize/color/fill（`applyCellStyle` 传 undefined 即删键）；当选区覆盖整列（rowStart===0 && rowEnd>=displayRows.length-1）时同时 `setColumnFormat(colId, undefined)` 清数字格式。i18n `clearFormatting/showFilters/hideFilters`。
5. **简洁主题**：`UiThemeId` 增 `'simple'`（第五套），`:root[data-theme="simple"]` 仿 Google Docs/Sheets 默认配色——bg #f8f9fa、surface 纯白、border #dadce0、text #202124、muted #5f6368、accent #1a73e8/soft #e8f0fe、radius 收小到 6/8px；`.fn-table-wrap` 补 `background: var(--surface)` 使表格内容区在该主题下为纯白（其他主题也统一用 surface 色）。swatch #dadce0，i18n `theme.simple`（简洁/Simple）。移动端 App 复用 web styles.css，自动获得该主题。
6. README 双语同步（聊天多行、五套主题、去标题栏/紧凑布局、代理说明），版本随提交 minor bump **0.14.0**（server 保持 0.7.2），全仓 typecheck + web build 全绿。

**追加（同日第三十二轮，协作标题同步 + 侧边栏协作徽标，随 git 提交 minor bump 至 **v0.13.0**）**：
1. **文件名（标题）实时同步**：`CollabMessage` 增 `kind:'title'` 与 `title` 字段——标题是短整值，走**整值广播 + LWW**（不做 diff）；`CollabSessionOptions` 增 `getTitle/applyRemoteTitle`，会话内部持 `titleShadow` 抑制回声与无变化广播（`updateLocalTitle` 同样 400ms debounce）。`state` 消息（hello 应答）现携带 `title`，新加入者同时采纳内容与标题；晚到 state 的标题按 titleShadow 比对 LWW。VaultApp：`updateNoteById` 钩子扩展 `patch.title !== undefined → session.updateLocalTitle`；`applyCollabRemote` 泛化为 `applyCollabRemotePatch(noteId, patch)`（title 变更不 bump 编辑器 nonce——标题输入框/标签页/侧边栏都直接渲染 state）。
2. **侧边栏协作徽标**：`NoteTree` 新增 `collabIds?: Set<string>` prop（VaultApp 从 `collabUi` 键 useMemo 派生），协作中的条目在标题后渲染 `👥` 绿色药丸徽标（`.fn-collab-tree-badge`，2.4s 呼吸脉冲动画 + title 提示 `noteTree.collabActive`）。注意 `.fn-tree-node__label` 是硬列宽 grid，模板从 4 列扩到 5 列（icon|text|协作徽标|同步点|冲突点），否则新增子元素会掉到隐式新行。
3. e2e 重跑（标题场景 5 断言全过）：后加入者同时采纳内容+标题、双向改名传播、内容编辑与改名并发互不干扰。README 双语同步（协作条目补标题同步与徽标）。版本随提交 minor bump **0.13.0**（server 保持 0.7.2），typecheck + web build 全绿。

**追加（同日第三十一轮，协作房间号防冲突，v0.12.1 → 并入 0.13.0 提交）**：用户指出仅由密码派生房间会导致**不同文档设置相同密码时撞进同一房间互相串内容**。修复：协作房间引入**随机房间号**——`packages/collab` 新增 `generateCollabRoomCode()`（8 字符无易混淆字母表 A-Z2-9 去 0/O/1/I/L，格式 `XXXX-XXXX`，crypto.getRandomValues）和 `normalizeCollabRoomCode()`（容忍小写/丢横线/空白）；`deriveCollabRoom(password, roomCode)` 把房间号作为 PBKDF2 的盐（`fastnote-collab-v1:` + 规范化房间号）——同密码不同房间号派生出完全不同的 roomId/roomKey，顺带消除固定盐的预计算风险。流程：发起方点 🎲 生成房间号，连同密码线下告知对方；加入方填两者。UI：`CollabJoinForm` 加房间号输入行 + 🎲 生成按钮（校验：房间号规范化后 ≥4 字符）；会话激活弹层显示当前房间号（`collabRoomCodes` state，`user-select: all` 的 code 样式便于复制）；退出/锁库清理。服务器协议零改动（roomId 仍是不透明 hex）。i18n 新增 `collabRoomPlaceholder/collabGenerateRoom/collabRoomMissing/collabActiveRoom`，collabHint 重写；README 双语同步。**e2e 重跑 12 断言全过**，新增关键断言：同密码+不同房间号的第三方 C 独居自己房间、A/B 编辑全程不泄漏给 C；B 用小写+空格的房间号也能正确入房。版本 patch bump **0.12.1**（server 保持 0.7.2），typecheck 全绿，未提交。

**追加（2026-07-14 第三十轮，笔记/表格实时协作 = E2E 密文中继房间，随 git 提交 minor bump 至 **v0.12.0** / server 0.7.2）**：用户要求"笔记/表格加入实时协作，通过中继服务器，按钮协商密码加入/退出，不影响安全语义"。
1. **安全模型（零知识不变）**：协作密码线下协商、永不上服务器。新包 `packages/collab` 的 `deriveCollabRoom(password)`：PBKDF2-SHA256 600k（与库主密码同强度，固定盐 `fastnote-collab-v1`）→ HKDF 两路独立子密钥——`roomId`（16 字节 hex，服务器唯一可见的东西）和 `roomKey`（AES-256-GCM，加密全部载荷）。服务器只在内存转发密文（不落盘、不打日志），能看到"谁在跟哪个不透明房间说话 + 流量"，永远看不到内容/标题/笔记身份。
2. **server `/ws/v1/collab`**（0.7.2）：复用 `authTokenFromReq`（需登录 token，防匿名滥用），query `room` 校验 `/^[a-f0-9]{16,64}$/`；内存 `Map<roomId, Set<WebSocket>>`，join/leave 广播 `{type:'peers',count}`，`{type:'data',payload}` 原样转发给房间内其他成员，无任何持久化。
3. **同步协议（`CollabSession`，diff 增量）**：非 CRDT——差分同步 lite。每客户端持 `shadow`（上次与房间交换的文本）；本地编辑 debounce 400ms 后广播 `diff-match-patch` 补丁（shadow→text），收到补丁**同时 fuzzy apply 到本地文本和 shadow**。新加入者发 `hello`，持有状态的成员回 `state` 全文（自己也在等状态的保持沉默，防两个新人互换旧文档；`peers===1` 时自动视为内容源）；补丁应用失败或表格 `validate` 不过 → 重发 hello 全量重同步。**加入活跃会话会采纳会话内容**（UI 弹层里明示）。断线 2.5s 自动重连（同 IMClient 模式）。
4. **编辑器接入**：笔记/表格统一走 `contentMd` 文本 patch（表格是单行 JSON，dmp 字符级补丁对不同单元格的并发编辑天然可合并；`handleCollabJoin` 给表格配 `validate`——合并结果必须仍是 version===1 的合法 JSON，否则丢弃转全量，坏补丁**不可能**毁表）。`NoteEditor`：源码模式 content prop effect 从整文替换改为**公共前后缀最小 diff dispatch**（CM 自动映射光标，远端编辑不再拽走本地光标）；新增 `externalContentNonce` prop——渲染模式故意忽略同 noteId 的 content 变化（lastLoadedNoteRef guard），nonce 变更 = "这是外部（房间）来的变化，应用它"，setContent 后恢复（钳制）光标位置。表格无需改动（TableEditor 每次渲染都从 prop re-parse）。
5. **VaultApp**：`collabSessionsRef Map<noteId, CollabSession>`（socket 持在 ref）、`collabUi`（连接状态/人数）、`collabContentNonce`。本地编辑钩在 `updateNoteById`（`patch.contentMd !== undefined` 时 `session.updateLocal`；重入安全：远端 apply 后 shadow 已等于文本，flush 是 no-op，无需 guard 旗标）；`applyCollabRemote` 直接 setNotes + schedulePersist（不记编辑焦点历史）+ bump nonce。UI：笔记控制条与表格导出条各加「👥 协作」按钮（连接中显示人数、active 高亮）→ 弹层：未加入时 `CollabJoinForm`（密码≥6 位、需登录、Enter 提交、密码只存组件本地 state 用完即弃），已加入时状态点（绿/黄/红）+人数+退出按钮。锁库时关闭全部会话。
6. i18n `vaultApp.collab*` 14 键（中英）；styles.css `.fn-collab-modal/.fn-collab-dot--*`。**e2e 冒烟已过**：真实 server + 两个 CollabSession（Node 22 原生 WebSocket）——单人房自持状态、后加入者采纳全文、单边编辑传播、**双端并发编辑（头部+尾部）收敛一致**、退出人数广播，7 断言全过。**无本地文档的加入流程**（README 双语 + collabHint 已写明）：新建同类型空白文档（笔记对笔记、表格对表格）→ 👥 协作 → 相同密码 → 自动采纳会话内容。版本：随 git 提交 minor bump，17 客户端包（含新包 collab）= **0.12.0**，server **0.7.2**（需重新部署），typecheck 全绿。
**取舍备忘**：diffsync 非 CRDT，小房间（2-3 人）收敛良好但重度并发同一行无理论保证；协作需登录（中继防滥用）；渲染模式远端应用会整文 setContent（光标近似恢复），源码模式体验最佳。

**追加（2026-07-14 第二十九轮，Android 移动版首版 = AI 助手壳层，v0.11.4 本地 patch 未提交）**：用户要求适配 Android，允许"工作量大就先只做 AI 助手"。技术路线选 **Capacitor 包壳**（代码库是 React + IndexedDB + localStorage，WebView 内全部原样可用；React Native 需重写、PWA 无商店分发/原生壳），首版范围 = **解锁/建库 + AI 助手**（桌面 UI 的双分组标签页/侧栏树在手机上不可用，完整移动化留待后续）。
1. **新 workspace `apps/mobile`**（`@fastnote/mobile`，Vite 端口 5174）：`src/MobileApp.tsx` 是精简壳——复用 `UnlockScreen`（本地库选择/创建/解锁全套；`onCloudSync` 直接 reject `mobileApp.cloudNotSupported`，移动版暂无云同步）+ `AiSessionTree`（左侧抽屉弹层）+ `AiWorkbench`（主区）+ 自写 `MobileSettings` 弹层（API key/模型含自定义/max_tokens/联网搜索及次数/语言，保存逻辑同 VaultApp：`META_KEYS.aiSettings` 用 masterKey 加密）。解锁/建库序列、AI 会话 CRUD、`runAiRequest` 流式（含 thinking/webSearch/超时/中止保留部分文本）全部照搬 VaultApp 对应逻辑（**不建 identity keys、不 loadNotes**——移动版用不到）；**库格式与桌面完全一致**（同一套 IndexedDB 布局，`ai_sessions_local` notesKey 加密）。移动端无笔记编辑器，AiWorkbench 的 `onConvertToNote` 改为**分享/复制 Markdown**（`navigator.share` 优先，回落 execCommand 剪贴板）。
2. **样式**：`main.tsx` 直接 import `../../web/src/styles.css`（该文件自包含，KaTeX CSS 由 MarkdownView 自带）+ `mobile.css` 覆盖层：`100dvh` flex 布局、safe-area insets、抽屉/设置弹层样式、`@media (pointer: coarse)` 下把 hover 门控的 `.fn-ai-tree__actions`/`.fn-ai-msg__actions` 常显、消息全宽、触控目标加大。
3. **CSP**：`index.html` 同款 parse-time `document.write` 引导脚本，但 connect-src 只有 `'self' + api.anthropic.com`（无云同步故不加服务器源）。
4. **Capacitor**：`@capacitor/core+android+cli@^8.4.1`；`capacitor.config.ts`（appId `com.fastnote.mobile`，webDir dist）；`cap add android` 已生成原生工程（`apps/mobile/android/` 已入库，`assets/public` 等生成物加进根 .gitignore）。脚本：根 `dev:mobile / build:mobile / android:sync / android:open / android:apk`。**本机无 Android SDK/JDK，APK 需装 Android Studio 后构建**；`pnpm typecheck` 全绿 + vite build 通过 + dev server 冒烟（注意本机 vite 只绑 IPv6 `::1`，curl 需用 `[::1]`）。
5. i18n 新增 `mobileApp.*`（sessions/settings/lock/noSession/cloudNotSupported/copiedAsMarkdown/copyFailed，中英）。README 双语补 Android 条目与构建章节。版本 patch bump **0.11.4**（16 客户端包 + mobile 即 0.11.4，server 保持 0.7.1），未提交。

**追加（2026-07-13 第十八轮，7 项需求批次，v0.9.1）**：
1. **AI 联网搜索**（像 Claude App 一样在回复过程中检索网络）：用 Anthropic **服务端 web search 工具**（`tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]`），搜索全在 Anthropic 侧单请求内执行——**客户端零新增网络连接，CSP 不用动**。`packages/ai`：`StreamMessageOptions` 增 `webSearch?`/`onWebSearch?(total)`，SSE 解析 `content_block_start` 的 `content_block.type === 'server_tool_use'` 计数（正文仍走 text_delta，引用自动内联），`StreamMessageResult` 增 `webSearches`。`AiSettings.webSearch?`（默认关），设置 AI tab 加复选框；`aiRun` state 增 `webSearches` → AiWorkbench 无正文时显示"正在联网搜索（第 N 次）…"（优先于思考中提示），流式正文下方显示"已联网搜索 N 次"（`.fn-ai-msg__websearch`）。注意：历史只存纯文本，多轮时不回传 encrypted_content（引用上下文不跨轮，可接受）。i18n：`aiWorkbench.webSearching/webSearched`、`settingsModal.ai.webSearchLabel/webSearchHint`。
2. **渲染模式长文查找不能跳转修复**：PM 的 `tr.scrollIntoView()` 在长文档（真正的滚动容器是 app 层 pane）上不可靠。`NoteEditor.scrollToActive` 在 dispatch 后加 `requestAnimationFrame` 里直接对 `.fn-find-match--active` 装饰元素 `scrollIntoView({ block: 'center' })`（等装饰渲染完再滚，PM 路径保留兜底）。
3. **全局搜索精准定位**：搜索结果点击后 `locateNoteInSource(id, query)`（setTimeout 0 等 openNote state 落地）：仅对 `nodeType==='note'` 生效（表格无源码视图），把所在分组 `editorModeByGroup` 切到 source，`setFindBarGroupId` + 新 state `findInitialQuery` 打开查找栏。`FindReplaceBar` 新增 `initialQuery` prop：挂载后**轮询 getController（120ms×20）**直到 CM 控制器注册完成再 search（查找栏与源码编辑器同一 commit 挂载，控制器注册晚于 bar 的 effect）。手动 Ctrl+F 和关闭时清空 initialQuery。新增 `groupsRef`。
4. **文件夹 F2 重命名焦点错误修复**：F2 目标从 `activeIdRef`（活跃标签页的笔记！）改为 **`treeAnchorIdRef ?? activeIdRef`**（侧栏最后点选的节点，文件夹点选会设 anchor）；同时 `selectTabInGroup` 补设 `treeAnchorIdRef = tabId`，保证点选标签页后 F2 仍指向该笔记而不是残留的侧栏行。
5. **同步失败日志给详细原因**：`ApiClient` 新增 `httpError(res, op, key)`——console.error 真实原因（端点、HTTP 状态、响应体前 500 字符）后再抛本地化笼统文案，应用于 vault-salt/keys/notes/attachments/chat 全部 push/pull；`assertAuthed` 的 401 也 console.warn 端点。`handleSync` catch 里 `console.error('[FastNote] sync: failed', err)` 捕获网络层错误（Failed to fetch 等）。日志查看器（console capture）都能看到。
6. **运行日志本地时间**：`logBuffer.ts` 的 ts 从 `toISOString()`（UTC）改为 `formatLocalTs()`（`YYYY-MM-DD HH:mm:ss.SSS` 本地时区）。
7. **表格单元格 Shift+Enter 格内换行**：`TableCellContent` 的文本 `<input>` 换为 **`<textarea rows={行数}>`**（按显示值换行数自动增高；CSS `.fn-table-cell__text` 加 resize:none/overflow:hidden/pre-wrap/block）。`handleCellKeyDown`：Shift+Enter 放行（textarea 原生插入换行），裸 Enter 仍 preventDefault 下移一行；`focusCellInput` 选择器 `input[...]` → `textarea[...]`。粘贴/复制路径不受影响（dataset 定位、activeElement 检查本就含 textarea）。
版本 patch bump 至 **0.9.1**（16 个 package.json，server 仍独立 0.7.0），`pnpm -r typecheck` + `pnpm build` 全绿，未提交。

**追加（同日第二十八轮，源码输入换行仍丢失的根治，v0.11.3 本地 patch 未提交）**：0.11.2 修复后用户反馈源码输入的换行切换时仍丢。根因是 0.11.2 的边界规则是照"理想解析"推导的，与 **@tiptap/markdown 真实解析行为**不符：① marked 对"text\n"（末尾单个换行）**根本不产生 token**（段落直接吸收），最后一个回车必丢；② @tiptap/markdown 对 `space` token 有**隐式空段落**逻辑（`createImplicitEmptyParagraphsFromSpace`：每对 \n\n 计 1，**边界处不减 1**），尾部 "\n\n" 会额外产出一个空段落，与 0.11.2 的 NBSP 尾部规则**双重计数**。重写 `preserveBlankLines` 尾部规则：`/\n+$/` 整段消费（n 个换行 → n 个 NBSP 段落，**字符串结束在最后一个 NBSP 上、不留尾换行**）——解析器再也见不到尾部换行，隐式段落逻辑无从触发；序列化端 `serializeDocJsonToMarkdown` 尾部哨兵还原公式从 m+1 改为 **m 个换行**（同时覆盖渲染模式在文末回车产生的真空段落）。**验证方式升级**：不再用手写 fakeParse，用真实 marked lexer（同配置 breaks+gfm）+ 照抄 @tiptap/markdown 源码的 parseTokens 隐式空段落算法，18 个断言全过（含尾部单换行、围栏后空行、纯空白文档、二次往返不动点）。
**教训**：涉及第三方解析器的往返保真，必须对着真实 token 流验证（`m.lexer()` 直接 dump），凭 CommonMark 直觉推导边界行为会错。

**追加（同日第二十七轮，换行丢失修复 + 表格插入行列位置，v0.11.2 本地 patch 未提交）**：
1. **渲染模式换行符丢失修复**（切源码/切文件后 \n 消失）：渲染模式编辑触发 `serializeDocJsonToMarkdown` 时有三处真实丢失——① **代码块内连续空行被吃**：序列化末尾无条件 `\n{3,}→\n\n` 折叠连代码围栏里的字面空行一起折了（`preserveBlankLines` 解析侧本来就跳过围栏，不对称）；改为按 `FENCE_OR_CODE`（从 blankLines 导出）split 后只折叠代码外部分。② **文档尾部空行被 trimEnd 全吞**：`preserveBlankLines` 加尾部规则（`([^\n])\n{2,}$`，n 个换行 → n-1 个 NBSP 段落），序列化时先数尾部哨兵段 `(?:\u0000\n)+$`（m 个 ⇒ 还原 m+1 个换行）再 trimEnd 其余。③ **文档头部空行被 markdown 静默丢弃**：`preserveBlankLines` 加头部规则（`^\n+`，每个换行一个 NBSP 段落，序列化天然还原）。用 esbuild 打包后 12 个往返断言全过（首尾/中部空行、hardBreak、代码块内空行）。
2. **表格 +行/+列 按选中位置插入**：`utils.addColumn/addRow` 加可选 `index` 参数（splice 插入，越界钳制）；`handleAddColumn/handleAddRow` 有选区时插到 `selectionRange.colStart` / 行为 display→doc 映射（`displayRowsRef[rowStart].id` 找 doc 下标）之前，无选区仍追加末尾；插入后选区坐标 +1 保持原单元格仍被选中。F4 重复沿用同逻辑。注意：中途插入会移动后续行列的稳定编号，公式引用会跟着位移——与既有 Alt+方向键调序同一取舍。
版本 patch bump **0.11.2**，typecheck + web build 全绿，未提交。

**追加（2026-07-14 第二十六轮，3 项小需求，v0.11.1 本地 patch 未提交）**：
1. **鼠标中键矩形选区（列选/列编辑）**：笔记源码模式（CodeMirror）加 `rectangularSelection({ eventFilter: e => e.button === 1 })`——中键拖拽产生按列的矩形选区（每行一个光标，可同时编辑）；basicSetup 自带的 Alt+左键拖拽矩形选区保持不变。仅源码模式（ProseMirror 渲染模式无列选概念）。
2. **AI 查找框保留并显示换行符**：`.fn-ai-findbar` 的查找输入从 `<input>`（\n 无法显示）改为自增高 `<textarea>`（rows=行数，与 FindReplaceBar 同款），Ctrl/⌘+Enter 手动插入换行、Enter 仍是下一处；CSS 选择器 input → textarea（加 resize:none/overflow:hidden/pre-wrap）。Ctrl+F 多行选中预填现在能完整显示。
3. **表格 Ctrl/⌘+A 全选**：`handleContainerKeyDown` 新增——电子表格式两段行为：正在编辑的单元格文字未全选时第一次按走原生（全选格内文字），已全选或不在编辑态时 preventDefault 并把选区设为整个网格（selAnchor 0,0 → selFocus 末行末列），配合既有 Mod+C 路径可整表复制 TSV。帮助弹层加 `tableEditor.helpSelectAll`（中英）。
版本 patch bump **0.11.1**，typecheck + web build 全绿，未提交。

**追加（同日第二十五轮，AI 查找滚动改为容器直滚，随 git 提交 minor bump 至 **v0.11.0**）**：0.10.2 后用户确认渲染模式高亮已显示，但"查找下一个"视口仍不动。对 mark 元素 `scrollIntoView({block:'center'})` 在渲染 markdown 视图里被静默吞掉（与 NoteEditor 曾遇到的 PM `tr.scrollIntoView()` 不可靠同类问题），修复两层：① 新增 `scrollFindMarkIntoView(mark)`——不再依赖 `scrollIntoView`，直接对**已知滚动容器** `messagesRef`（`.fn-ai-workbench__messages`）用 `getBoundingClientRect` 差值计算并写 `container.scrollTop`（把 mark 居中）；② `stepFind` 每次步进时**实时重新收集** mark 列表（`collectFindMarks`，DOM 序 + `getClientRects` 可见过滤），彻底消除 React 重渲染替换节点后缓存列表指向游离元素的可能，计数同步刷新。README 中英双语功能清单同步 0.9.x–0.10.x 新特性（查找替换条目改写为"笔记/表格/AI 会话全覆盖 + 多行查询 + 选中预填 + 全局搜索定位"、表格条目补 Shift+Enter 多行单元格往返、AI 区新增联网搜索条目）。版本随提交 bump **0.11.0**（server 保持 0.7.1），typecheck + build 全绿。
**经验沉淀**：本项目里 `scrollIntoView` 已两次不可靠（PM 装饰、AI mark），涉及自定义滚动容器时优先直接计算 `scrollTop`。

**追加（同日第二十四轮，AI 渲染模式查找高亮改为 React 渲染管线，v0.10.2）**：0.10.1 的 katex 过滤后用户反馈渲染模式仍不动且 response 里**完全没有高亮**——事后对 `dangerouslySetInnerHTML` 内容做 DOM 手术的方案不可靠（会被 React 协调覆盖/清除），彻底放弃 DOM 注入，改为**高亮成为渲染输出的一部分**：
1. `MarkdownView` 新增 `highlightQuery?` prop + 导出 `highlightHtml(html, query)`——用 `DOMParser` 解析已消毒的 HTML，TreeWalker 遍历文本节点（`closest('.katex')` 子树跳过，理由同前），把命中包成 `<mark class="fn-ai-find-mark">` 后序列化回字符串。**两级 useMemo**：`renderMarkdownHtml`（贵，marked+KaTeX）只依赖 markdown；highlight pass（便宜的 DOM walk）依赖 [base, highlightQuery]——输入查询逐字符敲击不会重跑 markdown 渲染。
2. `AiWorkbench`：源码 `<pre>` 和用户 plain 消息用新 helper `renderHighlightedText(text, query)`（纯 React 节点切分，返回 text/<mark> 数组）；`findActiveQuery = findOpen ? findQuery.trim() : ''` 传入所有消息体（含流式）。原"注入 effect"简化为**收集 effect**：只 `querySelectorAll('mark.fn-ai-find-mark')` 按 DOM 序收集可见 mark（`getClientRects().length > 0` 过滤）维护索引/计数/当前类/滚动，逻辑不变（query 变化才自动滚动）。
版本 patch bump **0.10.2**，ui/app typecheck + web build 全绿，未提交。

**追加（同日第二十三轮，AI 渲染模式查找"下一处不动"修复，v0.10.1）**：源码模式已正常，渲染模式仍卡住。根因是 **KaTeX**：每个公式的 HTML 里带一份隐藏的 MathML 副本（`.katex-mathml`，display:none，含完整 TeX 源码文本），TreeWalker 会把查询串在其中的命中也包成 mark——对隐藏元素 `scrollIntoView` 是 no-op，步进走到这些不可见 mark 时视口"不动"；且往 KaTeX 逐字形 span 里注入 mark 还可能破坏公式排版。修复两层：① TreeWalker 加 `acceptNode` 过滤器，`parentElement.closest('.katex')` 命中的文本节点一律 REJECT（可见的 KaTeX HTML 本来就按字形碎片化，多字符查询不可能命中）；② 收集 mark 列表时按 `getClientRects().length > 0` 过滤掉一切不可见 mark（兜底任何隐藏区域）。版本 patch bump **0.10.1**，typecheck + build 全绿，未提交。

**追加（同日第二十二轮，AI 查找导航修复，随 git 提交 minor bump 至 v0.10.0）**：
**AI 会话查找跳转怪异修复**（渲染/源码模式都乱跳）：根因是导航按**消息**粒度——`scrollIntoView({block:'center'})` 作用在整条消息元素上，长回复比视口还高时"居中"落在消息中部，看起来像跳到无关位置；且同消息内多个命中会被整体跳过。重构为**逐个命中（mark 元素）导航**：高亮 effect 注入 `<mark>` 后收集 DOM 序（即时间序）的 mark 列表进 `findMarksRef`，`findIdxRef` 为当前命中源头（state 只做计数展示 `findIdx+1/findTotal`）；↑↓/Enter 步进直接对当前 mark 加 `.fn-ai-find-mark--current`（橙色）并 `scrollIntoView({block:'center'})`——mark 是小元素，定位精准。查询变化时（`lastFindQueryRef` 比对）重置索引并滚到首个命中；流式更新重建 mark 时只恢复 current 类**不滚动**（防止视口被拽走）。消息级 `data-msg-idx`/`.fn-ai-msg--find-current` 描边随之移除。版本随提交 bump **0.10.0**（server 保持 0.7.1）。

**追加（同日第二十一轮，多行查找 + 查找高亮 + 表格 Enter 焦点框，v0.9.4）**：
1. **查找替换支持多行内容**：`FindReplaceBar` 的查找/替换输入框从 input 改为**自增高 textarea**（Enter=下一个/替换、Shift+Enter=上一个不变，**Ctrl/⌘+Enter 插入换行**，`insertNewlineAtCaret` 手动插入并恢复光标；title 提示 `findReplace.multilineHint`；CSS `.fn-findbar__row textarea` 与 input 同款式+pre-wrap）。Ctrl+F 预填不再截取首行（保留完整选中文本，去首尾换行，上限 500 字符）。引擎侧：CM 源码模式 SearchCursor 原生支持含 `\n` 的字面查询；**渲染模式 `FindReplaceExtension.findMatchesInDoc` 重写为扁平化匹配**——`flattenDoc` 把文档打平成字符流（文本字符带 PM 位置、hardBreak 记 `\n`、textblock 之间插虚拟 `\n`（pos -1）、其它 inline 原子记 `\u0000` 使匹配永不跨越），在打平文本上 indexOf，PM range 锚定首尾真实字符——顺带解决了"匹配不跨节点"的旧限制（半加粗单词现在也能命中）；跨段落 replace 语义 = insertText 合并段落。表格（indexOf 原始值）与 AI（includes）天然支持多行。
2. **表格查找命中高亮**：`TableEditor` 新增 `findMark` state（query + current 坐标），控制器的 highlight/search/close 同步维护；渲染时含查询串的单元格加 `.fn-table__cell--find`（inset box-shadow 黄色蒙层，可盖过单元格自定义填充色），当前匹配格加 `--find-current`（橙色 outline）。textarea 内无法做文本级 mark，属单元格级高亮取舍。
3. **AI 会话查找文本高亮**：`AiWorkbench` 新增 DOM effect——先解包旧的 `mark.fn-ai-find-mark`（replaceChild + normalize 保持幂等），再对每个 `.fn-ai-msg__body` 用 TreeWalker 遍历文本节点、把命中片段包进 `<mark class="fn-ai-find-mark">`（黄色圆角）。markdown 经 dangerouslySetInnerHTML 渲染对 React 不透明，DOM 注入安全；跨元素（跨段落）匹配不做行内标记，靠消息级描边兜底。deps：findOpen/findQuery/messages/showSource/streamingText。
4. **表格 Enter 焦点框跟随**：`handleCellKeyDown` 的 Enter 下移分支补 `setSelAnchor/setSelFocus` 到下一格——此前只 `focusCellInput`（光标动了但蓝色选区框留在原格）。
版本 patch bump 至 **0.9.4**，typecheck + build 全绿，未提交。

**追加（同日第二十轮，查找体验 + 表格/AI 查找 + 同步 413 修复，v0.9.3 / server 0.7.1）**：
1. **Ctrl+F 聚焦与选中预填**：`FindReplaceBar` 新增 `focusNonce` prop——挂载和每次 nonce 变更时聚焦并全选查找输入框，且 `initialQuery` 非空时载入并搜索（原"仅挂载时轮询"逻辑合并进该 effect，轮询 getController 120ms×20 保留）。`VaultApp` 全局 Ctrl+F 处理器：从 `document.activeElement`（input/textarea 用 selectionStart/End）或 `window.getSelection()` 取选中文本（取首行、trim、截 200 字符）作为 `findInitialQuery`，`findBarNonce` 自增 → 已打开的查找栏也会重新聚焦并预填。`locateNoteInSource` 同步 bump nonce（同一笔记源码态下连点两个搜索结果也能更新查询）。
2. **表格支持查找/替换**：`TableEditor` 新增 `onRegisterFindReplace` prop，注册实现 shared `FindReplaceController` 的控制器（挂载一次，全部查询走 `docRef`/新增 `displayRowsRef`，回调经 ref 保鲜）：匹配为**出现级**（单元格原始值大小写不敏感 indexOf 扫描，按显示行序×列序），当前匹配用**单格选区高亮**（setSelAnchor/Focus）+ rAF 后 `textarea[data-row-idx][data-col-idx].scrollIntoView({block:'center'})`；replace 替换当前匹配出现处（updateCell + emitChange，走统一 undo；替换后针对新 doc 直接算状态——docRef 要下一帧才刷新）；replaceAll 按格去重后单次多格替换。`VaultApp` 表格分支头部渲染同一个 `FindReplaceBar`（findBarGroupId 机制复用），`TableEditor` 挂 `onRegisterFindReplace` 写入 `findReplaceByGroupRef[group.id]`。
3. **AI 会话查找**：AI 会话打开时 Ctrl+F 转发为 `aiFindRequest {nonce, query}` state（新增 `activeAiSessionIdRef`）→ `AiWorkbench` 新 prop `findRequest`：nonce 变更时打开内置查找栏（`.fn-ai-findbar`，输入框+计数+↑↓+×，Enter/Shift+Enter 前后跳，Esc 关闭；切 session 复位）。匹配是**消息级**（content 含查询串的消息索引列表，useMemo），当前匹配消息 `data-msg-idx` 定位 scrollIntoView + `.fn-ai-msg--find-current` 描边高亮（渲染后 markdown 内不做行内高亮，属首版取舍）。
4. **同步 413 修复**：Fastify 默认 bodyLimit 1MB，大笔记 PUT /sync/notes 直接 413（FST_ERR_CTP_BODY_TOO_LARGE）。server 加 `bodyLimit: 32MB`（与 WS maxPayload 对齐），**需要重新部署服务器**；客户端 `ApiClient.httpError` 对 413 抛专用文案 `apiClient.payloadTooLarge`（提示升级服务器或拆分超大笔记/附件）。server 版本 0.7.0 → **0.7.1**。
版本 patch bump 至 **0.9.3**，typecheck + build（web/server）全绿，未提交。

**追加（同日第十九轮，3 项跟进，v0.9.2）**：
1. **联网搜索次数可配置**：shared 新增 `AI_WEB_SEARCH_USES_MIN/LIMIT/DEFAULT`（1/50/5），`AiSettings.webSearchMaxUses?`；ai 包 `StreamMessageOptions.webSearchMaxUses`（tools 的 `max_uses`）；设置 AI tab 勾选联网搜索后显示"单次回复最大搜索次数"数字输入（保存时钳制），hint 改为带 {min}/{max}/{def} 插值。i18n：`settingsModal.ai.webSearchMaxUsesLabel`。
2. **笔记附件改为按钮+弹层**（与表格一致）：`showTableAttachments` state 更名 **`showAttachmentsModal`**（笔记/表格共用）；笔记头部控制区（{ } 按钮后）加 📎 按钮（带数量），下方内联 `renderAttachmentsPanel` 移除，改为与表格相同的 `fn-attach-modal` 弹窗（插入引用功能保留）。
3. **多行单元格复制/粘贴不再拆行**（Excel 风格引号语义）：`fill.ts` 新增 **`encodeCellForCopy(value, delimChar)`**（含换行/分隔符/引号的值包双引号、内部引号翻倍）；`parsePasteGrid` 重写为**引号感知**解析（新内部函数 `splitQuoteAware`：字段起始的双引号内换行/分隔符是字面内容、`""` 转义引号、未闭合引号按字面处理；space 模式保持折叠空白+去空段语义；**单个被引号包装的值也走 grid 路径**——否则原生粘贴会把引号字面贴进去）。`buildRangeTsv` 每格过 `encodeCellForCopy`；`handleGridCopy` 单格分支新增：焦点单元格**全选且含换行**时拦截复制为带引号形式（部分选择仍走原生复制）。已用编译后 fill.js 跑 13 个断言全通过（含引号内嵌 tab/换行、转义引号、未闭合引号、space 折叠等）。
版本 patch bump 至 **0.9.2**，typecheck + build 全绿，未提交。

**追加（同日第十六轮，焦点历史记录扩展 + 热键设置化，v0.8.5）**：用户要求点选标签页、光标在页面内容中点选也算焦点切换，且跳转热键可自定义。
1. **记录点扩展**：原来只有编辑（`updateNoteById`）记录焦点历史；现在 ① `selectTabInGroup` 记录目标 tab id（点选标签页）；② `renderGroupPane` 根 div 的 `onMouseDownCapture`（原本只切活跃分组）里对 `content.id` 记录——**排除 `.fn-tabbar` 内的点击**（否则会先记下该分组的旧活跃 tab 再由 selectTabInGroup 记新的，污染历史）。连续同 id 去重逻辑不变，历史上限 100、走回中段后新记录截断前向分支。
2. **热键设置化**：`ShortcutAction` 新增 `focusPrev`/`focusNext`（默认 `Ctrl+Alt+ArrowLeft/Right`）；全局 keydown 从硬编码组合键改为 `matchesShortcut(e, bindings.focusPrev/focusNext)`（`ctrl` 语义同全仓约定：Win/Linux Ctrl 或 mac Cmd 均匹配）。`loadShortcuts` 与默认值合并的机制让老用户自动获得新默认键。SettingsModal 快捷键 tab 加两行（可录制/重置），i18n `settingsModal.shortcuts.focusPrev/focusNext`。
版本 patch bump 至 **0.8.5**，typecheck + build 全绿，未提交。
**追加（同日第十七轮，公式数据丢失修复 + KaTeX 警告静默，v0.8.7）**：用户报告两个问题：日志被 KaTeX "LaTeX-incompatible input / strict mode warn" 刷屏（公式含中文与 en-dash）；**关闭"启用 LaTeX 公式解析"后笔记中的公式文本消失且再启用不恢复**。
1. **数据丢失根因（严重）**：`@tiptap/markdown` 的 MarkdownManager 默认使用 **marked 全局单例**，扩展的 markdownTokenizer（Mathematics 的 `$$`/`$` 规则）通过 `marked.use()` 注册——**不可逆、跨编辑器实例存活**。启用公式的编辑器创建过一次后全局 marked 永久带上 `$$` tokenizer；之后关闭设置重建的编辑器没有 blockMath/inlineMath 节点处理器，但 lexer 仍产出 `blockMath` token → tiptap `parseToken` 找不到 handler → `parseFallbackToken` 走 default 分支，token 的 `tokens` 是**空数组**（truthy）→ `parseTokens([])` 返回 `[]` → **公式整段被静默丢弃**，随后的 autosave 把残缺内容写盘（永久丢失，再开开关也无法恢复）。**修复**：`Markdown.configure({ marked: new Marked() })` 给每个编辑器注入**独立 Marked 实例**（tokenizer 作用域限定在注册它的编辑器；类型上需 cast 为 `typeof marked`，manager 只用实例方法 use/setOptions/lexer/Lexer/defaults，运行时安全）。`packages/editor` 直接依赖 **marked@^17.0.6**（必须与 @tiptap/markdown 的 peer 同 major，v18 类型不兼容曾报 getDefaults 缺失）。副作用为正：全局 marked 不再被编辑器污染（此前 `markedOptions.breaks` 也是 setOptions 到全局的）。已丢的内容无法自动恢复（需旧导出/未同步设备）。
2. **KaTeX 警告静默**：默认 strict 'warn' 对公式内 CJK 字符（unicodeTextInMathMode）和 "–"（unknownSymbol）逐字打 WARN。两处渲染点都加 **`strict: false`**：NoteEditor 的 `Mathematics.configure({ katexOptions })` 和 MarkdownView 的 `katex.renderToString`（KaTeX 本来就能正常渲染这些字符）。
版本 patch bump 至 **0.8.7**，typecheck + build 全绿，未提交。
3. **打开标签页也记录（v0.8.6）**：`openNoteInGroup`（侧栏点选/双击、新建、导入等所有打开入口的汇合点）顶部加 `recordEditFocus(id)`。焦点历史跳转自身也走 openNote，但 `navigateEditFocus` 在打开前已把历史索引指向目标 id，连续同 id 去重守卫使其成为 no-op，不会截断前向分支。版本 patch bump 至 **0.8.6**。

**追加（同日第十五轮，表格自定义分隔符 + AI 消息导出为 Word 文档，v0.8.4）**：
1. **表格分隔符可多选自定义**（作用于粘贴自动分列 + 多格复制）：`fill.ts` 新增 `TableDelimiter`（`tab | semicolon | comma | space`）、优先级序 `DELIMITER_PRIORITY`（Tab > 分号 > 逗号 > 空格——结构化导出优先，空白最泛化垫底）、默认 `['tab','space']`（保持原行为，逗号默认关闭的理由不变）、`loadTableDelimiters/saveTableDelimiters`（localStorage `fastnote_table_delimiters`，应用级全表共享）、`copyDelimiterChar`（复制用生效项中优先级最高的；全不勾时回落 Tab 保证可回贴）。`parsePasteGrid(text, active)` 重写：行仍按换行切，单元格按**第一个在内容中实际出现的生效分隔符**切（Tab 粘贴不会被值内逗号搅乱）；全不勾时不分列（多行粘贴仍逐行填一列）。TableEditor 工具栏帮助按钮左侧新增 **⌗ 按钮** → 复选框弹层（复用 `fn-table-palette` 模式，新样式 `.fn-table-delims-pop*`），状态即时持久化；helpCopy/helpPaste 文案同步更新。
2. **AI 消息导出为文档**：`MarkdownView.tsx` 把渲染管线抽为导出函数 **`renderMarkdownHtml(markdown, { mathAsTex? })`**（extractMathSegments → marked → DOMPurify → 数学段替换；`mathAsTex: true` 时公式保留为转义后的 `<code>$...$</code>` TeX 源码——KaTeX HTML 离开其样式表/字体会显示成重复乱码，独立文档带不动），组件本身改调它。`AiWorkbench` 每条消息的 ⇩ 按钮改为弹出小菜单（`exportMenuIdx` state，样式 `.fn-ai-msg__export-wrap/menu`，`:has()` 保持菜单打开时 actions 可见）：**Markdown (.md)**（原逻辑）/ **Word 文档 (.doc)**——`buildWordDocument()` 用经典 HTML+msword MIME 包装（Word/WPS/Pages 直接打开，无原生 docx 依赖，内置正文/代码/表格/引用基础样式），`downloadText` 加可选 mime 参数。**图片导出按用户许可搁置**（需 html2canvas 类额外方案）。
版本 patch bump 至 **0.8.4**，typecheck + build 全绿，未提交。新 i18n：`tableEditor.delimiters/delimitersHint/delimiter_tab/semicolon/comma/space`（helpCopy/helpPaste 改文案）、`aiWorkbench.exportAsMd/exportAsDoc`（exportMessage 改为通用"导出此消息"）。

**追加（同日第十四轮，表格 Alt+方向键调序 + AI 问答转笔记 + 编辑焦点历史跳转，v0.8.3）**：
1. **表格 Alt+方向键调换顺序**：`packages/table/utils.ts` 新增 `swapRows/swapColumns`（按 id 交换在 doc 中的位置）和 `swapCells`（交换两格的内容 + 每格样式，支持跨行列、同行两格连续 patch）。`TableEditor` 新增 `handleAltArrowMove(key)`，在 `handleContainerKeyDown` 最前面拦截**纯 Alt+方向键**（无 Ctrl/Meta/Shift）：按选区形状分派——选中**整行**（单行且列跨满、列数>1）时 Alt+↑/↓ 与相邻显示行交换；选中**整列**（单列且行跨满、行数>1）时 Alt+←/→ 与相邻列交换；**单个单元格**时 Alt+四方向与相邻格交换内容和样式（交换后选区与输入焦点跟随目标格，rAF 后 `focusCellInput`）。不匹配任何形状时返回 false 不 preventDefault（保留 Alt+←/→ 在输入框内的按词跳转）。经 `emitChange` 走统一 undo 历史。行交换操作的是底层 doc 顺序，排序激活时显示顺序不变（与预期一致）。帮助弹层加 `tableEditor.helpMove` 说明。
2. **AI 问答转为笔记**：`AiWorkbench` 头部新增"📝 转为笔记"按钮（会话为空时禁用）→ 弹窗（复用 `.fn-modal`）：单选"全部问答"或"选择范围"（两个 number 输入，单位是**问答组**——一条 user 消息 + 其后所有 assistant 回复算一组，`pairStartIndices` 按 user 消息切分；range 自动钳制并容忍 from>to 反序）。确认后回调 `onConvertToNote(messages)` → `VaultApp.handleAiConvertToNote`：拼 markdown（每条消息 `## 角色 · 本地时间` 标题 + 附件 `> 📎 名字` 引用行 + 正文，消息间 `---` 分隔），`newNode('note', null, ...)` 建**根级**笔记（标题 `{会话名}（问答摘录）`，i18n `aiWorkbench.noteTitle`），`saveNoteNow` 后 `openNote(pin)` + 切到笔记视图。新样式 `.fn-ai-workbench__tonote`、`.fn-ai-tonote__range`。
3. **Ctrl+Alt+←/→ 编辑焦点历史跳转**：`VaultApp` 新增 ref 级历史（不触发渲染）——`editHistoryRef`（最多 100 条 note id）+ `editHistoryIdxRef`；`recordEditFocus(id)` 挂在 **`updateNoteById`**（所有内容/标题编辑的唯一汇合点）里：连续同 id 去重，走回历史中段后再编辑会截断前向分支（同 undo 语义）。`navigateEditFocusRef.current(dir)`（每次渲染重建闭包，全局 keydown 经 ref 调用）：向指定方向找到第一个仍存在、未删除且可编辑（`isEditableContentNode`）的条目，`openNote(id, { pin: true })`（**标签页设为活跃并固定，已关闭则重新打开**——openNoteInGroup 原生为之）+ `setAppView('notes')` + `revealNoteInTree`。全局 keydown 里在编辑器内也生效（不做 isTypingTarget 排除）；上锁时清空历史。
版本 patch bump 至 **0.8.3**（全部 17 个 package.json），`pnpm -r typecheck` + `pnpm build` 全绿，未提交。新 i18n：`tableEditor.helpMove`、`aiWorkbench.toNote/toNoteTitle/toNotePairs/toNoteAll/toNoteRange/toNoteCreate/toNoteCancel/noteTitle`（中英双语）。

用户一次性提出 7 项需求，全部完成（全仓 `pnpm -r typecheck` + `pnpm build` 通过，版本按约定 patch bump 到 **0.6.1**，未提交）：

**表格 4 项：**
1. **粘贴不再按逗号分列**：`fill.ts` 的 `parsePasteGrid` 删除逗号分支——现实数据（"1,234.56"、含逗号的句子）被逗号切碎的伤害远大于收益。现在只认 tab（Excel/Sheets）→ 连续空白 两级回退。
2. **公式支持千分位逗号数字**：`formula.ts` 新增导出 `parseNumericValue(raw)`——普通 `Number()` 失败后，用严格 3 位分组正则 `^-?\d{1,3}(,\d{3})+(\.\d+)?$` 识别 "1,000" 形式（防止 "1,2" 这类文本被误判），`resolveCellOrNull` 改用它，所以单元格引用、SUM/AVERAGE 等聚合、选区统计栏全部自动受益。注意**公式源码内**的逗号仍是函数参数分隔符，不受影响。
3. **列数字格式**：shared 新增 `TableColumnFormat { kind: 'number'|'currency'; decimals: 0-6; symbol? }`，挂在 `TableColumn.format`（可选，向后兼容）。utils 新增 `setColumnFormat`；formula 新增 `formatColumnNumber`（en-US 千分位 + 固定小数位，currency 加符号前缀，默认 `$`）。工具栏新增"数字格式"下拉（原始值/数字/货币）+ 小数位下拉 + 货币符号输入框（仅 currency 时显示），作用于**选区覆盖的列**（复用 `formatTargets` 推导 `formatColIds`）。显示层：原始值不变，仅显示时格式化——`TableCellContent` 新增 `formattedIdle` prop，非编辑态显示格式化值、聚焦编辑时切回原始值（与公式单元格同一套 editing 机制）；公式结果同样按列格式显示。
4. **一键插入本地时间**：工具栏 🕒 按钮，`formatLocalTime()` 生成 `YYYY-MM-DD HH:mm:ss`（本地时区），追加到焦点单元格现有内容后（与插入附件同套 focusCell 逻辑，无焦点时 alert 提示）。

**AI Workbench 3 项：**
5. **请求附件（图片/PDF/doc/docx/文本）**：shared 新增 `AiAttachment { kind: 'image'|'pdf'|'text', dataBase64?/text? }`，`AiMessage.attachments?`。`packages/ai` 新增 `attachments.ts`（新依赖 **fflate**，纯本地解压）：图片(png/jpeg/gif/webp)/PDF 转 base64 原样发 API 的 image/document content block；**docx** 用 fflate 解 zip 后从 `word/document.xml` 提取 `<w:t>` 文本（按 `</w:p>` 分段、处理 tab/br/实体）；**旧版 .doc** 用 UTF-16LE 可打印字符 run 扫描的启发式提取（ASCII+CJK，run≥16 才保留，尽力而为）；其余按 UTF-8 严格解码当文本。8MB 上限，`AiAttachmentError(code)` 映射为本地化报错。`AnthropicClient` 的 `AiChatMessage.content` 扩展为 `string | AiContentBlock[]`（text/image/document）。附件随消息加密持久化，重发历史时 `aiMessageToApi` 重建 content blocks（文本附件内联为 `[Attachment: name]` 前缀的 text block）。composer 加 📎 + 隐藏 file input + 待发附件 chips（可移除）；消息气泡显示附件 chips。
6. **切 session 流式不中断**：整个 in-flight 请求从 AiWorkbench **上提到 VaultApp**——`aiRun: {sessionId, text}` state + `aiAbortRef`，`runAiRequest` 在 app 层跑完整个 stream，切换会话/切回笔记视图组件卸载都不 abort；回复完成后 `appendAiMessage`（函数式 set，按 sessionId 追加到**当前**消息列表，避免覆盖流式期间的其它编辑）落到所属会话。AiWorkbench 变成纯展示组件：接收 `streamingText`（仅本会话）/`busy`（全局）/`error`（按会话过滤），同一时间只允许一个 in-flight run（其它会话 composer 禁用 + "其它会话正在生成回复"提示）。上锁时 abort + 清空。错误状态 `aiRunError` 也带 sessionId，显示在对应会话里。
7. **消息删除/导出**：每条消息 hover 显示 ⇩（导出为 md，Blob 下载，文件名 `会话名-request/response-序号-时间戳.md`，含附件清单）和 ×（confirm 后删除，`handleAiDeleteMessage` 按 index 过滤并持久化）。

**顺手修复**：`apps/desktop/tsconfig.json` 补上 `paths: { "@web/*": ["../web/src/*"] }`（对齐 vite.config 的 alias），解决 `pnpm -r typecheck` 里 desktop 唯一的 `@web/App` 报错——现在全仓 typecheck 全绿。

**追加（同日第十三轮，登录过期处理 + 设置界面选项卡化，v0.8.2）**：
1. **登录过期（401）不再伪装成"上传公钥失败"**：先前诊断确认——server 的 `/api/v1/keys` 路由自首次提交就存在，用户看到的报错实为 401（JWT 7 天过期 / 部署换 JWT_SECRET 作废全部旧 token），但 `ApiClient` 把一切非 2xx 都映射成各接口的笼统文案。改进：`packages/api` 新增 **`ApiAuthError`**（`assertAuthed(res)` 在全部带鉴权接口——uploadVaultSalt/updateKeys/lookupUser(ById)/push+pull notes/attachments/chat——先于通用错误检查把 401 转成类型化"登录已过期"错误；login/register 的 401 是密码错误语义，不受影响）。`VaultApp` 新增 `sessionExpired` state + `expireSession()`（清 localStorage session + setSession(null) + 断开 IM + 立 banner）：解锁后台 init、`handleSync`（顺带弹出登录窗）、`syncAttachmentsIfOnline` 三处 catch 里识别 `ApiAuthError` 调用。所有 `setSession(有效值)` 的位置（登录/注册/云同步/切库）都复位 `sessionExpired`；手动登出也复位（主动登出不该看到 banner）。UI：顶部居中固定 banner（`.fn-session-expired-banner`，role=alert）显示"云同步登录已过期，笔记和聊天暂停同步" + "重新登录"按钮（开 AuthModal）+ 关闭按钮。i18n：`apiClient.sessionExpired`、`vaultApp.sessionExpiredBanner/Login/Dismiss`。
2. **设置界面选项卡化**：`SettingsModal` 重构为 5 个选项卡（`settingsModal.tabs.*`）——**通用**（通知/主题/语言/编辑器公式开关）、**账户与同步**（服务器地址、账号状态、登录/登出/立即同步）、**AI 助手**、**快捷键**、**存储**（加密库名称、数据目录、实际存储路径）。弹窗加宽到 `min(760px, 94vw)`（`.fn-modal.fn-settings-modal`），flex 列布局：tab 栏（底部 accent 下划线高亮）和页脚（关闭/关于）固定，中间 `.fn-settings-body` 独立滚动——切 tab 不会挪动 tab 栏或按钮。各 tab 内容为预构建的 JSX 片段（`generalTab/accountTab/aiTab/shortcutsTab/storageTab`），保持原有交互逻辑（AI 保存钳制、快捷键录制、数据目录浏览等）不变。

**追加（同日第十二轮，表格右键选区修复 + 粘贴匹配格式，v0.8.1）**：
1. **右键不再破坏多格选区/卡住拖选**：根因是 `handleCellMouseDown` 不区分鼠标键——右键 mousedown 也会重置选区锚点（取消已选多格）并置 `isSelecting=true`，而右键菜单会吞掉配对的 mouseup（window 上的 stop 监听收不到），导致拖选状态卡死，下一次左键点击关闭菜单后鼠标划过单元格就"错误地开始选中多格"。修复：`handleCellMouseDown` 增加 `e.button !== 0` 早退（`TableCellContent.onCellMouseDown` 签名改为透传 MouseEvent），行号格的 `selectRow` 同样只响应主键（列头 `selectColumn` 走 onClick 本来就只响应主键）。副作用是正向的：右键点选区内任意格时选区保持不变，右键菜单的"复制"经 DOM copy 事件被 `handleGridCopy` 拦截，得到的正是整个选区的 TSV。
2. **右键菜单加"粘贴并匹配格式"**：`main.ts` 的 context-menu 模板在 paste 后加 `{ role: 'pasteAndMatchStyle' }`（可编辑元素时显示，macOS 标准的 ⌥⇧⌘V 行为，Electron 原生 role 自动本地化菜单文案）。

**追加（同日第十一轮，AI 消息时间戳，v0.8.0 提交）**：request/response 都显示时间——shared 的 `AiMessage` 新增可选 `startedTs`（仅 assistant：首个流式内容——text 或 thinking——到达时刻；老数据无此字段自动只显示完成时间，向后兼容）。`VaultApp.runAiRequest` 用 `markReceiveStart()` 在 onDelta/onThinking 首次触发时记录，正常完成和中止保留部分文本两条 append 路径都带上。`AiWorkbench` 消息头改为 `.fn-ai-msg__meta`（角色 + `.fn-ai-msg__time`）：用户消息显示"发送 HH:mm:ss"，AI 消息显示"开始接收 X · 接收完毕 Y"（`formatMsgTime`：当天只显示时间，跨天显示完整日期时间，tooltip 是完整 ISO）。i18n：`aiWorkbench.sentAt/recvStartAt/recvEndAt`。版本按约定 git 提交 bump minor 至 **0.8.0**。

**追加（同日第十轮，AI Workbench 3 项体验改进，v0.7.2）**：
1. **消息流滚动不再强制吸底**：`AiWorkbench` 的自动滚动改为"粘性吸底"——`messagesRef` + `onScroll` 维护 `stickToBottomRef`（距底 <48px 视为在底部），流式更新只在用户本就在底部时才 `scrollIntoView`；往上翻阅历史时不再被拽回底部，滚回底部即重新吸附；切换 session（`session.id` 变化）时重置为吸底并滚到最新消息。
2. **响应超 30s 显示耐心提示**：`aiRun` state 增加 `startedAt: number`（请求发出时刻，onDelta/onThinking 时保留），经 `streamingStartedAt` prop 传给 AiWorkbench；组件内 `patienceDue` state 由 setTimeout（按 `startedAt+30s-now` 计算剩余，中途进入 session 也能立即显示正确状态）驱动——正文迟迟不出时，"思考中…/深度思考中…" 替换为耐心文案（i18n `aiWorkbench.patience` / `patienceThinking`，后者带已思考字数），正文一旦开始输出即复位。
3. **AI 回复渲染 LaTeX 公式**：`latexDelimiters.ts` 从 `packages/editor` **移到 `packages/shared`**（editor 依赖 ui，ui 不能反向依赖 editor；editor 的 NoteEditor 改从 shared 导入，无循环）。shared 新增导出 `extractMathSegments(markdown)`：先 `normalizeLatexDelimiters`（复用 \[..\]/\(..\)/裸括号/`%` 转义全套逻辑），再把代码块外的 `$$...$$`（display）和 `$...$`（inline，需命中 `INLINE_MATH_HINT`——含 LaTeX 命令或 `_`/`^` 上下标才算数学，"$5 and $10" 不受影响）抽成纯字母数字占位符 `FNMATH{n}MARK`（block 占位符前后加空行独立成段）。`MarkdownView`（ui 包，新增 katex 依赖 + katex.min.css 导入）流程改为：抽取 → marked 解析 → DOMPurify 消毒 → 占位符替换为 `katex.renderToString`（throwOnError:false，与编辑器同配置；katex 输出自身转义安全，替换用函数形式防 `$&` 模式误解释）。新 CSS `.fn-md-view .katex-display { overflow-x: auto }` 让超宽公式在气泡内水平滚动。已用 node 冒烟测试验证抽取正确（rNPV 求和公式、行内/货币混排均正确区分）。

**追加（同日第九轮，多格复制修复 + 桌面右键菜单，v0.7.1）**：用户反馈多格复制仍只复制第一格、Mac 桌面版没有右键菜单。两个根因：
1. **多格复制失效根因**：拖选跨格时焦点仍在起点格的 input 且其文本处于选中态，`handleGridCopy` 里"单元格内有文字选区则让位原生复制"的 guard 恰好命中 → 每次都走原生复制（只复制第一格）。修复：**删掉该 guard**——点击进入某格本来就会把选区收缩为单格（`buildRangeTsv` 返回 null 自动走原生），guard 纯属多余且有害。重构为 `buildRangeTsv()`（多格才返回 TSV）+ `handleGridCopy`（copy 事件路径）。另补 **keydown 兜底** `copyRangeViaExecCommand()`：通过行号/列头选中整行整列时焦点不在任何 input，Mod+C 根本不产生 copy 事件——容器 `handleContainerKeyDown` 检测 Mod+C 且 activeElement 非 input/textarea 时，用隐藏 textarea + `execCommand('copy')`（项目约定的免权限剪贴板写入路径）复制 TSV 并恢复焦点。
2. **Mac 右键菜单**：Electron 窗口默认无右键菜单。`apps/desktop/electron/main.ts` 在 `web-contents-created` 里挂 `context-menu` 事件：可编辑元素弹 cut/copy/paste/selectAll（按 `editFlags` 置灰），非编辑区有选中文本时弹 copy。**role 型菜单项走 Electron 原生剪贴板，不经过渲染进程的 Clipboard API，因此不受"全拒权限"策略影响**；右键 copy 触发的 DOM copy 事件同样会被 `handleGridCopy` 拦截，多格选区下右键复制也得到 TSV。

**追加（同日第八轮）**：表格**多格复制**——`.fn-table-wrap` 挂 `onCopy`（`handleGridCopy`）：选区跨多格时拦截复制，按制表符分列、换行分行写入 `e.clipboardData`（copy 事件内 setData 无需任何剪贴板权限，符合 Electron 全拒权限约定）；公式格复制为计算结果；单元格内有文字选区时让位于原生复制；与 `handleGridPaste` 的 tab 优先解析闭环（表内/Excel 双向往返）。帮助弹层加 `helpCopy` 说明。随 v0.7.0 提交（amend）。

**追加（同日第七轮）**：AI `max_tokens` 设置化——shared 新增 `AI_MAX_TOKENS_MIN/LIMIT/DEFAULT`（1024 / **128000** / 16384），`AiSettings` 加可选 `maxTokens`；SettingsModal AI 区新增 number 输入（保存时钳制到范围内，非法值回落默认）；`VaultApp.runAiRequest` 把 `aiSettings.maxTokens` 传给 `streamMessage`（未设置时 ai 包内回落 `AI_MAX_TOKENS_DEFAULT`）。hint 明确说明"内部思考也计入预算"。老库已存的 AiSettings 无 maxTokens 字段，自动走默认，向后兼容。

**追加（同日第六轮，2 个小调整）**：① 笔记/表格内容区最大可调宽度 `NOTE_WIDTH_MAX` 1400 → **2400**（`packages/api`，min/default 不变，已存的超范围值由 load/save 的 clamp 自动处理）；② 表格统计栏文字垂直位置：加 `align-items: center` + `line-height: 1.4`，padding 改为上 0.25rem/下 0.5rem 让文字略偏上，不再挤在底部。

**追加（同日第五轮，AI 空回复根因确认 + 思考流支持）**：用户贴回日志：HTTP 200、1.1s 首字节、流跑 46s 正常结束但 **0 chars**——不是网络，是**推理模型的隐藏思考（thinking_delta）耗尽了 4096 的 max_tokens，正文一个字没输出（stop_reason=max_tokens），而客户端只解析 text_delta、静默结束**。复杂提示词思考长必触发，简单提示词正常，与用户现象完全吻合。修复（`packages/ai` + `VaultApp` + `AiWorkbench`）：① `DEFAULT_MAX_TOKENS` 4096 → **16384**；② 流解析新增 `thinking_delta`（`onThinking(totalChars)` 回调）和 `message_delta.stop_reason` 捕获；③ `streamMessage` 返回值从 string 改为 **`StreamMessageResult { text, stopReason, thinkingChars }`**（破坏性签名变更，唯一调用方 VaultApp 已同步）；④ UI：思考期间显示"深度思考中…（已思考 N 字）"（`aiRun.thinkingChars` → `streamingThinkingChars` prop）替代静态"思考中…"；⑤ 空正文时按 stop_reason 显示明确报错（`aiWorkbench.emptyMaxTokens/emptyReply`），正文被截断时提示可回复"继续"（`truncatedMaxTokens`）；⑥ done 日志追加 thinking 字数和 stop_reason。**内置模型列表按用户指定更新**：claude-sonnet-5（默认）/ claude-fable-5 / claude-opus-4-8 / claude-haiku-4-5-20251001。

**追加（同日第四轮，AI 请求"卡住"诊断与加固）**：用户报告用长中文提示词请求 "claude-sonnet-5" 时一直卡住，怀疑转义字符。结论：**不是转义问题**——请求体走 `JSON.stringify`，任何字符都被标准转义；SSE 解析按真实 `\n` 切分，也无问题。真因有二：① 模型 ID `claude-sonnet-5` 不存在（正确为 `claude-sonnet-4-5`），但这只会得到 404 报错不会挂起；② **fetch 无超时**——`api.anthropic.com` 从中国大陆直连不可达，TCP 挂起期间界面永远停在"思考中…"。加固：`AnthropicClient.streamMessage` 加 watchdog（自建 AbortController 与外部 signal 联动）：**连接超时 30s**（未收到响应头）+ **流空闲超时 90s**（回复中断），超时抛类型化 `AnthropicTimeoutError(phase)`，`VaultApp` 映射为本地化提示（`aiWorkbench.timeoutConnect/timeoutStream`，中文文案明确提示大陆需代理 + 检查模型 ID）；请求全生命周期打 `[FastNote] ai: ...` console 日志（start/headers/首字节/完成/超时），配合内置日志查看器可直接定位卡在哪个阶段。

**追加（同日第三轮，用户反馈 2 项）**：
1. **表格外部垂直滚动条取消 + 附件栏改弹窗**：表格分支的 `.fn-tab-group__scroll` 加修饰类 `--table`（`overflow-y: hidden` + flex 列），`.fn-note`/`.fn-table-editor` 链式 flex，`.fn-table-wrap` 改 `flex: 0 1 auto; min-height: 0; max-height: none`——小表格保持自然高度、高表格在 wrap 内部滚动（**唯一垂直滚动容器仍是 wrap**，sticky 表头/固定首列/固定水平滚动条全部不受影响且更稳）。表格下方的内联 `NoteAttachments` 面板移除，表头工具区新增"📎 附件 (n)"按钮 → `fn-modal-backdrop` 弹窗（`.fn-attach-modal`，640px）内渲染同一个 `renderAttachmentsPanel`（上传/下载/编辑/删除/插入单元格全保留）；`showTableAttachments` state，上锁时复位。
2. **表格帮助信息收进 ? 按钮**：工具栏原来平铺的公式提示 + F4 重复提示两个 span 移除，改为 `?` 按钮（复用 `fn-table-palette-wrap` 下拉容器模式）弹出 `.fn-table-help-pop`：公式（=开头）、F4 重复行列操作、填充柄、智能粘贴四条提示；新 i18n `tableEditor.help/helpPaste`，`fillHandleTooltip` 文案顺带改得更自明。

**追加（同日第二轮，用户反馈 2 项）**：
1. **表格统计栏固定显示**：统计栏（计数/求和/平均值）此前按需渲染，出现/消失会把 `.fn-table-wrap` 上下顶动，导致本应固定位置的水平滚动条跳动。改为**始终渲染**（无选区时显示灰色 placeholder 提示 `tableEditor.stats.placeholder`），CSS 改 `flex-wrap: nowrap + white-space: nowrap + overflow: hidden` 保证恒定单行高度——布局从此不随选区变化。
2. **`dist:mac` 打包失败修复**：electron-builder 25 在打包前默认跑 `@electron/rebuild`，它会遍历 pnpm 的 hoisted 目录 `node_modules/.pnpm/node_modules/`，那里残留着约 20 个**悬空 symlink**（`@types/better-sqlite3`、`better-sqlite3`、`electron-rebuild`、`prebuild-install` 等——某次依赖变更后 pnpm 留下的陈旧链接，指向已不存在的 `.pnpm/xxx@ver` 目录），`stat` 悬空链接直接 ENOENT 中断打包。修复：`apps/desktop` 的 build 配置加 **`"npmRebuild": false`**——桌面端 production 依赖零原生模块（React + workspace 包全是纯 JS），rebuild 步骤本来就是空转，关掉后既绕开悬空链接又加快打包。已实际跑通 `pack` 和 `dist:mac`（产出 `FastNote-0.6.1-arm64.dmg`）。彻底清理悬空链接可另行 `rm -rf node_modules && pnpm install`，但非必需。

新 i18n key：`tableEditor.insertNow/numberFormat*/decimals*/currencySymbol`、`aiWorkbench.attach*/removeAttachment/attachmentsHeading/busyElsewhere/exportMessage/deleteMessage/confirmDeleteMessage`（中英双语）。新样式：`.fn-table-fmt__numfmt/decimals/symbol`、`.fn-ai-msg__actions/attachments`、`.fn-ai-attachment-chip`、`.fn-ai-composer__attachments/buttons`、`.fn-ai-workbench__busy-hint`。

## 上一轮工作焦点（2026-07-10：AI Workbench + 跨库传输 + 查找替换 + prompt 修复）

按用户确认的实施计划一次性完成四大功能（全部通过全仓 `pnpm build`；顺手修掉了 `packages/ui` 长期存在的 Tiptap `ChainedCommands` typecheck 失败——`EditorToolbar.tsx` 加三行 `import type {} from '@tiptap/starter-kit'/'@tiptap/extension-link'/'@tiptap/extension-mathematics'`（并加为 ui 的 devDependencies），把各扩展包里 `declare module '@tiptap/core'` 的命令类型增强拉进编译单元；注意必须写在源文件里而不是独立 .d.ts，因为 `packages/table` typecheck 会跨包编译 ui 源码、不读 ui 的 tsconfig include。`pnpm -r typecheck` 现在仅剩 `apps/desktop` 的 `@web/App` 别名既有问题）：

1. **修复渲染工具栏链接/公式按钮**（根因：Electron 渲染进程 `window.prompt()` 返回 null，静默失效——**项目约定：禁止使用 window.prompt**，confirm/alert 可用）：
   - 新增通用 `packages/ui/src/InlineInputBar.tsx`（label + input + 确认/取消，Enter/Esc），`EditorToolbar` 的 Link/∑/∑∑ 三个按钮改为切换内联输入行；Link 预填当前链接 href。
   - `NoteEditor` 的 Mathematics `onClick`（inline/block 两处）不再用 prompt，改为新 prop `onEditFormula(latex, apply)` 把请求抛给宿主；`VaultApp` 用 `formulaEdit` state 在分组头部渲染同一个 `InlineInputBar`。
2. **AI Workbench（Claude）**：
   - 新包 `packages/ai`：`AnthropicClient.streamMessage()` 直连 `https://api.anthropic.com/v1/messages`（headers 含 `anthropic-dangerous-direct-browser-access: true`），手写 SSE 解析（`content_block_delta`/`text_delta`）逐字回调；`CLAUDE_MODELS` 内置 Sonnet 4.5 / Opus 4.1 / Haiku 4.5 + 设置里可填自定义模型 ID；`AnthropicApiError` 带 HTTP 状态。
   - **CSP 三处**（csp.ts + 两个 index.html 引导脚本）`connect-src` 放行 `https://api.anthropic.com`——唯一的第三方例外，仅在用户主动配置 API key 后才会有流量。
   - **存储**：`META_KEYS.aiSettings`，`{apiKey, model}` JSON 用 **masterKey** `encryptString` 加密存 `vault_meta`，解锁后后台解密载入，锁定即从内存清除。`packages/storage` **DB v6** 新增 `ai_sessions_local` store（`titleEnc/payloadEnc` 均 **notesKey** 加密，payload = `AiMessage[]`）；`StorageAdapter` 新增 `listAiSessions`/`saveAiSession`/`deleteAiSession`。shared 新增 `AiSettings`/`AiMessage`/`AiSessionNode` 类型。
   - **UI**：`SettingsModal` 新增 AI fieldset（password 型 key 输入 + 模型下拉含"自定义"）；侧栏 NoteTree 下方新增可折叠"AI 助手"分区（`loadAiPanelOpen`/`saveAiPanelOpen` 持久化），`AiSessionTree`（文件夹嵌套、新建会话/文件夹、内联重命名、confirm 删除（文件夹级联）、HTML5 拖拽移动、防止文件夹拖进自身后代）；`AiWorkbench` 主界面（选中会话时替换 main 插槽；打开笔记/标签页自动切回）：消息流（用户纯文本气泡 / 助手 `MarkdownView` 渲染）、流式上屏、中止按钮（中止保留已流出的部分文本）、Enter 发送 Shift+Enter 换行、会话自动保存（每次消息变更全量加密重写）。
   - `MarkdownView` = `marked`（gfm+breaks, 同步 parse）+ `dompurify` 消毒后 `dangerouslySetInnerHTML`，两个都是纯本地库（ui 新增直接依赖）。
3. **跨库传输/移动**：NoteTree 每行新增 ⇄ 按钮（`onTransfer`，若该行在多选集合中则整组传输）→ `VaultTransferModal`（目标库下拉 = `vaultRegistry` 排除当前、目标库密码、复制/移动单选、进度/错误显示）→ `VaultApp.handleTransferToVault`：`createStorage({namespace})` 开第二适配器 → 读目标 salt/verifier 验密（`deriveKeysFromPassword`）→ 选中子树去重（选中项若已在另一选中项子树内则跳过）→ 全部生成新 UUID、重映射 parentId（子树外的 parent 置 null 落到目标库根）→ 附件解密后用目标 notesKey `saveAttachment`，正文里 `fnattach:` 引用按 old-id→new-id 字符串替换 → `saveNote`（version 1 / syncStatus pending）→ 移动模式最后走现有 `handleDeleteMany`。完成后 `alert` 汇总。
4. **查找替换（Ctrl+F，双模式）**：
   - shared 新增 `FindReplaceController`/`FindReplaceStatus` 接口 + `ShortcutAction` 新增 `findInNote`（默认 Ctrl+F，设置里可改；`loadShortcuts` 与默认值合并所以老用户自动获得）。
   - `packages/ui/src/FindReplaceBar.tsx`：查找/替换双行、匹配计数 `current/total`、Enter=下一个 Shift+Enter=上一个、替换/全部替换、Esc 关闭。**prop 是 `getController` getter**（模式切换后 controller 会换，不能捕获实例）。
   - 源码模式：editor 包新增直接依赖 `@codemirror/search`，CM 扩展加 `cmSearch()` + `Prec.high` 吞掉 `Mod-f`（阻止 CM 自带面板，让全局快捷键接管）；controller 用 `setSearchQuery`/`findNext`/`findPrevious`/`replaceNext`/`replaceAll` 程序化驱动，计数用 `SearchQuery.getCursor` 遍历（current = from < sel.to 的匹配数）；选中即当前匹配，basicSetup 的 `highlightSelectionMatches` 顺带高亮其余匹配。
   - 渲染模式：`packages/editor/src/FindReplaceExtension.ts` ProseMirror 插件（`findReplacePluginKey` meta 驱动；大小写不敏感、**匹配不跨文本节点**为首版限制；Decoration.inline 高亮 `fn-find-match`(--active)；docChanged 自动重算）；controller 在 NoteEditor 的 effect 里注册：replace 用 `tr.insertText`（doc 变更后插件保持 activeIndex 自然落到下一个），replaceAll 倒序单事务。
   - `VaultApp`：全局 keydown 处理 `findInNote`（仅 notes 视图，preventDefault 压掉浏览器原生查找；**编辑器内也生效**——window 冒泡监听不受输入焦点 guard 限制），`findBarGroupId` state 控制条渲染在活动分组头部（仅笔记分支），`findReplaceByGroupRef` 存各分组 controller；上锁清空。
- i18n 新增：`settingsModal.ai.*`、`aiPanel.*`、`aiWorkbench.*`、`vaultTransfer.*`、`findReplace.*`、`noteTree.transfer`、`settingsModal.shortcuts.findInNote`（中英全量）。styles.css 新增 `.fn-inline-input*`、`.fn-findbar*`、`.fn-find-match*`、`.fn-ai-panel*`、`.fn-ai-tree*`、`.fn-ai-workbench*`、`.fn-ai-msg*`、`.fn-md-view*`。

**追加（同日第二轮，用户反馈 6 项）**：
1. **渲染模式查找失效的根因修复**：NoteEditor 的 wysiwyg 查找注册 effect 把宿主传的内联箭头函数 `onRegisterFindReplace` 放进了依赖数组——VaultApp 任意重渲染（例如 `scrollToActive` 设置选区 → `onSelectionChars` → setState）都会让 effect 重跑，cleanup 里的 `dispatchFind('', 0)` 把查询和高亮瞬间清空。改为 `onRegisterFindReplaceRef`（与 `onSelectionCharsRef` 同模式），deps 收窄为 `[editor, mode, noteId]`；源码模式注册同步改用 ref。**教训：编辑器里所有宿主回调 prop 一律先包 ref 再进 effect。**
2. **AI 面板置顶且固定**：侧栏 notes 视图改为 `.fn-notes-sidebar` flex 列布局——AI 面板（`flex: 0 0 auto`，max-height 45%，展开时 `.fn-ai-tree` 内部滚动）固定在顶部，`.fn-notes-sidebar__tree`（flex:1 + overflow-y:auto）单独滚动文件树；`.fn-sidebar__content` 加 `height: 100%` 提供确定高度。NoteTree 拖拽自动滚动的 `closest('.fn-sidebar')` 改为 `closest('.fn-notes-sidebar__tree, .fn-sidebar')`。TreeToolbar 的 sticky 在新滚动容器下继续生效。
3. **AI 会话渲染/源码切换**：AiWorkbench header 加"渲染/源码"toggle（`showSource` state），源码视图用等宽 `<pre>`（`.fn-ai-msg__body--source`），流式渲染同样遵循。
4. **AI/笔记快速切换按钮**：顶部工具栏（notes 视图）新增 🤖/📝 按钮，`handleAiQuickSwitch`：在 AI 视图 → 回笔记；在笔记视图 → 回上次会话（`lastAiSessionIdRef`）或第一个会话，无会话则新建。
5. **Ctrl/Cmd+点击链接**：NoteEditor `editorProps.handleClick` 检测 ctrl/meta + `a[href]`（仅 http/https）→ `window.open(_blank, noopener)`；Electron 主进程既有的 `setWindowOpenHandler` 会 deny + `shell.openExternal` 转交系统默认浏览器，Web 版开新标签页。
6. **侧栏绿点**：是 `syncStatus === 'pending'` 的"待同步"标记，本地库永远 pending 纯属噪音。NoteTree 新增 `showSyncStatus` prop（VaultApp 传 `!!session`），绿点只在云账号登录时显示；冲突 ⚠ 始终显示。

## 上一轮工作焦点（2026-07-09：解锁/上锁性能优化 + typecheck 修复）

用户报告 1000+ 篇笔记的密码库解锁、上锁明显卡顿。诊断出四个瓶颈并按用户选定的"1–4 + 6 方案"全部实施：

1. **WebCrypto 原生 AES-GCM**（`packages/crypto`）：新增 `encryptNative`/`decryptNative`/`encryptStringNative`/`decryptStringNative`，与原 `@noble/ciphers` 纯 JS 实现**线格式完全一致**（12 字节 nonce + 密文尾部 16 字节 tag），已用独立脚本验证双向互解，现有库无需迁移。`CryptoKey` 用 `WeakMap` 按原始密钥对象缓存，批量解密只 `importKey` 一次。笔记读写（`loadNoteDecrypted`/`saveNote`/`toStoredRow`）和搜索快照加解密已切换；**同步链路（`encryptNoteForSync` 等）仍用 noble 实现**——不在热路径上且格式兼容，未来可再切。
2. **IndexedDB 批量读取**（`packages/storage`）：新增 `StorageAdapter.loadAllNotesDecrypted(notesKey, onProgress?)`，一次 `getAll('notes_local')` 代替逐条 `get()`，内部过滤墓碑行、按每批 24 篇 `Promise.all` 并行解密。
3. **时间片 yield**：批量解密循环按 `performance.now()` 计算的 ~16ms 预算 yield（`setTimeout(0)`）并回调进度，替代原来"每 6 篇必 yield"的固定节奏；进度回调驱动解锁页进度条。
4. **搜索快照新鲜度指纹**（跳过全量重建）：`META_KEYS` 新增 `searchIndexFingerprint`；保存快照时同时存一份指纹 = `hashContent(所有非删除笔记的 "id:version" 排序后 join('|'))`（SHA-256）。解锁时用刚解密的笔记算同样指纹比对，一致 → 直接 `NoteSearchIndex.fromSerialized` 恢复、跳过 MiniSearch 全量 rebuild；不一致（如异常退出未走上锁流程）→ 回退全量重建。**安全性**：指纹只是 note id（`crypto.randomUUID()` 随机生成）+ version 的哈希，两者本来就以明文存在 IndexedDB 行里，不泄露任何标题/正文信息；快照本体依旧是 `indexKey` AES-GCM 加密后才落盘（`vault_meta`），本次只是把加密实现换成原生。
6. **索引 dirty 标记**：`VaultApp` 新增 `searchDirtyRef`，索引的所有变更点（`upsertSearch`、删除时的 `remove`、`rebuildSearchIndex`）置 true；`saveSearchSnapshot(indexKey, items)`（签名改了，多了 items 用于算指纹）在 dirty 为 false 时直接跳过序列化+加密+写入——这是"没改任何东西上锁也卡一下"的根源。快照加载成功或保存完成后复位 false。另外同步后只在 `pulled > 0 || conflicts > 0` 时才 rebuild 索引（push 不改本地内容）。

**追加优化（同日）**：用户反馈进度条虽然很快走完，但解锁按钮仍长时间停在"处理中…"。原因是进度条只覆盖笔记解密，`loadNotes` 返回前还串行 `await` 了三类慢操作：① 云账号下的 `uploadVaultSalt` + `initIM` 的 `updateKeys` 两次网络往返（`fetch` 无超时，服务器不可达时挂到 TCP 超时可达几十秒）；② `listChatMessagesDecrypted` 仍在用 noble 纯 JS 逐条解密聊天记录；③ 升级后首次解锁必然指纹未命中、走一次全量索引重建（一次性，正常上锁存下指纹后消失）。修复：把盐值回填、聊天历史解密、IM 握手全部移出解锁关键路径——笔记+搜索+标签页就绪后 `loadNotes` 立即返回、界面直接打开，这三步在后台按原顺序执行（async IIFE，`keysRef.current !== derived` 时中止，防止后台任务在上锁后污染状态）；聊天消息及附件元数据解密切换到 `decryptStringNative`。顺带删除了 `loadNotes` 里无用的 `loadExchangePrivate` 死代码。

**追加优化（第二轮，同日）**：网络后台化之后用户反馈每次解锁进度条走完后仍卡"处理中…"一段时间。真凶是**搜索快照的反序列化本身**：MiniSearch 配置了 `storeFields: ['title','content']`（快照里存全部笔记正文），1000+ 篇笔记的快照是几十 MB JSON，`MiniSearch.loadJSON()` 同步 parse + 重建索引要数秒——指纹命中只是把"重建"换成了同样昂贵的"反序列化"，且每次解锁都在关键路径上被 `await`。修复：
- `packages/search` 新增 `fromSerializedAsync`（`MiniSearch.loadJSONAsync`）和 `buildAsync`（`addAllAsync`），分块处理不阻塞主线程。
- `VaultApp` 新增 `prepareSearchIndexInBackground`：索引准备完全移出解锁关键路径，界面立即打开；加载期间搜索看到空索引，编辑操作进 `pendingSearchOpsRef` 队列、完成后重放；`searchGenRef` 代际计数防止 re-unlock/同步 rebuild/上锁与后台构建交错（`rebuildSearchIndex` 会 bump gen 抢占）；`saveSearchSnapshot` 在 `!searchReadyRef` 时拒绝保存（防止把空/半成品索引连同新指纹写盘毒化下次解锁——旧快照留着，指纹不匹配自然走全量重建兜底）。
- **DB v5**：`notes_local`/`attachments_local` 新增 `by_deleted` 索引；`purgeDeleted()` 改为 `getAllKeysFromIndex` 只取键——原来 `getAll('attachments_local')` 会把全部加密附件二进制读进内存只为检查删除标记，附件多时每次解锁/删除都卡主线程。`listDeletedNoteStubs` 同样走索引。
- **耗时日志**：解锁各阶段输出 `[FastNote] unlock: ...` console.info（笔记解密耗时、首帧渲染耗时、后台索引就绪耗时），以后用户再报卡顿可直接看控制台定位。

**追加（同日，第三轮）**：性能问题确认解决（用户反馈"能秒进了"）。但 mac 桌面打包版没有 DevTools，看不到 `[FastNote] unlock: ...` 等控制台输出，新增**内置日志查看器**：
- `packages/shared/src/logBuffer.ts`：`installConsoleCapture()` 包装 console.log/info/warn/error（保留原行为）+ 捕获 `error`/`unhandledrejection` 事件，写入内存环形缓冲（上限 2000 条，带 ISO 时间戳和级别）；`getCapturedLogs`/`clearCapturedLogs`/`formatCapturedLogs`。**严格本地**：只存内存，除非用户主动复制/导出，不写盘。
- `packages/ui/src/LogsModal.tsx`：日志弹窗（等宽字体滚动列表、warn/error 着色），支持复制全部、导出 `.txt`（Blob 下载，Web/Electron 通用）、清空。
- `VaultApp`：模块顶层调用 `installConsoleCapture()`（尽早捕获）；右上角设置按钮旁新增 📋 按钮打开弹窗。i18n 新增 `logsModal.*`（中英）；样式 `.fn-logs*`。
- README（英文 + 中文）功能一览同步刷新：补上标签页系统、KaTeX、快捷键自定义、大库快速解锁、日志查看器等 0.3.0/0.4.0 功能点。

**追加（同日，第四轮）**：用户从日志查看器贴回真实数据——解锁本体已达标（1237 篇解密 428ms、首帧 51ms、后台索引 6.5s 不阻塞使用），但暴露一个 bug：桌面版"复制日志"报 `NotAllowedError`。根因是 Electron 硬化（`setPermissionRequestHandler` 拒绝一切权限）连 `clipboard-sanitized-write` 也拒了。最初的修复曾给主进程加剪贴板写入白名单，但**用户明确要求不放行任何剪贴板权限**，最终方案：主进程保持全拒（deny-all 不动），`LogsModal.handleCopy` 直接用无需权限的 `document.execCommand('copy')`（隐藏 textarea + select）作为唯一复制路径，不再调用 `navigator.clipboard`；只在复制成功时显示"已复制"。

**顺手修复**：`packages/sync`、`packages/im` 一直缺 `tsconfig.json`（`tsc --noEmit` 无配置直接打印帮助并失败），已按标准模板（extends `../../tsconfig.base.json`）补上，两包 typecheck 通过；`packages/table` 此前已被补过。全仓 `pnpm -r typecheck` 现在只剩 `apps/desktop` 的 `@web/App` 别名问题（既有已知问题）。全仓 `pnpm build` 通过。

## 同一长会话中更早的几轮（2026-07-06 ~ 07-09，版本 0.2.0 → 0.4.0）

这轮超长会话前面还完成了大量功能（详见 `progress.md` 的 0.3.0/0.4.0 清单），要点：

- **标签页系统**：固定两个分组的分栏视图，标签可拖拽排序、关闭、预览/固定（单击斜体预览、双击固定），按 vault 持久化到 `localStorage`，分组间分隔条可拖拽调宽，锁定/解锁后固定标签保留（`tabStateReadyRef` 防止中间渲染写坏持久化状态）。
- **侧边栏**：全部展开/折叠、排序（破坏性重写 sortOrder）、宽度拖拽（实时）、定位文件（搜索/选标签页时自动展开祖先+滚动+高亮）、Ctrl/Shift 多选 + Del 删除、拖拽自动滚动、新建/导入按焦点层级、工具栏 sticky、图标对齐（CSS specificity 坑）。
- **编辑器**：KaTeX 数学公式（默认关闭，设置里开启；`latexDelimiters.ts` 处理裸括号/`\[...\]`/`%` 转义）、行号、Ctrl+D 删行、Alt+Up/Down 换行（CodeMirror keymap + 自定义 Tiptap `LineEditing` 扩展）、JSON 格式化按钮、选中字符计数、空行保留（`blankLines.ts` NBSP 段落 + 序列化 `\u0000` 哨兵）、单条笔记导出明文 markdown。
- **表格**：Excel 式下拉填充（`fill.ts`，数列/公式相对引用/尾数字递增）、智能粘贴（tab/逗号/空白分隔）、撤销/恢复（可自定义快捷键）、行高列宽拖拽、固定表头/首列、单元格加粗/字号/颜色/填充色（`TableCellStyle`）、行删除按钮移到左侧+确认对话框（F4 重复跳过确认）、第一行提升为表头、非空计数。
- **硬删除架构**：本地库直接硬删；云同步库先写轻量墓碑（清空明文），推送 `deleted: true` 到服务端后本地 purge（`listDeletedNoteStubs`/`purgeDeleted`）；解锁时跳过墓碑行解密。
- **快捷键系统**：`ShortcutBindings`（F2 重命名、Ctrl+L 上锁、F4 表格重复、表格撤销/恢复、Del 删除选中），设置里可自定义。

## 更早会话焦点（2026-07-05 第三轮：版本 bump + Vercel 部署方案）

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

## 桌面端打包发布 CI 失败（同日修复）

`release-desktop.yml` 三个平台的 `electron-builder` 步骤全部在 `afterPack` 阶段报错退出：`Cannot detect repository by .git/config. Please specify "repository" in the package.json`。根因：workflow 给 `electron-builder` 传了 `GH_TOKEN` 环境变量，这会让它自动进入"CI 检测到，尝试解析发布配置"分支（日志里的 `artifacts will be published if draft release exists reason=CI detected`），即使我们从不打算让 electron-builder 自己发布——实际发布是由同一 workflow 后面的 `release` job 用 `softprops/action-gh-release` 单独完成的。`actions/checkout@v4` 产生的 `.git` 目录在这些 runner 上无法被 electron-builder 正确解析出 owner/repo，且 `apps/desktop/package.json` 也没有 `repository` 字段兜底，于是直接抛错。

修复：`apps/desktop/package.json` 的 `build` 字段加了 `"publish": null`（官方文档确认的正确关闭方式，注意不是字符串 `"never"`，那是 CLI 参数专用值，写进配置文件里反而会报另一个错），彻底跳过发布配置解析这条代码路径；顺带补上了之前一直提示缺失的 `description`/`author`/`repository` 字段。本地用 `CSC_IDENTITY_AUTO_DISCOVERY=false GH_TOKEN=dummy npx electron-builder --mac --dir` 复现并验证修复（该命令会走到与 CI 完全相同的 `afterPack` 发布配置解析逻辑）。

**追加修复（同日，Linux deb 打包仍失败）**：上面的 `publish: null` 解决了三端都会遇到的"检测仓库"报错后，Linux 的 `deb` 目标又暴露出新问题：`fpm ⨯ Parent directory does not exist: .../release/@fastnote - cannot write to .../release/@fastnote/desktop_0.1.0_amd64.deb`。

根因：`apps/desktop/package.json` 的顶层 `name` 是 scoped npm 包名 `@fastnote/desktop`（monorepo workspace 约定所需，不能随便改）。electron-builder 的默认 `artifactName` 模板是 `${name}-${version}.${ext}`，这里的 `${name}` 取的是 **package.json 的 `name` 字段（原始 npm 包名）**，而不是 `productName`。由于 `@fastnote/desktop` 里含有 `/`，被当成了路径分隔符，导致 electron-builder 试图先创建/写入一个字面上叫 `@fastnote` 的目录，而这个目录在 `release/` 下并不存在（且不会被自动创建），于是 fpm 报错退出。日志里那条 `oldname=>FastNote, fixedname=>fastnote` 的 warn 只是 fpm 自己对**包内部标识符**（`--name` 参数、Debian control 文件里的 `Package:` 字段）做的大小写规范化，和这里报错的**文件路径**问题是两回事——这也是为什么这个 bug 在解决了 repository 检测报错之后才第一次在 Linux 目标上暴露出来（mac/win 默认的 artifactName 模板本来就用 `productName` 而不是 `name`，只有 Linux 的 deb 目标走了这条使用原始 `name` 的代码路径）。

修复：在 `build` 字段顶层显式加了 `"artifactName": "${productName}-${version}-${arch}.${ext}"`（对 mac/win/linux 所有目标统一生效，用 `productName`("FastNote") 代替默认的 `name`，从根上避免任何 scoped 包名泄漏进输出路径），并在 `linux` 字段下加了 `"executableName": "fastnote"`（规范化 Linux 下实际安装的可执行文件名，避免依赖 productName 里的大写字母）。参考了 electron-builder 官方 issue #2963/#5918 中对同类问题的确认与修复方式。本地因为 fpm 是预编译的 Linux ELF 二进制、无法在 macOS 上跨平台验证完整 deb 构建，已通过 `builder-effective-config.yaml` 校验配置能正确解析，实际打包效果需等 CI 跑一次确认。

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

## 本次会话的实质性变更（表头重构 + 回收站，2026-07-04）

- **表头两行结构**（`packages/table/src/TableEditor.tsx`）：
  - 第一行为控制行：列号按钮（加宽，`flex: 1`）、新的排序按钮（↕/↑/↓，替代原"点击列名排序"）、删除列按钮；✎ 编辑按钮已移除。筛选输入和列宽拖拽手柄保留在第一行（名称行也有一份手柄）。
  - 第二行为列名行（`fn-table__name-row`/`fn-table__name-cell`）：像单元格一样单击选中（新状态 `selHeaderCol`）、Ctrl+C 复制列名、Del 清空列名（`commitRename` 现在允许空名）、双击或回车进入编辑（`renamingCol` 增加 `selectAll` 标志，编辑框全选）、直接输入字符即开始改名（type-to-edit）、左右方向键在表头间移动、下方向键落入第一行数据格、Esc 取消选中。
  - 两行表头都是 sticky：第一行高度用 ResizeObserver 测量写入 `--fn-head1-h`（挂在 `.fn-table-wrap` 上），第二行 `top: var(--fn-head1-h)`。**注意不要给第二行 th 写 `position: relative`，会覆盖 sticky。**
  - 表头选中与网格选区互斥：`handleCellMouseDown`/`selectColumn`/`selectRow` 都会清 `selHeaderCol`。
  - **横向填充 + 操作焦点跟随选区（2026-07-31）**：填充柄支持四向拖动——`fillTarget` 从行号改为 `CellPos`，`fillPlanFor` 按溢出量大的轴决定方向（行轴走原 `applyVerticalFill`，列轴走新 `applyHorizontalFill`）；`fill.ts` 新增 `shiftFormulaCols`（横向填充平移公式列引用：`CELL_REF` 两段替换 + 新 `COL_ONLY_REF` 正则处理整列引用 `C:C`/`C1:C` 的冒号邻接字母，小写引用保持小写，A 列以下钳制不变，函数名不含冒号邻接/数字结尾所以不会误匹配），`fillValueAt` 增加 `axis: 'row'|'col'` 参数；`formula.ts` 的 `letterToColumnIndex` 改为导出（0-based，输入需大写）。**操作焦点跟随选区**：新 useEffect 把 `focusCell` 同步到 `selFocus` 指向的单元格（带 prev 比较防多余渲染），使插入时间/附件插入/格式回退目标、附件下拉可用状态都作用于*选中*的格而不是上一个编辑过的格；附件 chip 单元格的 mousedown 分支补了 blur 残留 textarea + `containerRef.focus()`，粘贴事件从容器冒泡、落在选区。tsx 冒烟 16 断言全过。
  - **整列/整行对齐 + 表头↔首行互转（2026-07-29 第二批）**：`TableColumn.cellStyle?: TableCellStyle`（列级默认样式）与 `TableRow.style?: TableCellStyle`（行级默认样式）加入 shared；渲染优先级 **单元格 > 行 > 列**（TableEditor 单元格渲染处合并出有效样式，`anchorStyle` 也改为有效样式合并）。工具栏对齐下拉在**整列选中**（selectionRange 覆盖全部 displayRows）时走 `applyColumnCellStyle`（写列默认 + 清该列所有单元格级同名 key，未来新行自动继承），**整行选中**走 `applyRowCellStyle`，全选时先列后清行级 key 防遮蔽；其他选区仍走单元格级 `applyStyle`。`clearFormatting` 在整列/整行选区时同时清对应级别默认。注意：bold/fontSize 等仍只有单元格级，`autoFitColumn` 测量不用改。新增 `demoteHeaderToFirstRow`（表头作首行：列名下放为新首行、列名清空、headerStyle → 该行单元格样式、`rewriteDocFormulasForInsert('row', 0)`）；`promoteFirstRowToHeader` 补了 `rewriteDocFormulasForDelete('row', 0)` 和首行 align/valign 吸收进 headerStyle。**语义备忘**：重写后引用统一大写；范围引用在顶部插入按吸收语义扩展（`B1:B3`→`B1:B4`，与"第 1 行上方插行"一致，SUM 忽略文本行，promote/demote 往返可逆）；单引用正常平移（`B1`→`B2`）。i18n 新键 `tableEditor.headerToFirstRow(Hint)`。tsx 冒烟 21 断言全过（跑法：`cd packages/table && ../../apps/web/node_modules/.bin/tsx <test>.mjs`，根 node_modules 没有 tsx、apps/web 里有）。
  - **表头多选/对齐/右键（2026-07-29 追加）**：`selHeaderCol` 已重构为范围 `selHeader: { anchor, focus }`（派生 `headerRange` memo，`selHeaderRef` 供事件回调读取）。支持拖动（`isHeaderSelecting` + onMouseEnter）与 Shift+点击/Shift+左右键扩展多选。`TableColumn` 新增 `headerStyle?: TableCellStyle`（`packages/shared`），utils 新增 `setHeaderStyle(doc, colIds, patch)`（合并语义同 `applyCellStyle`，空对象整体丢弃）；工具栏两个对齐下拉在表头有选中时改写 `headerStyle`（`applyAlignStyle`/`alignStyleSource`），否则照旧作用于单元格。渲染：th 上内联 `verticalAlign`，`.fn-table__name-text` 上内联 `textAlign`。右键菜单复用 `ctxMenu`，状态加了 `kind: 'cell' | 'header'`（`handleHeaderContextMenu`：点在已有多选内保留选区，否则单选该列）；表头菜单项 = 复制（多列名按当前复制分隔符 join，走 `copyHeaderNames`，同时写 `internalClipboardRef`）/ 粘贴（`pasteIntoHeader` → `applyHeaderPasteText`，`parsePasteGrid` 取第一行按列铺开，**不受排序/筛选限制**，Ctrl+V 走 `handleGridPaste` 的表头分支）/ 删除（`clearHeaderNames` 清空范围内所有列名）。Del/Ctrl+C 键盘路径同样支持范围。列名编辑中 Ctrl+A 只全选编辑框内容：`handleContainerKeyDown` 的 Mod+A 分支对 `.fn-table__rename-input` 提前 return。
- **下拉填充支持小写引用**（`packages/table/src/fill.ts`）：`CELL_REF` 改为 `/([A-Za-z]+)(\d+)/g`，`=sum(b1:b6)` 下拉时行号也会平移，大小写原样保留；整列引用（`c:c`）无行号不受影响。
- **表格 Del 不再误删 sidebar 文件**（`packages/app/src/VaultApp.tsx` 全局 keydown）：`deleteSelected` 快捷键新增两个 guard——`!e.defaultPrevented`（表格已处理过的 Del 不再触发）和 `!target.closest('.fn-table-editor')`（焦点在表格内时一律不删侧栏文件）。
- **回收站（笔记 + AI 两个 sidebar）**：
  - 数据模型：`NoteNode.trashed?: boolean` / `AiSessionNode.trashed?: boolean`（`packages/shared`）。与 `deleted`（清空明文的同步墓碑）不同，`trashed` 保留全部内容、按普通编辑同步（`SyncNotePayload.trashed` / `AiSessionSyncPayload.trashed`，旧客户端 blob 解码为 undefined → 未回收）。存储行：`StoredNote.trashed?: number`、`StoredAiSession.trashed?: boolean`，IndexedDB 无需迁移。
  - 笔记侧（`VaultApp.tsx`）：sidebar 删除按钮与 Del 快捷键现在调用 `handleTrashMany`（整棵子树标记 trashed；应用户要求**保留确认弹窗**，文案改为"将移入回收站，可随时还原"）；`handleRestoreFromTrash`（还原子树，原父节点丢失/仍在回收站时挂回根）；`handleEmptyTrash`/单项永久删除走原 `handleDeleteMany`（墓碑/硬删）。跨库转移的 move 仍直接用 `handleDeleteMany`（真删除）。
  - 搜索/标签页对 trashed 隐身：`upsertSearch` 遇 trashed 改为 remove（覆盖回收、还原、远端 pull 全部路径）；`rebuildSearchIndex`/`prepareSearchIndexInBackground` 构建时过滤 trashed（fingerprint 仍按全量 id:version 计算，保存/加载两侧一致）；`searchResults`、`restoreTabState`、`pruneStaleTabs`、焦点历史导航都排除 trashed。
  - AI 侧：`handleAiDelete` 改为标记 trashed（+ 清 activeAiSessionId），`handleAiRestore`/`handleAiDeleteForever`/`handleAiEmptyTrash` 同笔记语义；`MobileApp.tsx` 有同一套镜像实现。
  - UI：新组件 `packages/ui/src/TrashSection.tsx`（两个树共用；折叠标题 + 数量 + 清空按钮，条目行 ↩ 还原 / × 永久删除；删除、清空、永久删除都有确认，还原没有）。`NoteTree`/`AiSessionTree` 内部过滤 trashed 构树，回收站只列 trashed 子树的根（父节点不是 trashed 的），还原/清空随根带走整棵子树。新 i18n 组 `trash.*`，新 CSS 组 `.fn-trash*`。

## 本次会话的实质性变更（聊天多端 + Win 解锁焦点 + 表格粘贴锚点，2026-08-03）

- **表格粘贴锚点以选区为准**（`packages/table/src/TableEditor.tsx`）：`handleGridPaste` 的 dataset 分支（粘贴事件落在某个 textarea 上）改为优先用 `selectionRangeRef.current` 的左上角作为多格粘贴起点——结构性操作（如插入行）后可能有残留焦点的旧 textarea，其 `data-row-idx` 指向错误行；正常编辑时选区恒等于编辑格，行为不变。另外 `handleAddColumn`/`handleAddRow` 结束时 `containerRef.focus()`，插入后键盘/粘贴立即作用于网格而不是停留在工具栏按钮上。
- **聊天实时上传**：`SyncClient` 拆出 `pushChatMessages(storage)`（push-only，`syncChatMessages` 复用它）；`VaultApp`/`MobileApp` 新增 `scheduleChatPush`（3s 防抖，挂在 `persistChatMessage` 末尾），发送/接收后几秒内密文 blob 即上传账户，未登录时静默跳过、由下次同步兜底。
- **聊天手动同步历史按钮**：`ChatPanel` 新增可选 prop `onSyncHistory`，头部"⟳ 同步历史"按钮（syncing 态 + 错误显示）；`VaultApp.handleChatHistorySync` / `MobileApp.handleChatHistorySync` 执行完整 `syncChatMessages`（push+pull），`pulled > 0` 时刷新线程。i18n 新键 `chatPanel.syncHistory/syncingHistory/syncHistoryHint/syncHistoryFailed/syncNeedsLogin`；CSS `.fn-chat__header` 改 flex，新 `.fn-chat__header-title`/`.fn-chat__sync-btn`。
- **多端登录收不到消息（根因修复，需重新部署 server）**：`server/src/index.ts` 的 `onlineSockets` 从 `Map<string, WebSocket>`（第二台设备连接会顶掉第一台）改为 `Map<string, Set<WebSocket>>` + `registerSocket`/`unregisterSocket`/`sendToUser` 广播，message/delivery_ack/read_ack 都扇出到该用户所有在线设备。遗留语义：`delivery_ack` 仍会删掉离线队列条目（首个确认的设备生效）——当时离线的设备错过实时推送后由聊天历史同步补齐。
- **重连补拉**：`IMClient` 新增 `setOnConnected`（每次 WS (re)connect 触发）；`VaultApp`/`MobileApp` 在其中做整账户聊天历史同步（60s 节流 ref `lastChatCatchupRef`），覆盖"离线期间消息被其它设备 ack 删除"的空洞。
- **Win 版解锁页焦点丢失**（根因：原生 confirm 抢走 OS 焦点后 reload，Chromium 对未聚焦 document 跳过 autofocus）：
  - `UnlockScreen`：`passwordRef` 挂在两个 tab 的密码框上，mount/切 tab 时显式 focus（立即 + rAF + 200ms + 600ms 重试），window focus 事件里若无焦点元素再抢回；不会从用户已点选的输入框抢焦点。新增 `initialTab` prop。
  - `apps/desktop/electron/main.ts`：`did-finish-load`（窗口聚焦时）与窗口 `focus` 事件都调用 `webContents.focus()`，修复 reload 后渲染进程键盘焦点悬空。
- **解锁页手动改服务器地址**（原问题：云登录时输入新地址 → `commitServerUrl` 中途弹原生 confirm+reload 打断登录；取消则请求被 CSP 拦截，看起来"没法手动输入"）：`handleCloudSync` 开头检测 `serverUrlNeedsReload`，若需要重载则保存地址、写 `sessionStorage.fastnote_unlock_tab='cloud'`、抛出 `unlockScreen.serverChangedReloading` 提示并 1.8s 后自动 reload；重载后 `VaultApp` 一次性读取该标记并通过 `initialTab` 让解锁页直接打开云同步 tab（地址已预填），用户重输密码登录即可。设置页的 `commitServerUrl` confirm 流程保留（焦点问题已由上面两条硬化覆盖）。

## 本次会话的实质性变更（搜索下划线/孤儿笔记 + 表格日期填充 + 交换公式跟随，2026-08-06）

- **全局搜索搜不到下划线关键词（根因修复）**：`packages/search` 的 `stripMarkdownForSearch` 原来用 `/\*\*|__|\*|_|~~/g` 把**所有** `_` 当强调符剥掉，`run_evm_holder_changes_server` 在索引里变成 `runevmholderchangesserver`。改为只剥词边界上的下划线（`/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g`），标识符内部的 `_` 保留（`_em_`/`__bold__` 仍会剥掉；`__init__` 这类 dunder 是已知牺牲）。**配套**：`VaultApp.searchFingerprint` 加了 `search-schema-v2|` 前缀，老快照指纹失配 → 下次解锁自动全量重建，用户无需手动清缓存。以后凡是改 tokenizer/剥离规则都要 bump 这个 schema 标记。
- **全局搜索重复结果"无法定位"（根因=孤儿笔记）**：搜索结果本身已按 live notes 过滤 + 按 id 去重，重复的第二条是**存储里真实存在但父节点丢失的孤儿行**（例如另一台设备删了父文件夹、子笔记后同步进来）——旧 `buildTree` 只从存在的父节点向下递归，孤儿永远不进侧栏树，但会被索引和搜索到。修复：`packages/shared` 的 `buildTree` 现在把 `parentId` 指向不存在（或已 deleted）节点的条目**收养到根层级**，可见、可定位、可删除（进回收站后重复结果即消失）。注意收养只发生在顶层调用（`parentId === null`）；两个调用方（VaultApp 焦点遍历、NoteTree）都从根构树。环状 parentId（A↔B）不在处理范围。
- **表格日期自动填充**（`packages/table/src/fill.ts`）：新导出 `parseDateValue`（支持 `YYYY-MM-DD` / `YYYY/M/D` / `YYYY.M.D` / `YYYY年M月D日`，UTC 往返校验拒绝 2026-02-30 这类假日期）；`fillValueAt` 在数字分支**之前**检查全日期源：单格 +1 天/步，多格按天差等差延续（`Math.round` 容忍不均匀源），上/左方向由调用方反转源序列的既有约定自然生效。格式保真：分隔符、月/日补零风格、中文年月日按源样式输出（多格时用第一格的样式）。日期序列走 `Date.UTC` 天序数运算，无 DST/时区问题。
- **Alt+方向键交换自动调整公式**：`formula.ts` 新导出 `rewriteFormulaRefsForSwap(raw, kind, i, j)`（行/列交换：引用**跟随内容**做 i↔j 置换映射，公式计算结果不因交换而变；范围端点同样映射后重新归一化 lo/hi——交换完全在范围内或完全在范围外时不变；`C:C` 整列引用跟随；混合形式 `C1:C` 保持端点角色）和 `rewriteFormulaRefsForCellSwap(raw, a, b)`（单格交换：只重写恰好指向这两个格子的单元引用，范围不动——单格跨范围边界移动无法用范围表达）。接线在 `utils.ts` 的 `swapRows`/`swapColumns`/`swapCells` 内部（都先换位再 `rewriteDocFormulas`，置换映射对称所以顺序无关），Alt+↑↓←→ 的三条路径（整行/整列/单格）自动受益。范围端点部分覆盖交换时按"端点跟随"规则（如 `B1:B3` 交换行 3、5 → `B1:B5`），与插入的吸收语义一致的取舍。
- 冒烟测试：`/tmp/fn-search-test.mjs`（9 断言）+ `/tmp/fn-table-swap-date-test.mjs`（34 断言）全过；全仓 18 包 typecheck 通过。

## 本次会话的实质性变更（单元格级数字格式，2026-08-06 下午）

- **数字格式下沉到单元格级**：`TableCellStyle` 新增 `format?: TableColumnFormat`（shared），随既有的 单元格 > 行 > 列默认 样式合并链生效；`TableColumnFormat.kind` 扩展 `'none'`——**仅作单元格级覆盖使用**，表示"显式无格式"（否则格式化列里的单元格无法退出列格式）。新 `resolveCellFormat(cellFormat, colFormat)`（`formula.ts`）：cell 覆盖优先、'none' 解析为 undefined，渲染/自动列宽/工具栏指示三处统一走它。
- **工具栏语义**（`TableEditor.tsx`）：`applyColumnFormat` 重构为 `applyNumberFormat`——整列选中时仍写列级 `col.format`（覆盖被筛选行和未来新行）**并清掉选区内单元格级覆盖**；其他选区写单元格级 `style.format`。选"原始值"时：所在列有列格式的格子写 `{kind:'none'}` 退出，无列格式的格子直接删 key。指示器 `anchorFormat` = 首目标格的有效格式（原 `anchorColFormat` 删除）。小数位调整基于锚点格式统一应用到选区（不再逐列保留各自小数位）。`clearFormatting` 的 clearAll 补了 `format: undefined`。
- 单元格交换（Alt+方向键 swapCells）连带 styles 交换，格式自动跟随内容，无需额外处理。
- i18n `tableEditor.numberFormat` 文案更新为"作用于选中单元格；选中整列时作用于该列"。
- 冒烟测试 `/tmp/fn-cellformat-test.mjs` 14 断言全过；全仓 18 包 typecheck 通过。

## 本次会话的实质性变更（公式绝对引用 $ + F4，2026-08-06 下午）

- **绝对引用**：公式支持 `$A$1` / `A$1` / `$A1` 及整列 `$C:$C`。求值忽略 `$`（`evaluateExpression` 开头 `replace(/\$/g,'')`）。填充位移（`fill.ts` `shiftFormulaRows/Cols`）：`CELL_REF` 改为 `(\$?)([A-Za-z]+)(\$?)(\d+)`，锚定轴不移动；`COL_ONLY_REF` 同步支持 `$C:` / `:$C`，且负向前瞻改为 `(?![A-Za-z]*\$?\d)` 修掉 `:C$5` 被误判为整列引用导致双移的隐患。
- **结构性编辑保留 `$`**：`rewriteFormulaRefs` 的 token 正则解析 `$` 并在 `RefEndpoint`/`RefUnit` 上带 `absCol/absRow` 标志，重写输出时还原 `$`；插入/删除/交换仍照常调整下标（Excel 语义：`$` 只影响填充/复制，不影响结构性编辑）。swap 的 corner 归一化会让 `$` 跟随其锚定的值交换。
- **F4 循环**：新 `cycleRefAnchorAtCaret(text, caret)`（formula.ts 导出）：A1 → $A$1 → A$1 → $A1 → A1；整列端点（紧邻冒号的纯字母 token）在 $C ↔ C 间切换；函数名/非引用返回 null；保留大小写。`handleCellKeyDown` 中：编辑公式单元格时按 F4（无修饰键）循环光标处引用并用 rAF 恢复光标；在公式中但不在引用上时吞掉按键（避免误触发 F4 重复上次结构操作）；非公式单元格 F4 保持原有 repeat-last-action。
- 帮助弹层新增 `tableEditor.helpAbsRef`（zh/en）说明 $ 与 F4。
- 冒烟测试 `/tmp/fn-absref-test.mjs` 31 断言全过（求值/填充/插删/交换/F4 循环）；全仓 typecheck 通过。

## 本次会话的实质性变更（表格剪切 Ctrl+X，2026-08-07）

- **单元格剪切**（`TableEditor.tsx`）：新 `cutSelectedCells()` = `buildRangeTsv('raw', true)`（公式复制源码，剪切是移动语义）+ `copyTextToClipboard`（同时写 internalClipboardRef）+ `clearSelectedCells()`。三条路径：
  1. `handleGridCut`（容器 onCut）：单元格 textarea 聚焦时 Ctrl+X 触发；多格选区整体剪切（preventDefault + setData + 清空），单格编辑中保持 textarea 原生文本剪切（`buildRangeTsv('raw')` 无 allowSingle 返回 null）；工具栏/筛选 input 聚焦时跳过。
  2. `handleContainerKeyDown` 的 Mod+X 回退：无文本焦点（选中未编辑的格/整行整列）时 keydown 处理，镜像 Mod+C 块。
  3. 右键菜单新增"剪切"按钮（列表首位）。
- i18n 新 key `tableEditor.ctxCut`（剪切/Cut），`helpExcel` 帮助文案补 Ctrl+X。
- 剪切走 emitChange 历史，Ctrl+Z 可撤销。

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
