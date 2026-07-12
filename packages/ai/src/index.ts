/**
 * Direct browser client for the Anthropic Messages API.
 *
 * This is the ONLY module in the codebase that talks to a third-party network
 * origin (https://api.anthropic.com). It is exclusively used by the opt-in AI
 * Workbench feature: no request is ever made unless the user has explicitly
 * saved an Anthropic API key in this vault's settings. The origin is
 * allow-listed in the CSP (packages/shared/src/csp.ts + both index.html
 * bootstrap scripts).
 */

import { AI_MAX_TOKENS_DEFAULT } from '@fastnote/shared';

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
const MESSAGES_URL = `${ANTHROPIC_API_ORIGIN}/v1/messages`;
const ANTHROPIC_VERSION = '2023-06-01';

/** Multimodal content blocks understood by the Messages API. */
export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string | AiContentBlock[];
}

export * from './attachments';

export interface ClaudeModelInfo {
  id: string;
  label: string;
}

/** Built-in model choices; users can also type a custom model ID in settings. */
export const CLAUDE_MODELS: ClaudeModelInfo[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0].id;

/**
 * Generous output budget: reasoning models spend part of it on (invisible) thinking blocks
 * before any visible text — 4096 proved too small for hard analytical prompts, where the
 * whole budget was consumed by thinking and the reply came back empty. Users can override
 * per vault in settings (up to AI_MAX_TOKENS_LIMIT).
 */
const DEFAULT_MAX_TOKENS = AI_MAX_TOKENS_DEFAULT;

export interface StreamMessageOptions {
  model: string;
  messages: AiChatMessage[];
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called for each streamed visible-text fragment as it arrives. */
  onDelta: (text: string) => void;
  /** Called as the model's (hidden) thinking grows, with the total thinking characters so far. */
  onThinking?: (totalChars: number) => void;
}

export interface StreamMessageResult {
  text: string;
  /** Anthropic stop_reason from the final message_delta (e.g. 'end_turn', 'max_tokens'), if seen. */
  stopReason: string | null;
  /** Total characters of hidden thinking emitted by the model. */
  thinkingChars: number;
}

export class AnthropicApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AnthropicApiError';
  }
}

/**
 * Thrown when the request stalls: 'connect' = no HTTP response within the connect window
 * (typical when api.anthropic.com is unreachable — e.g. mainland China without a proxy),
 * 'stream' = the SSE stream went silent mid-reply.
 */
export class AnthropicTimeoutError extends Error {
  constructor(public phase: 'connect' | 'stream') {
    super(`anthropic ${phase} timeout`);
    this.name = 'AnthropicTimeoutError';
  }
}

/** No response headers within this window → connect timeout. */
const CONNECT_TIMEOUT_MS = 30_000;
/** No new stream bytes within this window mid-reply → stream timeout. */
const IDLE_TIMEOUT_MS = 90_000;

export class AnthropicClient {
  constructor(private readonly apiKey: string) {}

  /**
   * Sends a conversation to the Messages API with SSE streaming and resolves
   * with the full assistant reply once the stream ends.
   */
  async streamMessage(opts: StreamMessageOptions): Promise<StreamMessageResult> {
    // Watchdog: the browser fetch has no built-in timeout, so an unreachable host would hang
    // forever showing "thinking…". We abort ourselves and rethrow a typed timeout error.
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onOuterAbort);
    let timedOutPhase: 'connect' | 'stream' | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = (phase: 'connect' | 'stream', ms: number) => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOutPhase = phase;
        ac.abort();
      }, ms);
    };
    const t0 = performance.now();
    const elapsed = () => `${Math.round(performance.now() - t0)}ms`;

    try {
      console.info(`[FastNote] ai: request start model=${opts.model} messages=${opts.messages.length}`);
      armWatchdog('connect', CONNECT_TIMEOUT_MS);
      const res = await fetch(MESSAGES_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          // Required opt-in header for calling the API from a browser context.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: opts.system,
          messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });
      console.info(`[FastNote] ai: response headers status=${res.status} after ${elapsed()}`);

      if (!res.ok || !res.body) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) detail = body.error.message;
        } catch {
          // Non-JSON error body; keep the HTTP status as the message.
        }
        throw new AnthropicApiError(res.status, detail);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      let thinkingChars = 0;
      let stopReason: string | null = null;
      let firstByteLogged = false;

      const handleData = (data: string) => {
        if (!data || data === '[DONE]') return;
        let event: {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
          error?: { message?: string };
        };
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (event.type === 'error') {
          throw new AnthropicApiError(0, event.error?.message ?? 'stream error');
        }
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            full += event.delta.text;
            opts.onDelta(event.delta.text);
          } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            // Reasoning models emit hidden thinking before visible text; report progress so
            // the UI can show that the model is working rather than a static "thinking…".
            thinkingChars += event.delta.thinking.length;
            opts.onThinking?.(thinkingChars);
          }
        }
        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        }
      };

      for (;;) {
        armWatchdog('stream', IDLE_TIMEOUT_MS);
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstByteLogged) {
          firstByteLogged = true;
          console.info(`[FastNote] ai: first stream bytes after ${elapsed()}`);
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) handleData(trimmed.slice(5).trim());
        }
      }
      const rest = buffer.trim();
      if (rest.startsWith('data:')) handleData(rest.slice(5).trim());

      console.info(
        `[FastNote] ai: done, ${full.length} chars (thinking ${thinkingChars} chars, stop_reason=${stopReason ?? 'n/a'}) in ${elapsed()}`,
      );
      return { text: full, stopReason, thinkingChars };
    } catch (err) {
      // Our own watchdog abort → typed timeout (unless the caller aborted first).
      if (timedOutPhase && !opts.signal?.aborted) {
        console.warn(`[FastNote] ai: ${timedOutPhase} timeout after ${elapsed()}`);
        throw new AnthropicTimeoutError(timedOutPhase);
      }
      if (!opts.signal?.aborted) {
        console.warn(`[FastNote] ai: request failed after ${elapsed()}`, err);
      }
      throw err;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
