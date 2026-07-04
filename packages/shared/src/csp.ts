/**
 * Builds the strict Content-Security-Policy that locks the renderer down to
 * only ever reaching network origins the user explicitly configured (the
 * self-hosted FastNote server, for HTTP + WebSocket).
 *
 * IMPORTANT: browsers apply a `<meta http-equiv="Content-Security-Policy">`
 * exactly once, at HTML parse time. Modifying or re-inserting that meta tag
 * via JavaScript *after* the page has loaded has **no effect** on the policy
 * actually enforced by the browser — this is true even though the DOM node
 * itself updates fine. Because of this, the policy can't be "applied" from
 * React at runtime; it has to be computed and written into the document
 * synchronously while it is still being parsed. That bootstrap logic lives
 * in a small inline `<script>` at the very top of `index.html` (both
 * `apps/web/index.html` and `apps/desktop/index.html`) — it reads the
 * user's persisted server address straight out of `localStorage` (the same
 * `fastnote_server_url` key `packages/api` uses) and `document.write()`s the
 * meta tag before anything else loads. `buildContentSecurityPolicy` below is
 * the single source of truth for the policy string; keep the copy inlined
 * in both `index.html` files in sync with it by hand (it can't `import`
 * this module — nothing has loaded yet at that point).
 *
 * One consequence: changing the server address at runtime (Settings, or the
 * unlock screen's cloud-sync tab) cannot widen the already-applied policy.
 * `serverUrlNeedsReload` below detects this so the UI can prompt the user to
 * reload, which re-runs the bootstrap script against the freshly saved
 * value.
 */

function originsForServerUrl(serverUrl: string): string[] {
  try {
    const u = new URL(serverUrl);
    const httpOrigin = `${u.protocol}//${u.host}`;
    const wsProtocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsOrigin = `${wsProtocol}//${u.host}`;
    return [httpOrigin, wsOrigin];
  } catch {
    return [];
  }
}

export function buildContentSecurityPolicy(serverUrl: string): string {
  const connectSrc = ["'self'", ...originsForServerUrl(serverUrl)].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    // NOTE: intentionally no `frame-ancestors` here — it is silently ignored
    // by browsers when a CSP is delivered via <meta> (spec requirement), so
    // including it here would only produce a misleading console warning on
    // every page load. Real clickjacking protection for a self-hosted
    // deployment must come from an actual HTTP response header set by
    // whatever serves the built static assets (nginx/etc.), not from this
    // client-side policy.
  ].join('; ');
}

declare global {
  interface Window {
    /**
     * The server URL that was baked into the current page's CSP by the
     * inline bootstrap script in index.html, exposed so the app can tell
     * whether the *currently configured* server URL still matches what was
     * actually applied at load time.
     */
    __FASTNOTE_CSP_SERVER_URL__?: string;
  }
}

/**
 * Returns true if `serverUrl` differs from the origin that was actually
 * baked into the page's CSP at load time — i.e. a full reload is required
 * before the app can reach this server (see module doc comment above).
 */
export function serverUrlNeedsReload(serverUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  const applied = window.__FASTNOTE_CSP_SERVER_URL__;
  if (!applied) return false;
  try {
    return new URL(applied).origin !== new URL(serverUrl).origin;
  } catch {
    return applied !== serverUrl;
  }
}
