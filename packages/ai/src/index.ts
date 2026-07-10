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

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
const MESSAGES_URL = `${ANTHROPIC_API_ORIGIN}/v1/messages`;
const ANTHROPIC_VERSION = '2023-06-01';

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeModelInfo {
  id: string;
  label: string;
}

/** Built-in model choices; users can also type a custom model ID in settings. */
export const CLAUDE_MODELS: ClaudeModelInfo[] = [
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0].id;

export interface StreamMessageOptions {
  model: string;
  messages: AiChatMessage[];
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called for each streamed text fragment as it arrives. */
  onDelta: (text: string) => void;
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

export class AnthropicClient {
  constructor(private readonly apiKey: string) {}

  /**
   * Sends a conversation to the Messages API with SSE streaming and resolves
   * with the full assistant reply once the stream ends.
   */
  async streamMessage(opts: StreamMessageOptions): Promise<string> {
    const res = await fetch(MESSAGES_URL, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // Required opt-in header for calling the API from a browser context.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

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

    const handleData = (data: string) => {
      if (!data || data === '[DONE]') return;
      let event: {
        type?: string;
        delta?: { type?: string; text?: string };
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
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        full += event.delta.text;
        opts.onDelta(event.delta.text);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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

    return full;
  }
}
