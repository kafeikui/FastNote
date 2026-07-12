# FastNote

English | [简体中文](README.zh-CN.md)

Encrypted notes + 1:1 end-to-end encrypted instant messaging. Built for personal use or small trusted circles — zero-knowledge, self-hosted, no telemetry.

- **Local-first**: notes and chat history are encrypted and stored locally (IndexedDB) first; going online is only an optional sync/relay mechanism.
- **Zero-knowledge server**: the self-hosted relay only ever stores ciphertext and metadata that can't be reversed into plaintext. Forget your master password and your data is unrecoverable by design (strict mode, no backdoor, no recovery code).
- **No unexpected outbound traffic**: no telemetry/analytics/crash-reporting/auto-update libraries of any kind; every network request must go through the server address you configure yourself, enforced by a runtime CSP allowlist.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Protocol spec](docs/PROTOCOL.md)
- [Database schema](docs/DATABASE.md)
- [Phase 1 plan](docs/PHASE1.md)
- [Deployment guide](docs/DEPLOYMENT.md) (self-hosted relay: HTTPS + coexisting with nginx + certbot auto-renewal)
- [Vercel deployment](docs/VERCEL.md) (Web frontend only — the relay server can't run on Vercel, see why inside)
- [Memory Bank](memory-bank/) (persistent record of project background, current progress, and technical conventions — read this first if you're an AI assistant or a new contributor)

## Features

**Notes**
- Tree-structured explorer (folders/notes/tables), drag-to-reorder, nested directories
- Editor: Tiptap WYSIWYG (default) ↔ CodeMirror source mode, autosave
- Table documents: column sort/filter, add/remove rows & columns; a selection stats bar (count/sum/average) for any dragged range, whole row, or whole column; spreadsheet-style formulas (`=SUM(A1:A3)`, `AVERAGE`, `COUNT`, `MIN`, `MAX`, `+ - * / ^`); per-column number formats (number/currency/decimals) and one-click insert of the current time; multi-cell copy and smart paste-splitting with customizable delimiters (tab/semicolon/comma/whitespace, multi-select); Alt+Arrow to reorder rows/columns or swap adjacent cells; frozen header/first column, resizable rows/columns, per-cell bold/size/color/fill; export to CSV (plaintext) / `.fnxt` (encrypted), with matching import
- Bulk folder import: preserves directory structure, extension-less files import as notes, `.csv` files import as tables
- Local full-text search (encrypted index snapshot, never uploaded)
- Two-group tab system with split view: drag-to-reorder tabs, preview (italic) vs. pinned tabs, persisted across restarts and lock/unlock
- Optional LaTeX math rendering (KaTeX, off by default), line numbers, JSON formatting, line-level shortcuts (Ctrl+D delete line, Alt+↑/↓ move line)
- Customizable keyboard shortcuts (rename, lock, table repeat/undo/redo, delete, focus jumps) in Settings
- Edit-focus history: edits, opening/selecting tabs, and cursor clicks are all recorded; Ctrl+Alt+←/→ (customizable) jumps to the previous/next focus — the target tab is activated and pinned, and reopened if it was closed
- Fast unlock on large vaults (1000+ notes): hardware-accelerated WebCrypto AES-GCM, batched IndexedDB reads, background search-index loading
- Find & replace in notes (Ctrl+F, customizable): works in both rendered and source mode, with match highlighting and replace-all
- Resizable note content width; collapsible sidebar for a wider content area
- Multiple local vaults, switchable from the unlock screen
- Cross-vault transfer: copy or move notes/folders (attachments included) into another local vault after verifying its password

**AI Workbench (optional, off unless you configure it)**
- Chat with Claude models directly inside the app: bring your own Anthropic API key (encrypted with your master key, stored only in this vault)
- Collapsible session tree in the sidebar with folders, rename, and drag-to-organize; conversations are encrypted at rest like notes
- Streaming responses with markdown rendering (LaTeX formulas included) and a stop button; switching sessions or back to notes keeps the reply streaming in the background
- Attachments on requests: images / PDF / doc / docx / text files (all parsed locally, 8MB cap)
- Per-message management: delete, export as Markdown or a Word document; convert Q&A (a selected range or the whole session) into a note; send/receive timestamps on every message
- Configurable `max_tokens` (up to 128k) in Settings; long generations show thinking progress and a patience hint
- `api.anthropic.com` is the single CSP exception, and no request is ever made until you save a key and send a message

**Chat (1:1 end-to-end encrypted)**
- Chat history is kept locally forever (until manually deleted), independent of cloud login state
- Attachments (image preview, file download, editable/removable, deleting a received attachment requires confirmation)
- Session list + smart scroll (auto-follow when already at the bottom / floating "new message" indicator otherwise)
- Unread notifications: nav-bar red dot + per-session unread counts + configurable sound/volume/bubble toggle

**Interface**
- Four built-in UI themes (warm/elegant/business/fresh), with a consistent selected(dark)/unselected(light) visual language across the main UI and unlock screen
- i18n: Chinese and English, switchable anytime in Settings, persisted locally
- Tabbed Settings: General / Account & Sync / AI Assistant / Shortcuts / Storage
- Expired logins (401) are detected automatically: the local session is cleared and a banner prompts you to log in again, instead of showing a stale logged-in state
- Native desktop context menu: cut / copy / paste / paste-and-match-style / select all
- Built-in log viewer (📋 button next to Settings): captures console output in memory so you can inspect/copy/export it even in the packaged desktop app where DevTools aren't available — nothing is written to disk unless you export it yourself

**Security**
- The master password is only ever used to derive keys locally — it never leaves your device
- Full E2E: the server only ever sees ciphertext for both notes and chat
- Runtime CSP allowlist: only your configured server address can be reached; every other network destination (including ones introduced by dependencies) is blocked by the browser itself
- Electron hardening: `contextIsolation` on / `nodeIntegration` off, all system permission requests denied, in-app links always open in the system browser, `webview` disabled

## Quick start

```bash
# Install dependencies
corepack enable && pnpm install

# Web version (fastest way to try it out)
pnpm dev:web

# Electron desktop version
pnpm dev:desktop

# Self-hosted relay (in another terminal)
pnpm dev:server
```

### Verifying cloud sync

1. Start the relay: `pnpm dev:server`
2. In the web app, unlock a local vault → ⚙ Settings → set server to `http://localhost:8787`
3. Register/log in (requires your local password for verification)
4. Click "Sync now"; log into the same account from another browser to pull notes both ways

### Verifying chat

1. Settings → log into an account (this uploads your exchange public key)
2. Switch to "Chat" → enter the other user's username → start a chat
3. Messages are encrypted end-to-end via key exchange + AEAD; the relay only ever sees ciphertext

## Project layout

```
apps/web        — browser version (Vite + React)
apps/desktop    — Electron desktop version (macOS / Windows / Linux)
packages/*      — business logic shared between Web and Electron (crypto / storage / editor / im / sync / ui / i18n / …)
server/         — self-hosted relay (Fastify + WebSocket, ciphertext-only)
```

Web and Electron **share** `packages/*` — only the shell differs. The desktop build additionally exposes native capabilities (e.g. choosing a local data directory) through a `window.fastnote` IPC bridge.

## Building all three targets

```bash
pnpm build:web       # apps/web/dist               — static assets, deploy behind any static host + reverse proxy
pnpm build:desktop   # apps/desktop/dist(-electron) — Electron renderer + main process/preload output
pnpm build:server    # server/dist                  — compiled relay service

# or build every workspace package at once
pnpm build
```

### Desktop installers (run natively on each target platform)

```bash
pnpm dist:mac      # macOS dmg
pnpm dist:win      # Windows nsis
pnpm dist:linux    # Ubuntu: AppImage + deb
```

### Self-hosted relay deployment (HTTPS)

```bash
cd server
cp .env.example .env   # fill in JWT_SECRET (openssl rand -hex 32)
docker compose up -d   # binds to 127.0.0.1:8787 only, never exposed directly to the internet
```

For public deployment, the relay only listens on localhost; nginx handles TLS termination and reverse proxying on 443/80. The full walkthrough for "coexisting with your existing nginx sites + requesting/auto-renewing certificates with certbot" lives in the **[deployment guide](docs/DEPLOYMENT.md)**; a sample nginx site config is at `server/deploy/nginx/fastnote.conf` (a standalone file that doesn't touch your other site configs).

> ⚠️ **`JWT_SECRET` has no default value** — `docker-compose.yml` refuses to start if it's missing, to prevent a production deployment from accidentally using a placeholder that would let anyone forge login tokens.

### Web frontend on Vercel (optional, separate from the relay above)

The static `apps/web` build can also be hosted on Vercel instead of your own static host — a root-level `vercel.json` already wires up the pnpm monorepo build (`pnpm --filter @fastnote/web build` → `apps/web/dist`). See **[docs/VERCEL.md](docs/VERCEL.md)** for the full walkthrough and why the relay server itself can't run on Vercel (it needs long-lived WebSocket connections + real local-disk persistence, neither of which fits Vercel's stateless serverless/edge model).

### Desktop client releases (CI)

Pushing to the `publish` branch triggers `.github/workflows/release-desktop.yml`: parallel builds on macOS / Windows / Ubuntu runners producing dmg / nsis / AppImage+deb respectively, then bundled into a single GitHub Release (unsigned — on macOS, first launch requires "right-click → Open" to bypass Gatekeeper).

## Security notes

- The master password is only ever used to derive keys locally; it's never uploaded
- **Forgetting your password means your data cannot be recovered** (strict mode, by design)
- The server only ever sees ciphertext; both notes and chat are end-to-end encrypted
- The app is constrained at runtime by a CSP that only allows connecting to the server address you configure yourself; see [Memory Bank / techContext](memory-bank/techContext.md) for the full dependency audit
- `server/data/` (local relay runtime data during development) is in `.gitignore` and never committed

## Buy me a coffee ☕

If FastNote has been useful to you, feel free to buy the author a coffee — entirely optional and has no effect on any feature:

- **Crypto address (EVM-compatible — ETH / BNB / MATIC / USDT and other ERC-20/BEP-20 tokens, etc.)**:

  ```
  0x9bdb90629ee0967A97e7db89F44A32fe7a822117
  ```

  Please double-check the network (Ethereum / BNB Chain / Polygon / etc.) and token type before sending — sending on the wrong network can result in permanent loss of funds.

## License

[MIT](LICENSE) — feel free to audit the code, self-host it, and build on top of it.
