'use client';

import { type ReactElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

/** A text longer than this many lines is shown clamped to this many lines. */
const FOLD_LINES = 5;

/**
 * A text of at most five lines as it is; a longer one (more than five newline-separated lines, or a box that overflows
 * five lines once laid out) is clamped to five lines with a `Show all` / `Show less` button after it, outside what it
 * holds. `text` is what counts the lines and is drawn when there are no `children`; `children` draw the content.
 */
export function FoldedText({ text, children }: { text?: string; children?: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const long = overflows || (text !== undefined && text.split('\n').length > FOLD_LINES);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || open) {
      return undefined;
    }
    const measure = (): void => setOverflows(element.scrollHeight > element.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text, children]);
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        ref={box}
        sx={
          open
            ? undefined
            : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: FOLD_LINES, overflow: 'hidden' }
        }
      >
        {children ?? (
          <Box component="span" sx={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
            {text}
          </Box>
        )}
      </Box>
      {long ? (
        <Button size="small" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </Box>
  );
}
