'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import type { ReactElement, RefObject } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import type { CheckCommandView } from '@contract/api';
import { useLiveBridge } from '../../../shell';
import { useCommandLog } from '../../use-command-log';

/** A line that reports an error. */
const ERROR_LINE = /\berror\b|\bFAIL\b|\bfailed\b|ERR!|✕|×/;

/** The lines of an output, without the empty one a closing newline leaves. */
function linesOf(text: string): string[] {
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

/** The most rows one output draws: a longer output shows a window of this many lines, with what is left out said. */
const MAX_ROWS = 2000;

/** The lines to draw: the last MAX_ROWS, or the MAX_ROWS from the first error line when that one is earlier. */
function windowOf(count: number, firstError: number): { start: number; end: number } {
  const start = firstError >= 0 ? Math.min(firstError, Math.max(0, count - MAX_ROWS)) : Math.max(0, count - MAX_ROWS);
  return { start, end: Math.min(count, start + MAX_ROWS) };
}

/** One line with its number in the gutter. It draws again only when its own line changes. */
const OutputRow = memo(function OutputRow({
  number,
  line,
  rowRef,
}: {
  number: number;
  line: string;
  rowRef?: RefObject<HTMLDivElement | null>;
}): ReactElement {
  return (
    <Box ref={rowRef} sx={{ display: 'grid', gridTemplateColumns: 'minmax(2.5ch, auto) 1fr', columnGap: 1.5 }}>
      <Box component="span" aria-hidden sx={{ userSelect: 'none', textAlign: 'right', color: 'text.disabled' }}>
        {number}
      </Box>
      <Box
        component="span"
        sx={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          color: ERROR_LINE.test(line) ? 'error.main' : undefined,
        }}
      >
        {line}
      </Box>
    </Box>
  );
});

/** What the window leaves out, in words. */
function leftOut(count: number, where: 'earlier' | 'later'): ReactElement | null {
  return count > 0 ? (
    <Box sx={{ color: 'text.secondary' }}>
      {count} {where} lines not shown; the whole output is in the stored log of this command
    </Box>
  ) : null;
}

/** The output of one check command, a row per line with its number. A failed command opens at its first error line. */
export function CommandOutput({ runKey, command }: { runKey: string; command: CheckCommandView }): ReactElement {
  const live = useLiveBridge((snapshot) =>
    snapshot.logs.find((entry) => entry.key === runKey && entry.step === 'checks' && entry.command === command.index),
  );
  const stored = useCommandLog(runKey, command, true);
  const text = command.status === 'running' || command.status === 'waiting' ? (live?.body ?? stored) : stored;
  const neverRan = command.status === 'waiting' || command.status === 'skipped';
  const lines = useMemo(() => (text ? linesOf(text) : []), [text]);
  const failed = command.status === 'failed';
  const firstError = useMemo(() => (failed ? lines.findIndex((line) => ERROR_LINE.test(line)) : -1), [failed, lines]);
  const { start, end } = windowOf(lines.length, firstError);
  const box = useRef<HTMLDivElement | null>(null);
  const firstErrorRow = useRef<HTMLDivElement | null>(null);
  const opened = useRef(false);
  const settled = typeof stored === 'string';

  const showFirstError = () => {
    if (box.current && firstErrorRow.current) {
      box.current.scrollTop = firstErrorRow.current.offsetTop;
    }
  };

  useEffect(() => {
    if (settled && firstErrorRow.current && !opened.current) {
      opened.current = true;
      showFirstError();
    }
  }, [settled, firstError]);

  return (
    <Box
      ref={box}
      role="group"
      aria-label={`Output of ${command.command}`}
      sx={{
        position: 'relative',
        m: 0,
        p: 1,
        maxHeight: 420,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
      }}
    >
      {firstError >= 0 ? (
        <Link
          component="button"
          type="button"
          onClick={showFirstError}
          sx={{ mb: 0.5, fontSize: 12, color: 'error.main' }}
        >
          first error
        </Link>
      ) : null}
      {text === undefined || text === null || lines.length === 0 ? (
        <Box>{text ?? (text === null || neverRan ? 'no output: it did not run' : 'loading')}</Box>
      ) : (
        <>
          {leftOut(start, 'earlier')}
          {lines.slice(start, end).map((line, offset) => (
            // The lines of an output are only appended, so the number is their identity.
            <OutputRow
              key={start + offset}
              number={start + offset + 1}
              line={line}
              rowRef={start + offset === firstError ? firstErrorRow : undefined}
            />
          ))}
          {leftOut(lines.length - end, 'later')}
        </>
      )}
    </Box>
  );
}
