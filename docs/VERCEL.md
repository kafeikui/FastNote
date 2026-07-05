# Web 前端部署到 Vercel

> 本文档只涉及 **`apps/web`（静态前端）** 部署到 Vercel。自托管中继服务器（`server/`，Fastify + WebSocket + 本地 JSON 文件持久化）**不能**部署到 Vercel——它需要长连接 WebSocket 和真正的本地磁盘持久化，这与 Vercel Serverless/Edge Functions 的无状态、短生命周期模型不兼容。中继服务器请继续按 `docs/DEPLOYMENT.md` 部署到你自己的 VPS（Docker + nginx + certbot）。两者是完全独立、通过 CORS/HTTPS 互相访问的两个服务，互不依赖对方的部署方式。

```
浏览器
  │
  ├─ 静态资源（HTML/JS/CSS） ←── Vercel（apps/web，本文档）
  │
  └─ /api/v1/*、/ws/v1  ←────── 你自己的中继服务器（docs/DEPLOYMENT.md，独立域名，如 fastnote-api.example.com）
```

前端在浏览器里对哪个服务器发请求，完全由用户在 **设置 → 服务器地址** 里自己填写并保存在本地 `localStorage`（`fastnote_server_url`），Vercel 只负责把这个静态页面本身发出去，不参与、也看不到用户填的地址或任何数据。

## 0. 前提

- 中继服务器已经按 `docs/DEPLOYMENT.md` 部署好，能通过 `https://你的中继域名/health` 访问（**必须是 HTTPS**——Vercel 域名本身是 HTTPS，浏览器会阻止从 HTTPS 页面向 HTTP 地址发起请求/建立 WebSocket，mixed-content 会被直接拦截）。
- 服务器端 CORS 已经是完全开放的（`server/src/index.ts` 里 `@fastify/cors` 注册为 `{ origin: true }`），因此 Vercel 域名（例如 `https://fastnote.vercel.app` 或你绑定的自定义域名）作为一个和中继服务器不同的 origin 直接跨域访问是可以的，**不需要**额外配置服务器端 CORS 白名单。
- 仓库根目录已有 `vercel.json`（本次新增），做了 pnpm monorepo 的构建适配，见下方"配置说明"。

## 1. 在 Vercel 里新建项目

1. Vercel Dashboard → **Add New → Project** → 选择这个 GitHub 仓库并导入。
2. **Root Directory 保持默认（仓库根目录）**，不要改成 `apps/web`——因为 `vercel.json` 里已经用 `installCommand`/`buildCommand`/`outputDirectory` 显式指定了 pnpm workspace 的构建方式，如果把 Root Directory 改成 `apps/web` 子目录，反而会让 Vercel 找不到仓库根的 `pnpm-workspace.yaml`，导致 workspace 包（`@fastnote/shared`、`@fastnote/storage` 等）解析失败。
3. Framework Preset 选 **Other**（因为构建命令已经在 `vercel.json` 里手工指定，不需要 Vercel 的 Vite 自动检测）。
4. Build & Development Settings 里的 Install/Build/Output 三项会被 `vercel.json` 覆盖，保持面板里对应输入框为空即可（如果之前手动填过，清空以避免和 `vercel.json` 冲突）。
5. 环境变量：**不需要设置任何环境变量**。服务器地址是运行时从浏览器 `localStorage` 读取的，不是构建期注入的；参见下方"首次访问的服务器地址"。
6. 点 **Deploy**。首次构建大概 1–2 分钟（`pnpm install` + `tsc -b` + `vite build`）。

## 2. `vercel.json` 配置说明

```json
{
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm --filter @fastnote/web build",
  "outputDirectory": "apps/web/dist",
  "cleanUrls": true,
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

- `installCommand`：在仓库根目录执行 `pnpm install`，这样 `pnpm-workspace.yaml` 里列出的所有 workspace 包（`apps/*`、`packages/*`、`server`）都会被正确 symlink 进各自的 `node_modules`——这是 monorepo 里 `apps/web` 能 `import '@fastnote/shared'` 之类的前提。`--frozen-lockfile` 确保线上构建严格使用仓库里提交的 `pnpm-lock.yaml`，不会因为 CI 环境解析出不同的依赖版本而产生"本地能跑、线上不能跑"的偏差。
- `buildCommand`：只构建 `@fastnote/web` 这一个包（`pnpm --filter` 只运行该包自己的 `build` 脚本，即 `tsc -b && vite build`）。其余 workspace 包（`shared`/`crypto`/`storage`/`ui`/…）**不需要单独构建**——它们的 `package.json` 里 `"main"/"types"` 直接指向 `./src/index.ts`，Vite 在打包 `apps/web` 时会直接读取、编译这些包的 TypeScript 源码，不存在"先构建依赖包产物、再被下游引用"的两段式流程。
- `outputDirectory`：Vite 的产物在 `apps/web/dist`（相对仓库根目录，因为我们没有改 Root Directory）。
- `rewrites`：当前这个应用没有客户端路由（没有 react-router，纯单页应用），理论上不需要；保留这条只是为了给未来可能加的路由留后路，不影响现状。
- 没有配置任何自定义 HTTP 响应头——这个应用的 CSP 是运行时由 `apps/web/index.html` 顶部的内联脚本读取 `localStorage` 后用 `document.write()` 写入 `<meta>` 标签生成的（见 `docs/ARCHITECTURE.md` "CSP" 一节），不是通过 HTTP 头下发的，所以 Vercel 侧不需要额外的 header 配置。

## 3. 首次访问的服务器地址

新用户第一次打开 Vercel 部署的页面时，`localStorage` 里还没有 `fastnote_server_url`，会使用代码里的默认值 `http://localhost:8787`（这在纯浏览器环境里显然连不上，属预期——本来就需要用户告诉前端"该连哪个中继服务器"）。用户需要：

1. 打开页面 → ⚙ 设置 → "服务器地址" 里填自己的中继服务器地址（`https://你的中继域名`）→ 保存。
2. 保存后前端会据此重新计算 CSP `connect-src` 并提示刷新页面（`serverUrlNeedsReload`），刷新一次即可。
3. 之后这个地址会持久化在浏览器本地，下次打开不用重填。

如果你只给自己/小圈子用，且始终连同一个固定的中继服务器，可以考虑后续给 `apps/web/index.html` 的引导脚本和 `packages/api` 的 `loadServerUrl()` 默认值都改成你自己的域名（两处必须保持一致，见 `apps/web/index.html` 里的注释），省去每个新用户手动填一次的步骤——这属于可选的体验优化，本次未改动默认值，保持"localhost 兜底、用户自己填"的通用行为。

## 4. 自定义域名 + HTTPS

Vercel 项目自带 `*.vercel.app` 子域名和自动 HTTPS（Let's Encrypt，自动续期，不需要像中继服务器那样手动跑 certbot）。如果要挂自己的域名：Vercel 项目 → Settings → Domains → 添加域名 → 按提示在你的 DNS 服务商那边加一条 `CNAME`（或 `A` 记录，取决于是否是根域名）即可，证书由 Vercel 自动签发。

## 5. 更新/回滚

- Vercel 默认对接 Git：推送到默认分支（通常是 `main`）会自动触发一次新的生产部署；其它分支/PR 会各自得到一个独立的 Preview 部署地址，方便先测试再合并。
- 出问题时可以在 Vercel Dashboard → Deployments 列表里对任意一次历史成功部署点 **Promote to Production** 做即时回滚，不需要重新 `git revert` 再等一次构建。

## 6. 与桌面版/自托管中继的关系

- 三个客户端形态（Web / macOS / Windows / Ubuntu 桌面版）共享同一套 `packages/*` 业务逻辑，只是壳不同；本文档只影响 Web 版的**托管方式**，不影响桌面版（桌面版继续按 `.github/workflows/release-desktop.yml` 构建、按 `README.md` 的方式分发安装包）。
- 中继服务器（笔记/附件/聊天同步的对端）完全独立于前端托管在哪里；同一个中继服务器可以同时被"本地 `pnpm dev:web`""Vercel 上的 Web 版""桌面版"这三种前端形态共用——用户在任意一个客户端的设置里填同一个服务器地址即可让它们互相同步。
