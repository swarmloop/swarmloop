'use client';

import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import Typography from '@mui/material/Typography';

/** The quiet row after the last run of a part with more to load; it asks for the next page when it scrolls into view. */
export function LoadMoreRow({ onLoadMore }: { onLoadMore: () => void }): ReactElement {
  const row = useRef<HTMLDivElement>(null);
  const load = useRef(onLoadMore);
  load.current = onLoadMore;
  useEffect(() => {
    const element = row.current;
    if (!element) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        load.current();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <Typography ref={row} variant="body2" color="text.secondary" component="div" sx={{ px: 2, py: 1.5 }}>
      Loading…
    </Typography>
  );
}
