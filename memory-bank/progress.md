# Progress — FastNote

## 状态总览

MVP（`docs/PHASE1.md` M1–M8）已全部完成并在 M8 之后继续做了大量体验/安全类增强。当前版本号 `0.21.0`（2026-07-31 随 git 提交按约定 minor bump；server 保持 0.8.1，本轮无服务端改动）。本版内容：**填充柄横向填充**（四向拖动、按溢出量大的轴定向，横向填充平移公式列引用含整列引用 `C:C`、小写保持、A 列钳制，纵向行为不变）；**操作焦点跟随选区**（`focusCell` 随 `selFocus` 同步，插入时间/附件/粘贴回退等操作作用于选中格而非上次编辑格，附件格点选归还键盘焦点给网格）。此前 `0.20.0`（2026-07-29 随 git 提交按约定 minor bump；server 保持 0.8.1，该轮无服务端改动）。0.20 内容：**表头两行重构**（控制行：加宽列号 + 排序按钮 + 删除，✎ 移除；列名行：单击选中/多选（拖动、Shift+点击、Shift+←→）/复制/Del 清空/双击或回车编辑（Ctrl+A 只全选列名）/右键复制粘贴删除；表头文字水平垂直对齐存 `TableColumn.headerStyle`；双行 sticky 由 `--fn-head1-h` 联动）；**整列/整行对齐默认值**（`TableColumn.cellStyle`/`TableRow.style`，整列/整行选中时写默认并清单元格级覆盖，含未来新行新列，渲染优先级 单元格>行>列）；**表头↔首行互转**（新按钮"表头作首行"与"首行作表头"互逆，双向自动平移公式引用——promote=删首行、demote=顶部插行，范围吸收/单引用平移、往返可逆，21 断言冒烟全过）；**回收站**（笔记 + AI 两个 sidebar，`trashed` 软删随同步、还原/清空/永久删除、搜索与标签页对回收项隐身，共用 `TrashSection` 组件）；**小写列引用下拉填充**（`=sum(b1:b6)` 下拉行号平移）；**表格 Del 不再误删 sidebar 文件**。此前 `0.19.0`（2026-07-28 随 git 提交按约定 minor bump；**server 同轮 bump 至 0.8.1，JWT 有效期 7d→30d，需重新部署**）。0.19 内容（五项）：**表格 Excel 风格编辑**（非编辑态单元格 readOnly：单击只选中、双击/回车/直接输入进入编辑、方向键移动选区（Shift 扩选）、Del/Backspace 清除内容、编辑中 Enter 提交并下移选区不进编辑；自绘右键菜单：复制（公式源码）/仅复制值/粘贴替换（clipboard.readText 失败回退内部复制缓冲）/清除内容，正在编辑的格保留原生文本菜单，readOnly 同时让桌面端原生菜单不再抢弹；onPaste/onCopy 上移到容器 div 支持"仅选中未编辑"时的 Ctrl+V/C）；**数字格式百分比**（`TableColumnFormat.kind` 增 percent，×100 后 toPrecision(15) 防浮点翻转再拼 %）；**单元格对齐**（`TableCellStyle.align/valign`，水平 textAlign、垂直 td vertical-align，工具栏两个下拉，清除格式一并清）；**公式千分位逗号清除**（提交时严格 3 位分组 `1,000`→`1000`，参数逗号 SUM(A1,B2) 不动，仅改源码不动显示格式化）；**登录有效期 30 天**（server JWT expiresIn 7d→30d 两处，**需重新部署 server**，server bump 0.8.1）。冒烟 12 例全过、全仓 typecheck 绿。**反馈修复**：容器级按键判定改用 `e.target`（此前用 activeElement，单元格 Enter 的 blur+refocus 让容器分支把刚提交的格重新打开编辑——"回车无法确认"及连带的"仅复制值失效"根因）；移除工具栏货币符号 $ 输入框（symbol 字段保留默认 $）；对齐下拉文案压缩防工具栏换行撑高。此前 `0.18.0`（2026-07-22 随 git 提交按约定 minor bump；**server 同轮 bump 至 0.8.0，新增 AI 同步端点，需重新部署**）。本版内容：**全局搜索清缓存重建**（搜索结果按存活笔记过滤+去重，设置→存储新增"清除缓存并重建索引"按钮走后台全量重建）；**空链接=取消链接**（工具栏链接输入条确认空值调 unsetLink）；**AI session 随账户 E2E 加密云同步**（server 新 `ai_blobs` + `PUT/GET /api/v1/sync/ai`，**server 需重新部署**；整节点 notesKey 加密 blob LWW 合并、墓碑删除；触发：手动同步/登录/解锁/防抖 5s 后台推送，桌面+移动端都接入；两设备模拟测试 15 项全过）；**插入/删除行列公式引用自动调整**（重写为引用单元级：`B1:B6` 端点配对处理，插入行轴吸收语义——上方/内部/末行正下方插行 `=sum(b1:b6)` 都变 `B1:B7`，列轴纯平移；删除经 `rewriteFormulaRefsForDelete` 收缩范围、被删中的引用变 `#REF!`（tokenize 识别并按 `#REF!` 展示），38 例测试全过）；**整列引用忽略自身**（`=SUM(B:B)` 可放在 B 列内做汇总行，展开时跳过公式所在格、不再 #CIRCULAR!，其他列引用 B:B 仍含汇总值，10 例测试全过）。此前 `0.17.0`（2026-07-19 八项：**全局搜索精确匹配**（MiniSearch AND+无 fuzzy 候选 + 逐字包含过滤，查询串必须完整出现在标题/正文，冒烟 5 例全过）；**sidebar 新建焦点跳转**（新建笔记/表格/文件夹后树焦点/选中指向新节点、父文件夹自动展开）；**表格 Enter/Esc 后键盘失效修复**（末行 Enter 与 Esc 的 blur 后补 `containerRef.focus()`，Shift 移动/Alt 交换/Esc 不再哑火）；**标签页视口保存/恢复**（分组根 `onScrollCapture` 按 group:tab 记录滚动位置，切标签 rAF 恢复，`restoringViewportRef` 防 clamp 事件污染）；**聊天历史登录后全量同步**（`handleLogin`/解锁后台补调 `syncChatMessages`，此前只挂手动同步按钮）+ **聊天右键复制完整消息**（无选区时自绘菜单，有选区仍走原生）；**Android 版聊天**（MobileApp 移植 initIM/收发/已读/未读全链路，解锁页云登录真实化——新设备采用账号盐值，💬/🤖 视图切换 + ChatSidebar/ChatPanel 复用，CSP 引导脚本放行配置的服务器 origin）；**AI 会话树增强**（focusId 焦点 + 同层级新建 + 新节点自动聚焦展开 + F2 重命名 + ⊞/⊟ 展开收起全部）；**Tab 制表符**（笔记双模式/表格单元格/聊天/AI 输入框，源码模式多行选区走 indentWithTab 缩进语义））。上一版 `0.16.0`（2026-07-15 第三批：**表格交互精修**——最小行高缩至 12px（根因：`.fn-table-cell` 的 `min-height:1.75rem`＝28px 且 min-height 优先于 max-height，固定高度行现走 `fn-table__row--fixed` + `--fn-row-h` 变量裁剪，行号/删除按钮垂直居中）；Esc 撤销本次单元格编辑（恢复聚焦时快照）或清除选区；Shift+方向键移动选中格并直接进入编辑（原格内容保留）；公式提交（Enter/失焦/Shift+方向移走）自动补全未闭合小括号；**内容区扩容**——删表格底部提示行、总行数并入统计栏常驻、表格面板顶部 padding 归零、表头恒单行（长列名省略号截断，上下 padding 减半）；**智能全选** Ctrl/⌘+A——焦点不在输入框时按内容分发：笔记全文（WYSIWYG 走 Tiptap selectAll、源码走 CM state）、表格全部单元格（NoteEditor/TableEditor 新 `onRegisterSelectAll` 注册模式）、AI 会话 DOM 选中整段对话）。上一版 `0.15.0`（2026-07-15 第二批：**表格公式点选引用**——输入 = 后点击其他单元格插入引用（连续点选替换上次引用）、拖动扩为多行多列区间、点击列号插入整列引用；**公式整列引用** `=SUM(C:C)`（含 A:C、C1:C 混合形式）；**统一行高**（↕ 弹层应用到所有行/恢复自动）；**双击列宽拖柄自适应内容**（canvas 测量，尊重单元格字体样式与数字格式）；**新行/列插入方向选项**（上/左或下/右，全局持久化）。冒烟测试 9 断言全过）。上一版 `0.14.0`（2026-07-15：**聊天多行输入**（textarea + Shift+Enter 换行/Enter 发送）；**桌面版网络代理**（HTTP/SOCKS5，Electron session.setProxy 覆盖 fetch+wss，设置→账户与同步配置即时生效；浏览器无法由页面设代理，网页版仅提示用系统代理）；**笔记/表格去标题栏**（改名走侧边栏）+ 表格功能栏紧凑化 + 筛选栏可收起（收起清空筛选，localStorage 持久化）；**表格清除格式按钮**（清单元格样式，整列选区连同数字格式）；**第五套「简洁」主题**（仿 Google Docs/Sheets 白底配色，表格内容区纯白））。上一版 `0.13.0`（2026-07-14 随 git 提交按约定 minor bump：**协作标题同步 + 侧边栏协作徽标**——文件名走整值 LWW 广播（state 消息携带 title，新加入者同时采纳内容与标题），侧边栏对协作中的条目显示 👥 绿色脉冲徽标（NoteTree 新 collabIds prop，label grid 扩为 5 列）；**协作房间号防冲突**——房间由「随机房间号（🎲 生成，作为 PBKDF2 盐）+ 协作密码」共同派生，不同文档同密码不再撞房，加入弹层增加房间号输入/生成、会话中显示房间号；e2e 隔离/标题断言全过，server 协议零改动、保持 0.7.2）。上一版 `0.12.0`（2026-07-14 随 git 提交按约定 minor bump，server **0.7.2** 需重新部署：**笔记/表格实时协作**——新包 `packages/collab`：协作密码本地 PBKDF2 600k + HKDF 派生房间 ID/AES-GCM 密钥，服务器新增 `/ws/v1/collab` 纯内存密文中继房间（需登录 token，零持久化，零知识语义不变）；同步用 diff-match-patch 差分（shadow + fuzzy patch，表格 JSON 合并前校验、坏补丁回退全量重传，新加入者采纳会话内容）；NoteEditor 源码模式改最小 diff 应用保光标 + 新 `externalContentNonce` prop 应用渲染模式远端变更；VaultApp 笔记/表格头部「👥 协作」按钮 + 密码加入/退出弹层（状态点+房间人数），锁库关闭全部会话；e2e 冒烟（真实 server + 双客户端并发编辑收敛）7 断言全过）。上一版 `0.11.4`（2026-07-14 本地 patch，未提交：**Android 移动版首版**——新 workspace `apps/mobile`（Capacitor 8 包壳，appId `com.fastnote.mobile`），首版范围 = 解锁/建库 + AI 助手：复用 UnlockScreen/AiSessionTree/AiWorkbench + 自写 MobileSettings，库格式与桌面一致（同一 IndexedDB 布局），移动端"转为笔记"改为分享/复制 Markdown，云同步暂不支持；样式复用 apps/web/styles.css + mobile.css 触控覆盖层（hover 门控按钮常显、safe-area、100dvh）；CSP connect-src 仅 self+anthropic；`android/` 原生工程已入库（构建 APK 需 Android Studio/SDK），根脚本 dev:mobile/android:sync/android:open/android:apk；i18n 新增 mobileApp.*，README 双语补 Android 章节）。上一版 `0.11.3`（2026-07-14 本地 patch，未提交：源码输入换行切换丢失根治——`preserveBlankLines` 尾部规则改为整段消费 `/\n+$/`（n 换行 → n 个 NBSP 段落、不留尾换行，避开 marked 吸收尾换行 + @tiptap/markdown 隐式空段落双重计数），序列化尾部哨兵还原 m 个换行；用真实 marked lexer + 照抄 tiptap parseTokens 算法的 18 个往返断言验证）。上一版 `0.11.2`（2026-07-14 本地 patch，未提交：渲染模式换行丢失修复——代码块内空行不再被序列化折叠（折叠只作用于围栏外）、文档首/尾空行经 NBSP 段落往返保留（preserveBlankLines 加头尾规则 + 序列化尾部哨兵还原）；表格 +行/+列 在选中单元格所在行/列之前插入（无选区仍追加末尾，插入后选区跟随原单元格））。上一版 `0.11.1`（2026-07-14 本地 patch，未提交：笔记源码模式鼠标中键矩形选区（列选/多光标列编辑，`rectangularSelection` eventFilter）；AI 查找框改自增高 textarea 保留并显示多行查询的换行符（Ctrl/⌘+Enter 插入换行）；表格 Ctrl/⌘+A 全选（编辑中两段式：先全选格内文字再全选网格），帮助弹层加说明）。上一版 `0.11.0`（2026-07-13 提交，覆盖 0.10.1/0.10.2 全部本地改动 + AI 查找滚动最终修复：mark 的 `scrollIntoView` 在渲染视图中被静默吞掉，改为对消息滚动容器直接计算写 `scrollTop` 居中（`scrollFindMarkIntoView`），且 `stepFind` 每次步进实时重新收集可见 mark 列表防游离节点；README 中英功能清单同步 0.9.x–0.10.x 新特性。server 保持 0.7.1）。上一版 `0.10.2`（2026-07-13 本地 patch：AI 渲染模式查找高亮从"事后 DOM 注入"（被 React 协调覆盖导致 response 无高亮、导航不动）改为**渲染管线的一部分**——`MarkdownView.highlightQuery` prop + `highlightHtml`（DOMParser 层面包 `<mark>`，跳过 .katex 子树，两级 useMemo 避免查询敲击重跑 marked/KaTeX），源码/plain 消息用 `renderHighlightedText` React 节点切分；导航 effect 只负责收集可见 mark + 滚动。含 0.10.1：mark 列表按 `getClientRects()` 过滤不可见项）。上一版 `0.10.0`（2026-07-13 提交，覆盖 0.9.1–0.9.4 全部本地改动 + AI 查找导航修复：AI 会话查找从消息级导航改为**逐个 `<mark>` 命中导航**（长消息 block:center 居中导致的"跳到不知道哪里"根治，↑↓ 逐处跳转、当前命中橙色高亮、流式重建 mark 不拽动视口）；server 保持 0.7.1（bodyLimit 32MB，需重新部署））。此前 `0.9.4`（2026-07-13 本地 patch，3 项：查找替换支持多行内容（查找栏改自增高 textarea，Ctrl/⌘+Enter 换行；Ctrl+F 预填保留完整多行选中；渲染模式 `findMatchesInDoc` 重写为扁平化匹配——跨段落/跨 mark 边界均可命中，hardBreak/块边界视为 `\n`）；表格/AI 会话查找高亮（表格命中单元格黄色蒙层+当前格橙色描边 `fn-table__cell--find(-current)`；AI 消息体 TreeWalker 注入 `<mark class="fn-ai-find-mark">` 文本级高亮，幂等解包重打）；表格 Enter 下移时选区焦点框跟随（补 setSelAnchor/setSelFocus））。上一版 `0.9.3`（2026-07-13 本地 patch，未提交，4 项：Ctrl+F 立即聚焦查找框且选中文本自动预填（`FindReplaceBar.focusNonce`，已打开也重新聚焦/预填）；表格支持查找/替换（`TableEditor.onRegisterFindReplace` 实现 `FindReplaceController`，出现级匹配、单格选区高亮+滚动定位、replace/replaceAll 走统一 undo，表格分支复用同一 `FindReplaceBar`）；AI 会话查找（Ctrl+F 转发 `aiFindRequest` → AiWorkbench 内置 `.fn-ai-findbar`，消息级匹配、`data-msg-idx` 滚动定位+描边高亮）；同步 413 修复（server Fastify `bodyLimit` 1MB → 32MB，需重新部署，server 版本 0.7.1；客户端 413 抛专用文案 `apiClient.payloadTooLarge`））。上一版 `0.9.2`（2026-07-13 本地 patch，未提交，3 项跟进：AI 联网搜索次数上限可在设置中配置（1–50，默认 5，`AiSettings.webSearchMaxUses` → tools.max_uses）；笔记附件改为 📎 按钮+弹窗（与表格一致，移除下方内联面板，state 更名 `showAttachmentsModal`）；多行单元格复制/粘贴 Excel 风格引号语义（`encodeCellForCopy` + `parsePasteGrid` 引号感知重写，Shift+Enter 换行的单元格复制粘贴不再拆成多行，单格全选复制自动加引号）。0.9.1 内容（7 项：AI 联网搜索（Anthropic 服务端 web_search 工具，`AiSettings.webSearch` 设置开关，流式显示"正在联网搜索（第 N 次）"，客户端零新增网络连接）；渲染模式长文查找跳转修复（rAF 后直接滚动 `.fn-find-match--active` 装饰元素）；全局搜索点击结果 → 源码视图定位关键词（`locateNoteInSource` 切分组到 source + FindReplaceBar `initialQuery` 轮询控制器）；文件夹 F2 重命名焦点修复（F2 目标 `treeAnchorIdRef ?? activeIdRef`，selectTabInGroup 同步 anchor）；同步失败详细原因入运行日志（`ApiClient.httpError` 记端点/状态/响应体，`handleSync` catch 记完整错误）；运行日志本地时间（`formatLocalTs`）；表格单元格 Shift+Enter 格内换行（cell input → 自增高 textarea））。上一版 `0.9.0`（2026-07-12 提交，覆盖 0.8.1–0.8.7 全部改动，README 中英双语功能清单已同步。0.8.7：**修复关闭公式解析导致笔记公式文本永久丢失的严重 bug**——@tiptap/markdown 默认把扩展 tokenizer 注册到 marked 全局单例且不可逆，关闭数学后 `$$` token 无处理器被静默丢弃、autosave 写盘；现给每个编辑器注入独立 `new Marked()` 实例（editor 包直接依赖 marked@^17 与 tiptap 同 major）。KaTeX 两处渲染加 `strict: false`，消除公式含中文/长破折号时的控制台警告刷屏。此前：焦点历史记录扩展——点选标签页、光标在内容区点选、打开标签页（openNoteInGroup，覆盖侧栏点选/双击/新建/导入）都记录焦点，跳转热键 focusPrev/focusNext（默认 Ctrl+Alt+←/→）加入快捷键设置可自定义。0.8.4 内容：表格分隔符多选自定义（⌗ 工具栏弹层，Tab/分号/逗号/空格，优先级取第一个出现的分列，复制用最高优先级项，localStorage 持久化）；AI 消息导出菜单——Markdown (.md) / Word 文档 (.doc，HTML+msword MIME 包装，公式保留 TeX 源码)，图片导出按用户许可搁置。0.8.3 内容：表格 Alt+方向键调序——整行 Alt+↑/↓、整列 Alt+←/→、单格与相邻格交换内容和样式（`swapRows/swapColumns/swapCells`，走统一 undo）；AI 会话"转为笔记"——全部问答或按问答组选范围，拼 markdown（角色+时间标题、附件引用、`---` 分隔）建根级笔记并打开；Ctrl+Alt+←/→ 编辑焦点历史跳转——`updateNoteById` 记录编辑 note id（去重+分支截断，上限 100），跳转目标标签页设为活跃并固定、已关闭则重新打开。0.8.2 内容：表格右键不再取消多格选区/卡住拖选状态（mousedown 只响应主键），桌面右键菜单加"粘贴并匹配格式" role；登录过期（401）识别为 `ApiAuthError` → 清除本地 session、顶部 banner 提示重新登录（不再伪装成"上传公钥失败"）；设置界面选项卡化（通用/账户与同步/AI/快捷键/存储，760px 宽，tab 栏和页脚固定、内容区滚动））。上一版 `0.8.0`（2026-07-12 提交，覆盖 0.7.1/0.7.2 及本版：表格多格复制修复 + Mod+C 兜底、桌面右键菜单（Electron context-menu + role 菜单）、AI 消息流粘性吸底滚动、响应超 30s 耐心提示、AI 回复 KaTeX 公式渲染（latexDelimiters 移入 shared + extractMathSegments）、AI 消息时间戳（发送/开始接收/接收完毕，`AiMessage.startedTs`）。此前详情：AI Workbench 消息流粘性吸底滚动（翻阅历史不被拽回底部）、响应超 30s 耐心提示（`aiRun.startedAt` + `patience/patienceThinking` i18n）、AI 回复 KaTeX 公式渲染（`latexDelimiters` 移入 shared + `extractMathSegments` 占位符抽取，MarkdownView 接入 katex）。同版本 0.7.1 改动：修复表格多格复制——去掉误伤的"单元格内文字选区让位"guard 并补 Mod+C keydown 兜底（整行/列选中时无 copy 事件可依赖，走隐藏 textarea + execCommand）；桌面端新增原生右键菜单——Electron main 进程 `context-menu` 事件按 editFlags 弹 cut/copy/paste/selectAll，role 型菜单不受渲染进程剪贴板权限全拒策略影响）。上一版 `0.7.0`（2026-07-12 提交 `959bc70`，本地开发期间曾短暂为 0.6.1 patch；本版覆盖：表格数字格式/时间插入/统计栏固定/帮助按钮/附件弹窗/取消外部滚动条、AI 附件/后台流式/消息删除导出/超时与思考流加固/max_tokens 设置化（上限 128k）/模型列表更新、桌面打包 npmRebuild 修复、内容区最大宽度 2400px。此前 0.6.1 的 7 项详情：表格粘贴不再按逗号分列、公式/统计支持千分位逗号数字（`parseNumericValue`）、列数字格式 number/currency/小数位（`TableColumnFormat`，仅显示层格式化，原始值不变）、🕒 一键插入本地时间；AI 请求附件（图片/PDF 原生 content block，docx 用 fflate 本地解压提取文本，旧版 .doc 启发式 UTF-16LE 提取，8MB 上限）、流式回复上提到 VaultApp（切 session/切视图不中断，单并发 + busy 提示）、消息逐条删除/导出 md。顺手修复 `apps/desktop/tsconfig.json` 缺 `@web/*` paths 导致的 typecheck 报错，全仓 typecheck 现全绿。上一版 `0.6.0`（2026-07-10 bump，覆盖：AI Workbench（Claude 对话，加密会话树 + API key 库内加密）、跨密码库文件传输/移动、笔记查找替换（Ctrl+F 双模式）、渲染工具栏 prompt 失效修复，以及随后的 6 项反馈——AI 面板置顶固定、AI 回复渲染/源码切换、AI/笔记快速切换按钮、渲染模式查找失效修复、Ctrl+点击链接开系统浏览器、绿点仅云登录显示；此前 0.2.0 → 0.5.0 历史见下方清单与 `activeContext.md`）。**桌面打包脚本已修复**：`apps/desktop` 的 `dist:mac`/`dist:win`/`dist:linux`/`pack`/`dist` 原来只跑 `electron-builder`、直接打包上一次遗留的 `dist/` 产物（不重新构建），导致打出的包不含最新代码；现在全部改为 `pnpm build && electron-builder ...` 先重建再打包（CI workflow 本来就先跑 build，不受影响）。Web 前端有 Vercel 部署方案（`vercel.json` + `docs/VERCEL.md`），与自托管中继服务器（`docs/DEPLOYMENT.md`）完全独立、互不影响。

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
- [x] 表头两行重构（2026-07-04）：控制行（加宽列号 + 排序按钮 + 删除，✎ 移除）+ 列名行（单击选中/复制/Del 清空/双击或回车编辑全选确认），双行 sticky 由 `--fn-head1-h` 联动
- [x] 横向填充 + 操作焦点跟随选区（2026-07-31）：填充柄四向拖动（按溢出量大的轴定向；横向填充平移公式列引用含整列引用 `C:C`，小写保持、A 列钳制；纵向行为不变）；`focusCell` 随 `selFocus` 同步，插入时间/附件等操作作用于选中格而非上次编辑格，附件格点选也归还键盘焦点给网格（16 断言冒烟全过）
- [x] 整列/整行对齐 + 表头↔首行互转（2026-07-29）：列级 `TableColumn.cellStyle`/行级 `TableRow.style` 对齐默认值（整列/整行选中时写默认并清单元格级覆盖，含未来新行新列；渲染优先级 单元格>行>列）；新按钮"表头作首行"（`demoteHeaderToFirstRow`，列名下放+headerStyle 随行）与"首行作表头"互为反操作，两者都自动平移公式引用（promote=删首行语义、demote=顶部插行语义，范围引用吸收扩展、单引用平移，往返可逆，21 断言冒烟全过）
- [x] 表头名称多选/对齐/右键（2026-07-29）：`selHeader` 范围选择（拖动/Shift+点击/Shift+←→ 扩选）；`TableColumn.headerStyle` 承载水平/垂直对齐（工具栏对齐下拉在表头选中时改写表头样式）；右键菜单（复制/粘贴/删除，`ctxMenu.kind='header'`），粘贴按分隔符逐列铺开且不受排序筛选限制（Ctrl+V 同样支持）；列名编辑中 Ctrl+A 只全选列名
- [x] 下拉填充支持小写单元格引用（`fill.ts` 的 `CELL_REF` 大小写不敏感）
- [x] 表格内按 Del 不再触发侧栏文件删除（全局快捷键增加 defaultPrevented + `.fn-table-editor` guard）
- [x] 回收站（笔记 + AI sidebar）：`trashed` 标记贯通 shared/storage/sync，删除先进回收站（有确认，文案提示可还原），支持还原/单项永久删除/清空（均有确认）；搜索、标签页、焦点历史对 trashed 隐身；共用组件 `TrashSection`，移动端 AI 树同步支持
- [x] 表格多格粘贴锚定选区（2026-08-03）：`handleGridPaste` dataset 分支改用 `selectionRangeRef` 左上角作为起点（避免插行后残留焦点 textarea 的过期 data-row-idx）；`handleAddRow`/`handleAddColumn` 结束后焦点归还网格容器
- [x] 聊天实时上传 + 手动同步按钮（2026-08-03）：`SyncClient.pushChatMessages`（push-only）+ `scheduleChatPush` 3s 防抖（VaultApp/MobileApp 的 `persistChatMessage`）；`ChatPanel` 头部"⟳ 同步历史"按钮（`onSyncHistory` prop，完整 push+pull 后刷新）
- [x] 多端登录收不到聊天消息（2026-08-03，**需重新部署 server**）：`onlineSockets` 改为 `Map<string, Set<WebSocket>>` 全设备扇出（message/delivery_ack/read_ack）；`IMClient.setOnConnected` 重连时整账户聊天历史补拉（60s 节流），覆盖离线期间被其它设备 ack 删除的队列消息
- [x] 安卓运行日志 + 渲染模式多行选区回车修复（2026-08-13）：移动端 installConsoleCapture + 设置内 LogsModal；NoteEditor 拦截跨块选区 Enter 改走 PM 先删后分命令链（绕过 Tiptap v3 splitBlock pre-delete canSplit 缺陷）
- [x] AI 草稿保留 + 表格格式全选区生效（2026-08-11）：composerDrafts 按会话保留未发送输入（切会话/切标签均保留）；表格工具栏 formatSummary 混合占位、加粗 Excel 语义（任一非粗→全粗，取消时显式 false 覆盖行列默认）
- [x] 表格剪切 Ctrl+X（2026-08-07）：单格/多格选区剪切（公式保留源码），事件路径 + 键盘回退 + 右键菜单"剪切"，可撤销
- [x] 公式绝对引用 $ + F4 循环（2026-08-06）：$A$1/A$1/$A1/$C:$C 求值忽略 $、填充位移固定锚定轴、结构性编辑保留 $ 并照常调整下标；编辑公式按 F4 循环光标处引用形式（cycleRefAnchorAtCaret）
- [x] 单元格级数字格式（2026-08-06）：`TableCellStyle.format` 随样式合并链（cell>row>col.cellStyle）覆盖列格式，`kind:'none'` 作单元格显式退出；工具栏整列选中写列级并清单元格覆盖、其他选区写单元格级；`resolveCellFormat` 统一渲染/自动列宽/工具栏指示
- [x] 全局搜索下划线关键词 + 孤儿笔记（2026-08-06）：`stripMarkdownForSearch` 只剥词边界下划线（标识符如 `run_evm_holder_changes_server` 可搜），搜索指纹加 `search-schema-v2` 前缀让旧快照自动重建；`buildTree` 把父节点丢失的孤儿收养到根层级（重复搜索结果可定位、可删除）
- [x] 表格日期自动填充（2026-08-06）：`parseDateValue` 支持 ISO/斜杠/点/中文年月日，单格 +1 天、多格按天差等差，格式与补零风格保真，UTC 天序数运算
- [x] Alt+方向键交换公式引用跟随（2026-08-06）：`rewriteFormulaRefsForSwap`（行/列 i↔j 置换，引用跟随内容、结果不变，范围端点映射+归一化，整列引用支持）+ `rewriteFormulaRefsForCellSwap`（单格交换只重写精确指向的单元引用），接线于 utils 的 swapRows/swapColumns/swapCells
- [x] Win 版解锁页焦点 + 服务器地址手动输入（2026-08-03）：`UnlockScreen` 密码框显式聚焦（多次重试 + window focus 兜底，新增 `initialTab` prop）；desktop main.ts 在 `did-finish-load`/窗口 focus 时 `webContents.focus()`；解锁页云登录换新地址时不再中途弹原生 confirm——保存地址 + 提示 + 自动 reload 并经 `sessionStorage.fastnote_unlock_tab` 回到云同步 tab

- [x] 安卓登录过期显著提示（2026-08-13）：`IMClient.setOnAuthError`（pending 拉取 401 触发）+ 移动端 `sessionExpired` banner（复用桌面样式，safe-area 适配），401 时丢弃死 session 并引导去设置重新登录；桌面 initIM 同步接线
- [x] 安卓首条消息收发提速（2026-08-13）：公钥上传不再阻塞 WS 连接（后台化）；登录/解锁不再 await 全量聊天历史同步（统一走 onConnected 后台 catch-up，消除重复拉取）；initIM 重置 catch-up 节流
- [x] 安卓指纹解锁（2026-08-13）：`@capgo/capacitor-native-biometric`，主密码存 Keystore（BIOMETRY_CURRENT_SET，读取强制指纹），设置开关 + 解锁屏自动弹窗 + 次级按钮，密码变更自动失效回退

- [x] 文件传输助手（2026-08-14）：自聊复用 1:1 E2E 通道（自身密钥对 ECDH，各设备根密钥一致）；`IMClient.setSelfId` + 自会话计数绕过（跨设备 sendCounter 不单调，靠消息 id 去重防重放）；入站自消息按 'out' 落库、跳过提示音；侧栏置顶"📁 文件传输助手"入口；实时走 WS fan-out，离线补齐走既有历史 blob 同步；服务器零改动

- [x] 自聊实时投递修复（2026-08-14）：E2E 定位两个根因——回显回执删掉 pending 副本（服务器改为自消息不回显来源 socket）、WS 无心跳导致假死连接（IMClient 20s 心跳 + 50s 无帧强制重连 + `nudge()`）；安卓回前台主动补拉；onConnected 节流 60s→15s；**需重新部署 relay**
- [x] 安卓打包自动递增版本（2026-08-14）：versionCode=构建 epoch 秒、versionName=包版本+时间戳，gradle 配置期自动生成

- [x] 自聊密钥根因修复（2026-08-14）：交换密钥对为每设备随机（非主密码派生），own-key ECDH 跨设备根密钥不一致 → `invalid ghash tag`；自聊根密钥改为 HKDF(masterKey)（`deriveSelfChatRootKey`），self 会话不查服务器公钥，旧会话自动迁移；E2E 不同私钥拓扑验证通过
- [x] IM 调试日志（2026-08-14）：self-chat key 指纹、send/recv（id/counter/keyfp）、ws 生命周期、心跳回收——两台设备对比 keyfp 即可定位密钥不一致
- [x] 指纹录入降级（2026-08-14）：CURRENT_SET→BIOMETRY_ANY→verifyIdentity 软门控三级降级，flag 存 'hw'/'soft'，各级失败留日志

## 已知问题 / 技术债

1. ~~`packages/im`、`packages/sync`、`packages/table` 缺少 `tsconfig.json`~~ **已修复（2026-07-09）**：三个包都已补上标准 `tsconfig.json`，typecheck 通过。
2. **`apps/desktop` 独立 `pnpm typecheck` 报 `@web/App` 找不到**（路径别名只在 Vite 构建时生效，`tsc --noEmit` 单独跑时未配置该别名）——现在是 `pnpm -r typecheck` 唯一剩余的失败项。
3. **`server` 默认 `JWT_SECRET` 是明文占位符**，生产部署必须显式覆盖，目前只在文档里提示，没有启动时的强校验/警告。
4. **主 JS bundle 体积较大**（~1.46MB，gzip ~480KB），Vite 已给出分包建议，尚未实施代码分割。
5. **群聊、加密文件传输（聊天里更大的文件）、多设备 Ratchet 同步优化**——按 `docs/PHASE1.md` Phase 2 预留，明确不在当前范围。
6. **Android 移动版（apps/mobile）当前覆盖解锁（含指纹）+ AI 助手 + 聊天**：无笔记/表格编辑；APK 构建依赖本机 Android Studio/SDK（仓库内未配 CI）；移动库与桌面库是各自设备独立的 IndexedDB（笔记无同步桥接，聊天/AI 会话经账号云同步）。

## Phase 2 候选（未开始）

- 群聊
- 聊天文件传输（超出当前 32MB WebSocket 单帧限制的场景，需要分片）
- 多设备间 Ratchet 状态同步
- TLS 证书固定、更完整的安全审计
