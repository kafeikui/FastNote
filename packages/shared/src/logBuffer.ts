/**
 * In-memory capture of console output, so users (especially on the packaged desktop app, where
 * DevTools aren't available) can inspect and export what the app logged — e.g. the
 * `[FastNote] unlock: ...` performance lines or background sync errors.
 *
 * Strictly local: entries live in a bounded ring buffer in memory and are only written anywhere
 * when the user explicitly copies/downloads them from the log viewer.
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ISO timestamp. */
  ts: string;
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 2000;

const entries: LogEntry[] = [];
let installed = false;

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function push(level: LogLevel, args: unknown[]): void {
  entries.push({
    ts: new Date().toISOString(),
    level,
    text: args.map(formatArg).join(' '),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/**
 * Wraps console.log/info/warn/error to also record into the buffer (original behavior is kept).
 * Also captures uncaught errors and unhandled promise rejections. Idempotent.
 */
export function installConsoleCapture(): void {
  if (installed || typeof console === 'undefined') return;
  installed = true;
  const levels: LogLevel[] = ['log', 'info', 'warn', 'error'];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      original(...args);
    };
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      push('error', [`Uncaught: ${e.message} (${e.filename}:${e.lineno})`]);
    });
    window.addEventListener('unhandledrejection', (e) => {
      push('error', [`Unhandled rejection: ${formatArg(e.reason)}`]);
    });
  }
}

export function getCapturedLogs(): readonly LogEntry[] {
  return entries;
}

export function clearCapturedLogs(): void {
  entries.length = 0;
}

/** Plain-text rendering for clipboard/file export. */
export function formatCapturedLogs(): string {
  return entries.map((e) => `${e.ts} [${e.level.toUpperCase()}] ${e.text}`).join('\n');
}
