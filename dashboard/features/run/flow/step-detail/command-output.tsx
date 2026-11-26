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
          {lines.map((line, index) => (
            // The lines of an output are only appended, so the number is their identity.
            <OutputRow
              key={index}
              number={index + 1}
              line={line}
              rowRef={index === firstError ? firstErrorRow : undefined}
            />
          ))}
        </>
      )}
    </Box>
  );
}
