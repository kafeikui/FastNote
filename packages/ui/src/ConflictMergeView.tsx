import { useMemo, useRef, useState, type UIEvent } from 'react';
import DiffMatchPatch from 'diff-match-patch';
import type { NoteNode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

/**
 * Side-by-side merge view for a sync conflict copy: the canonical (server) note on the left,
 * the conflict copy (the local edits that lost the race) on the right, line-level diff
 * highlighting, plus an editable merge result that is written into the canonical note when the
 * user confirms — after which the copy is deleted.
 */
export interface ConflictMergeViewProps {
  /** The canonical note the copy diverged from; null when it has been deleted since. */
  canonical: NoteNode | null;
  copy: NoteNode;
  /** Writes `content` into the canonical note and deletes the copy. */
  onSaveMerged: (content: string) => void | Promise<void>;
  /** Deletes the copy without touching the canonical note. */
  onDeleteCopy: () => void | Promise<void>;
  /** Detaches the copy (clears `conflictOf`) so it lives on as a regular note. */
  onKeepCopy: () => void | Promise<void>;
  onClose: () => void;
}

type LineKind = 'same' | 'removed' | 'added' | 'pad';
interface DiffRow {
  kind: LineKind;
  text: string;
}

/**
 * Line-level diff rendered as two aligned columns: changed blocks are padded so the left and
 * right rows line up (a removed block on the left faces blank rows on the right and vice versa).
 */
function alignedLineDiff(left: string, right: string): { left: DiffRow[]; right: DiffRow[] } {
  const dmp = new DiffMatchPatch();
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(left, right);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  const outL: DiffRow[] = [];
  const outR: DiffRow[] = [];
  let pendingL: string[] = [];
  let pendingR: string[] = [];
  const splitLines = (text: string): string[] => {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const flush = () => {
    if (pendingL.length === 0 && pendingR.length === 0) return;
    const n = Math.max(pendingL.length, pendingR.length);
    for (let i = 0; i < n; i++) {
      outL.push(i < pendingL.length ? { kind: 'removed', text: pendingL[i] } : { kind: 'pad', text: '' });
      outR.push(i < pendingR.length ? { kind: 'added', text: pendingR[i] } : { kind: 'pad', text: '' });
    }
    pendingL = [];
    pendingR = [];
  };
  for (const [op, text] of diffs) {
    const lines = splitLines(text);
    if (op === 0) {
      flush();
      for (const line of lines) {
        outL.push({ kind: 'same', text: line });
        outR.push({ kind: 'same', text: line });
      }
    } else if (op === -1) {
      pendingL.push(...lines);
    } else {
      pendingR.push(...lines);
    }
  }
  flush();
  return { left: outL, right: outR };
}

export function ConflictMergeView({
  canonical,
  copy,
  onSaveMerged,
  onDeleteCopy,
  onKeepCopy,
  onClose,
}: ConflictMergeViewProps) {
  const t = useT();
  const canonicalText = canonical?.contentMd ?? '';
  const [result, setResult] = useState(canonicalText);
  const [busy, setBusy] = useState(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  const diff = useMemo(() => alignedLineDiff(canonicalText, copy.contentMd), [canonicalText, copy.contentMd]);
  const identical = canonicalText === copy.contentMd;

  // Keep the two columns scrolled together (rows are aligned, so same offset = same place).
  const syncScroll = (from: 'left' | 'right') => (e: UIEvent<HTMLDivElement>) => {
    if (syncingRef.current) return;
    const other = from === 'left' ? rightRef.current : leftRef.current;
    if (!other) return;
    syncingRef.current = true;
    other.scrollTop = e.currentTarget.scrollTop;
    other.scrollLeft = e.currentTarget.scrollLeft;
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  };

  const run = async (fn: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const renderRows = (rows: DiffRow[]) =>
    rows.map((row, i) => (
      <div key={i} className={`fn-conflict-line fn-conflict-line--${row.kind}`}>
        {row.text || '\u00a0'}
      </div>
    ));

  return (
    <div className="fn-modal-backdrop" onClick={onClose}>
      <div className="fn-modal fn-conflict-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('conflictMerge.title')}</h2>
        {canonical ? (
          <p className="fn-conflict-legend">
            {identical ? t('conflictMerge.identical') : t('conflictMerge.legend')}
            {copy.nodeType === 'table' && <> · {t('conflictMerge.tableHint')}</>}
          </p>
        ) : (
          <p className="fn-conflict-legend">{t('conflictMerge.bannerOriginalMissing')}</p>
        )}
        <div className="fn-conflict-panes">
          <div className="fn-conflict-pane">
            <div className="fn-conflict-pane__label">
              {t('conflictMerge.canonical')}
              {canonical && <span className="fn-conflict-pane__title">{canonical.title || t('common.untitled')}</span>}
            </div>
            <div className="fn-conflict-lines" ref={leftRef} onScroll={syncScroll('left')}>
              {renderRows(diff.left)}
            </div>
          </div>
          <div className="fn-conflict-pane">
            <div className="fn-conflict-pane__label">
              {t('conflictMerge.copy')}
              <span className="fn-conflict-pane__title">{copy.title || t('common.untitled')}</span>
            </div>
            <div className="fn-conflict-lines" ref={rightRef} onScroll={syncScroll('right')}>
              {renderRows(diff.right)}
            </div>
          </div>
        </div>
        {canonical && (
          <div className="fn-conflict-result">
            <div className="fn-conflict-result__bar">
              <span>{t('conflictMerge.result')}</span>
              <span className="fn-conflict-result__btns">
                <button type="button" onClick={() => setResult(canonicalText)} disabled={busy}>
                  {t('conflictMerge.useCanonical')}
                </button>
                <button type="button" onClick={() => setResult(copy.contentMd)} disabled={busy}>
                  {t('conflictMerge.useCopy')}
                </button>
              </span>
            </div>
            <textarea
              className="fn-conflict-result__text"
              value={result}
              onChange={(e) => setResult(e.target.value)}
              spellCheck={false}
              disabled={busy}
            />
          </div>
        )}
        <div className="fn-modal__actions fn-conflict-actions">
          {canonical && (
            <button type="button" className="primary" disabled={busy} onClick={() => void run(() => onSaveMerged(result))}>
              {t('conflictMerge.saveAndDelete')}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm(t('conflictMerge.deleteConfirm', { title: copy.title || t('common.untitled') }))) return;
              void run(onDeleteCopy);
            }}
          >
            {t('conflictMerge.deleteOnly')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run(onKeepCopy)}>
            {t('conflictMerge.keepAsNote')}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Banner shown above a note that has conflict copies, or above a conflict copy itself. */
export interface ConflictBannerProps {
  note: NoteNode;
  notes: NoteNode[];
  /** Opens the merge view for the given copy. */
  onCompare: (copyId: string) => void;
  /** Navigates to a note (used to jump from a copy to its original or vice versa). */
  onOpen?: (noteId: string) => void;
  onKeepCopy?: (copyId: string) => void;
}

export function ConflictBanner({ note, notes, onCompare, onOpen, onKeepCopy }: ConflictBannerProps) {
  const t = useT();
  if (note.conflictOf) {
    const original = notes.find((n) => n.id === note.conflictOf && !n.deleted && !n.trashed);
    return (
      <div className="fn-conflict-banner">
        <span>⚠ {original ? t('conflictMerge.bannerIsCopy') : t('conflictMerge.bannerOriginalMissing')}</span>
        <span className="fn-conflict-banner__btns">
          <button type="button" onClick={() => onCompare(note.id)}>
            {t('conflictMerge.compare')}
          </button>
          {onKeepCopy && (
            <button type="button" onClick={() => onKeepCopy(note.id)}>
              {t('conflictMerge.keepAsNote')}
            </button>
          )}
        </span>
      </div>
    );
  }
  const copies = notes.filter((n) => n.conflictOf === note.id && !n.deleted && !n.trashed);
  if (copies.length === 0) return null;
  return (
    <div className="fn-conflict-banner">
      <span>⚠ {t('conflictMerge.bannerHasCopies', { count: String(copies.length) })}</span>
      <span className="fn-conflict-banner__btns">
        {copies.map((c) => (
          <button key={c.id} type="button" onClick={() => onCompare(c.id)} title={c.title}>
            {t('conflictMerge.compare')}
            {copies.length > 1 ? ` (${c.title})` : ''}
          </button>
        ))}
        {onOpen && copies.length === 1 && (
          <button type="button" onClick={() => onOpen(copies[0].id)}>
            {t('conflictMerge.openCopy')}
          </button>
        )}
      </span>
    </div>
  );
}
