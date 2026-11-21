'use client';

import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { BubbleLayoutProvider } from '../transcript/bubble';
import { RADIUS, SPACE, useMotionMs } from '../transcript/tokens';
import { useFollowBottom } from '../use-follow-bottom';

/**
 * The scrolling log of a conversation. It follows the bottom while the reader is there and offers `New messages ↓`
 * when something came while the reader was scrolled up. `count` is the number of rows, `streaming` the text of a
 * reply that grows without a new row.
 */
export function FeedLog({
  count,
  streaming = '',
  children,
}: {
  count: number;
  streaming?: string;
  children: ReactNode;
}): ReactElement {
  const ms = useMotionMs();
  const { box, onScroll, unseen, scrollToBottom } = useFollowBottom(count, streaming);
  return (
    <BubbleLayoutProvider value={{ width: '92%', ms }}>
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Box
          ref={box}
          role="log"
          aria-label="Conversation"
          onScroll={onScroll}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            minWidth: 0,
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          {children}
        </Box>
        {unseen ? (
          <Button
            size="small"
            variant="contained"
            onClick={scrollToBottom}
            sx={{
              position: 'absolute',
              bottom: SPACE.part,
              left: '50%',
              transform: 'translateX(-50%)',
              borderRadius: RADIUS.pill,
            }}
          >
            New messages ↓
          </Button>
        ) : null}
      </Box>
    </BubbleLayoutProvider>
  );
}
