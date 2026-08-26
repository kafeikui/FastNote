import { useMemo, useState } from 'react';
import { downloadBlob } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

export type ToolId = 'password' | 'base';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*-_+=';

/** Uniform random integers in [0, max) from the CSPRNG, rejection-sampled to avoid modulo bias. */
function randomInts(count: number, max: number): number[] {
  const out: number[] = [];
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(Math.max(count, 16));
  while (out.length < count) {
    crypto.getRandomValues(buf);
    for (const v of buf) {
      if (v < limit) {
        out.push(v % max);
        if (out.length === count) break;
      }
    }
  }
  return out;
}

/** Chrome password-manager style: mixed case + digits (+ symbols), each class guaranteed. */
function generatePassword(length: number, useSymbols: boolean): string {
  const pools = useSymbols ? [LOWER, UPPER, DIGITS, SYMBOLS] : [LOWER, UPPER, DIGITS];
  const all = pools.join('');
  const chars: string[] = pools.map((p) => p[randomInts(1, p.length)[0]]);
  for (const idx of randomInts(Math.max(length - pools.length, 0), all.length)) {
    chars.push(all[idx]);
  }
  // Fisher–Yates shuffle (crypto-driven) so the guaranteed class characters land anywhere.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInts(1, i + 1)[0];
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join('');
}

/** Strips the separators people paste along with big numbers (spaces, commas, underscores). */
function cleanNumberInput(raw: string): string {
  return raw.replace(/[\s,_]/g, '');
}

/** Clipboard write via hidden textarea + execCommand — the app's permissionless path
 *  (navigator.clipboard is rejected wholesale by the Electron permission policy). */
function copyText(text: string): boolean {
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
    prevFocus?.focus();
  }
  return ok;
}

function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="fn-tools__copy"
      disabled={!text}
      onClick={() => {
        if (!copyText(text)) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

function PasswordTool() {
  const t = useT();
  const [count, setCount] = useState('10');
  const [length, setLength] = useState('16');
  const [useSymbols, setUseSymbols] = useState(true);
  const [passwords, setPasswords] = useState<string[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleGenerate = () => {
    const n = Math.min(Math.max(Math.round(Number(count)) || 0, 1), 1000);
    const len = Math.min(Math.max(Math.round(Number(length)) || 0, 6), 128);
    setCount(String(n));
    setLength(String(len));
    setPasswords(Array.from({ length: n }, () => generatePassword(len, useSymbols)));
    setCopiedIdx(null);
  };

  const handleExport = () => {
    if (passwords.length === 0) return;
    const text = passwords.join('\n') + '\n';
    downloadBlob(
      `passwords-${formatTimestamp(new Date())}.txt`,
      new TextEncoder().encode(text),
      'text/plain',
    );
  };

  return (
    <section className="fn-tools__card">
      <h3>{t('toolsPanel.pwTitle')}</h3>
      <p className="fn-tools__hint">{t('toolsPanel.pwHint')}</p>
      <div className="fn-tools__row">
        <label>
          {t('toolsPanel.pwCount')}
          <input type="number" min={1} max={1000} value={count} onChange={(e) => setCount(e.target.value)} />
        </label>
        <label>
          {t('toolsPanel.pwLength')}
          <input type="number" min={6} max={128} value={length} onChange={(e) => setLength(e.target.value)} />
        </label>
        <label className="fn-tools__check">
          <input type="checkbox" checked={useSymbols} onChange={(e) => setUseSymbols(e.target.checked)} />
          {t('toolsPanel.pwSymbols')}
        </label>
        <button type="button" className="fn-tools__primary" onClick={handleGenerate}>
          {t('toolsPanel.pwGenerate')}
        </button>
      </div>
      {passwords.length > 0 && (
        <>
          <div className="fn-tools__row">
            <CopyButton
              text={passwords.join('\n')}
              label={t('toolsPanel.copyAll')}
              copiedLabel={t('toolsPanel.copied')}
            />
            <button type="button" onClick={handleExport}>
              {t('toolsPanel.pwExport')}
            </button>
          </div>
          <ol className="fn-tools__pwlist">
            {passwords.map((pw, i) => (
              <li key={i}>
                <code
                  title={t('toolsPanel.clickToCopy')}
                  onClick={() => {
                    if (!copyText(pw)) return;
                    setCopiedIdx(i);
                    setTimeout(() => setCopiedIdx((cur) => (cur === i ? null : cur)), 1200);
                  }}
                >
                  {pw}
                </code>
                {copiedIdx === i && <span className="fn-tools__copied-tag">{t('toolsPanel.copied')}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function BaseConvertTool() {
  const t = useT();
  const [mode, setMode] = useState<'dec' | 'hex'>('dec');
  const [input, setInput] = useState('');

  const result = useMemo(() => {
    const cleaned = cleanNumberInput(input);
    if (!cleaned) return null;
    try {
      let value: bigint;
      if (mode === 'dec') {
        if (!/^\d+$/.test(cleaned)) throw new Error('invalid');
        value = BigInt(cleaned);
      } else {
        const hex = cleaned.replace(/^0[xX]/, '');
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('invalid');
        value = BigInt(`0x${hex}`);
      }
      return {
        error: false as const,
        bits: value === 0n ? 1 : value.toString(2).length,
        binary: value.toString(2),
        decimal: value.toString(10),
        hex: value.toString(16).toUpperCase(),
      };
    } catch {
      return { error: true as const };
    }
  }, [input, mode]);

  const outputs: Array<{ key: string; label: string; text: string }> =
    result && !result.error
      ? [
          { key: 'bin', label: t('toolsPanel.baseBinary'), text: result.binary },
          ...(mode === 'dec'
            ? [{ key: 'hex', label: t('toolsPanel.baseHex'), text: result.hex }]
            : [{ key: 'dec', label: t('toolsPanel.baseDecimal'), text: result.decimal }]),
        ]
      : [];

  return (
    <section className="fn-tools__card">
      <h3>{t('toolsPanel.baseTitle')}</h3>
      <p className="fn-tools__hint">{t('toolsPanel.baseHint')}</p>
      <div className="fn-tools__row">
        <label>
          {t('toolsPanel.baseMode')}
          <select value={mode} onChange={(e) => setMode(e.target.value as 'dec' | 'hex')}>
            <option value="dec">{t('toolsPanel.baseModeDec')}</option>
            <option value="hex">{t('toolsPanel.baseModeHex')}</option>
          </select>
        </label>
      </div>
      <textarea
        className="fn-tools__input"
        rows={3}
        spellCheck={false}
        placeholder={mode === 'dec' ? t('toolsPanel.baseDecPlaceholder') : t('toolsPanel.baseHexPlaceholder')}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {result?.error && <p className="fn-tools__error">{t('toolsPanel.baseInvalid')}</p>}
      {result && !result.error && (
        <>
          <p className="fn-tools__hint">{t('toolsPanel.baseBits', { bits: result.bits })}</p>
          {outputs.map((o) => (
            <div key={o.key} className="fn-tools__output">
              <div className="fn-tools__output-head">
                <span>{o.label}</span>
                <CopyButton text={o.text} label={t('toolsPanel.copy')} copiedLabel={t('toolsPanel.copied')} />
              </div>
              <textarea readOnly rows={3} spellCheck={false} value={o.text} />
            </div>
          ))}
        </>
      )}
    </section>
  );
}

export function ToolsSidebar({
  active,
  onSelect,
}: {
  active: ToolId;
  onSelect: (id: ToolId) => void;
}) {
  const t = useT();
  const items: Array<{ id: ToolId; label: string }> = [
    { id: 'password', label: t('toolsPanel.pwTitle') },
    { id: 'base', label: t('toolsPanel.baseTitle') },
  ];
  return (
    <ul className="fn-tools-sidebar">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={active === item.id ? 'active' : ''}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ToolsPanel({ tool }: { tool: ToolId }) {
  return (
    <div className="fn-tools">{tool === 'password' ? <PasswordTool /> : <BaseConvertTool />}</div>
  );
}
