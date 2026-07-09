# Tech Context — FastNote

## 运行环境

- Node.js `>=20`，包管理器固定为 `pnpm@9.15.0`（`packageManager` 字段锁定，用 `corepack enable` 启用）。
- Monorepo：`pnpm-workspace.yaml`，各 `packages/*` 通过 `workspace:*` 互相引用。
- TypeScript 严格模式，各包各自 `tsconfig.json` 继承根 `tsconfig.base.json`。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端框架 | React 19 |
| 构建工具 | Vite 6 |
| 桌面壳 | Electron 36 + electron-builder 25（`contextIsolation: true`, `nodeIntegration: false`） |
| 富文本编辑 | Tiptap 3（WYSIWYG，底层 Markdown）+ `@tiptap/markdown` |
| 源码模式编辑 | CodeMirror 6（`@codemirror/lang-markdown`） |
| 加密原语 | `@noble/ciphers` / `@noble/curves` / `@noble/hashes`（paulmillr 维护，纯 JS、经审计）；2026-07-09 起笔记/快照的批量加解密热路径改用 **WebCrypto 原生 AES-GCM**（`encryptNative`/`decryptNative`，与 noble 线格式完全兼容），noble 保留用于同步链路与非热路径 |
| 本地存储 | `idb`（IndexedDB 封装），Web 和 Electron 共用 |
| 全文搜索 | `minisearch`（内存索引 + 加密快照持久化） |
| 国际化 | 自研 `packages/i18n`（无第三方 i18n 库），当前支持中文/英文 |
| 服务端 | Fastify 5 + `@fastify/websocket` + `@fastify/cors` |
| 服务端鉴权 | `jsonwebtoken`（JWT，仅含 user_id/device_id，不含密钥material） |
| 服务端持久化 | 自研 `JsonRelayStore`（JSON 文件），`sql.js` 仅用于历史数据迁移 |

## 依赖清单核查（隐私/安全审计要点）

代码库已做过全量依赖审计（见对话历史）：
- 无遥测/统计/崩溃上报类库（sentry / posthog / mixpanel / amplitude / bugsnag / firebase 等，全仓搜索均为 0 命中）。
- 无自动更新逻辑（`electron-updater` / `autoUpdater` 未使用；`electron-builder` 配置里没有 `publish` 字段，只用于本机手动打包）。
- 所有 `fetch()` / `WebSocket` 调用都经过用户在设置里配置的单一 `serverUrl`（`packages/api`、`packages/im`），没有硬编码的第三方域名。
- 每次新增依赖后，建议重新跑一遍上述检查（关键词搜索 + `pnpm why <pkg>` 确认引入路径）。

## 项目结构与命令

```bash
corepack enable && pnpm install

pnpm dev:web        # apps/web ，Vite dev server
pnpm dev:desktop    # apps/desktop ，Electron + Vite
pnpm dev:server     # server/ ，Fastify 中继（本地默认 http://localhost:8787）

pnpm build          # 全仓构建（pnpm -r build）
pnpm build:web
pnpm build:desktop
pnpm dist:mac / dist:win / dist:linux   # electron-builder 打包安装包
pnpm typecheck      # 全仓 tsc --noEmit（im/sync/table 的 tsconfig 已于 2026-07-09 补齐；唯一剩余失败项是 apps/desktop 的 @web/App 别名，见下方已知限制）
```

## 新增包时的依赖接入方式（以 `packages/i18n` 为例）

`packages/i18n` 是 2026-07 新增的包，接入方式是后续新增内部包的参考模板：

1. 新建 `packages/<name>/package.json`（`name: "@fastnote/<name>"`）+ `tsconfig.json`（`extends: "../../tsconfig.base.json"`）+ `src/index.ts`。
2. 需要使用它的包（`ui`/`app`/`editor`/`table`/`api`）在各自 `package.json` 的 `dependencies` 里加 `"@fastnote/<name>": "workspace:*"`。
3. 根目录跑一次 `pnpm install`，让 pnpm workspace 重新建立符号链接（否则会报 `Cannot find module '@fastnote/<name>'`）。
4. 跑 `pnpm typecheck` / `pnpm build` 全仓验证。

## 已知的技术约束/限制

- ~~`packages/im`、`packages/sync`、`packages/table` 缺少独立的 `tsconfig.json`~~ **已修复（2026-07-09）**：三个包均已补上与其它 `packages/*` 一致的标准 `tsconfig.json`（extends `../../tsconfig.base.json` + `outDir`/`rootDir`/`include: ["src"]`），typecheck 全部通过。
- **`apps/desktop` 的 `pnpm typecheck` 单独报 `@web/App` 模块找不到**：`apps/desktop/src/main.tsx` 里用了路径别名 `@web/App`，但独立跑 `tsc --noEmit` 时该别名未被解析（`vite build` 走 Vite 自己的别名配置，不受影响，实际构建产物正常）。同样是遗留的 typecheck 配置问题，不影响运行时。
- **`server` 默认 `JWT_SECRET = 'dev-secret-change-me'`**：本地开发方便，但**生产自托管部署必须显式设置 `JWT_SECRET` 环境变量**，否则任何人都能伪造 token。README/部署文档需要反复强调这一点。
- **单文件体积告警**：`apps/web`/`apps/desktop` 构建后主 JS chunk ~1.46MB（gzip ~480KB），Vite 会给出"chunk 超过 500KB"的警告。目前未做代码分割，纯前端应用可接受，但如果后续加更多功能建议引入 `manualChunks` 或路由级动态 import。
- **`.npmrc` 里配置了本机代理**（Clash，`127.0.0.1:7890`），纯开发者本地环境相关，已加入 `.gitignore`，其它协作者/CI 环境需要自己维护一份（如果需要科学上网访问 npm registry）。

## 构建产物 / 分发目标

| 平台 | 产物 | 工具 |
|------|------|------|
| Web | 静态资源（`apps/web/dist`），可用任意静态托管 + 反向代理部署 | `vite build` |
| macOS 桌面版 | `.dmg` | `electron-builder --mac` |
| Windows 桌面版 | `.exe`（NSIS 安装包） | `electron-builder --win` |
| Linux 桌面版 | `AppImage` + `.deb` | `electron-builder --linux` |
| 自托管中继服务 | Docker 镜像（`server/Dockerfile` + `docker-compose.yml`） | `docker compose up -d` |

三端（Web / Electron 桌面 / 自托管服务端）共享同一个 monorepo，`packages/*` 是 Web 和 Electron 的公共业务逻辑层；`server/` 是独立的 Node 服务，不与前端共享代码，只通过 `docs/PROTOCOL.md` 定义的 HTTP/WebSocket 契约交互。

## 生产部署（HTTPS + nginx 共存 + certbot）

详见 `docs/DEPLOYMENT.md`。要点：

- `server/docker-compose.yml` 把中继端口绑定为 `127.0.0.1:8787:8787`——只有本机（即 nginx）能连到它，不直接暴露公网。
- `server/.env.example` → 拷贝为 `server/.env` 并填入随机 `JWT_SECRET`；`docker-compose.yml` 用 `${JWT_SECRET:?...}` 语法强制要求这个变量存在，缺失时直接拒绝启动，防止生产环境用了占位符。
- `server/deploy/nginx/fastnote.conf` 是**独立的** nginx 站点配置（用 `server_name` 区分，不修改任何已有站点的配置文件），HTTP 80 端口只处理 certbot 的 webroot 校验并重定向到 HTTPS，443 端口反代到 `127.0.0.1:8787`（含 `/ws/v1` 的 WebSocket Upgrade 头和长超时）。
- 证书用 `certbot certonly --webroot`（不用 `--nginx` 插件，避免它扫描/改写其它站点的配置），续期用 certbot 自带的定时任务 + 一个全局 `renewal-hooks/deploy/reload-nginx.sh` 钩子（reload nginx，对这台机器上所有域名的证书都生效，不是 FastNote 专属）。

## CI/CD：桌面客户端发布

`.github/workflows/release-desktop.yml`：push 到 `publish` 分支触发，三个平台并行构建：

| Job (matrix) | Runner | 产物 |
|---|---|---|
| mac | `macos-latest` | `.dmg`（`--universal`，同时兼容 Intel/Apple Silicon；未做代码签名，`CSC_IDENTITY_AUTO_DISCOVERY=false`） |
| win | `windows-latest` | `.exe`（NSIS） |
| linux | `ubuntu-latest` | `.AppImage` + `.deb` |

三个 job 各自 `pnpm --filter @fastnote/desktop build`（渲染层 + Electron 主进程/preload）后跑 `electron-builder`，产物用 `actions/upload-artifact` 上传；最后一个 `release` job 下载全部三份 artifact，用 `softprops/action-gh-release` 汇总发布成一个 GitHub Release（tag 形如 `desktop-v<version>-<run_number>`，版本号取自 `apps/desktop/package.json`）。

**未配置签名/公证**：macOS 产物未签名未公证，用户首次打开需要"右键 → 打开"绕过 Gatekeeper；如果后续要接入 Apple Developer 证书签名+公证，需要把证书/App-specific password 存进 repo secrets 并调整这个 workflow（当前未做，因为没有对应的开发者账号凭证）。
