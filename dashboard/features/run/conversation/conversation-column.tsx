'use client';

import { type ReactElement, useEffect, useLayoutEffect, useRef } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import ChatIcon from '@mui/icons-material/ChatBubbleOutline';
import CloseIcon from '@mui/icons-material/Close';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import useMediaQuery from '@mui/material/useMediaQuery';
import type { FlowView } from '@contract/api';
import { ConversationFeed } from './conversation-feed';
import { feedEntries } from './talk-entries';
import { needsPerson, newestOf, type FeedEntry } from './conversation-words';
import { MessageBox } from './message-box';
import { useColumnState } from './use-column-state';
import { useFitWindow } from './use-fit-window';

/** The width of the column: 360 px by default, between 320 and 400. */
const WIDTH = { width: 360, minWidth: 320, maxWidth: 400 } as const;
const RAIL_PX = 44;
/** Below this window width the column is a bottom sheet. */
export const SHEET_BELOW_PX = 900;

function Mark(): ReactElement {
  return (
    <Box
      data-testid="new-mark"
      aria-hidden
      sx={{
        position: 'absolute',
        top: 6,
        right: 6,
        width: 10,
        height: 10,
        borderRadius: '50%',
        bgcolor: 'primary.main',
      }}
    />
  );
}

function Footer({ flow, onChange }: { flow: FlowView; onChange: (flow: FlowView) => void }): ReactElement | null {
  const mode = flow.conversation?.composer;
  if (mode && mode !== 'read-only') {
    return <MessageBox flow={flow} mode={mode} onChange={onChange} />;
  }
  const parent = flow.conversation?.parentKey ?? flow.parentKey;
  return parent ? (
    <Typography variant="body2">
      <Link href={`/runs/${encodeURIComponent(parent)}` as Route}>{`The parent's conversation (${parent})`}</Link>
      {' is where the planner of this subtask is asked.'}
    </Typography>
  ) : null;
}

/**
 * The conversation of a run, on the right of the run page under the flow board and kept for every step: open, or a thin
 * rail that shows a mark when something new came. Below 900 px it is a bottom sheet. The message box sits at its bottom.
 */
export function ConversationColumn({
  flow,
  onResume,
  onChange,
  wide = false,
  onWide = () => undefined,
}: {
  flow: FlowView;
  onResume: () => void;
  onChange: (flow: FlowView) => void;
  wide?: boolean;
  onWide?: (wide: boolean) => void;
}): ReactElement {
  const narrow = !useMediaQuery(`(min-width:${SHEET_BELOW_PX}px)`, { noSsr: true });
  const entries: FeedEntry[] = feedEntries(flow.conversation?.entries ?? [], flow.conversation?.parentKey);
  const newest = newestOf(flow, entries);
  const needsNow = needsPerson(flow);
  const { open, setOpen, reveal, unseen } = useColumnState(newest, narrow, needsNow);
  const needs = needsNow ? newest : '';
  const rail = !narrow && !open;
  const asideRef = useRef<HTMLElement>(null);
  useFitWindow(asideRef, !narrow && open);
  useLayoutEffect(() => {
    // A rail never stands in for the step window: a stored wide choice ends when the column shows as the rail.
    // It ends in the same commit that shows the rail, before the page paints.
    if (rail && wide) {
      onWide(false);
    }
  }, [rail, wide, onWide]);
  useEffect(() => {
    if (needs && narrow) {
      reveal();
    }
  }, [needs, narrow, reveal]);

  const opener = (
    <Button
      onClick={() => setOpen(true)}
      aria-label={unseen ? 'Open the conversation, something new' : 'Open the conversation'}
      startIcon={<ChatIcon />}
      sx={{ position: 'relative' }}
    >
      Conversation
      {unseen ? <Mark /> : null}
    </Button>
  );
  const body = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 0, flex: 1, minWidth: 0, p: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Typography component="h2" variant="subtitle1" sx={{ flex: 1 }}>
          Conversation
        </Typography>
        {narrow ? null : (
          <Button
            size="small"
            startIcon={wide ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
            onClick={() => onWide(!wide)}
          >
            {wide ? 'Narrow' : 'Widen'}
          </Button>
        )}
        <IconButton
          size="small"
          aria-label="Collapse the conversation"
          onClick={() => {
            onWide(false);
            setOpen(false);
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      <ConversationFeed flow={flow} entries={entries} onResume={onResume} />
      <Footer flow={flow} onChange={onChange} />
    </Box>
  );

  if (narrow) {
    return (
      <Box sx={{ mt: 2 }}>
        {opener}
        {open ? (
          <Drawer
            // Not modal: it opens by itself when something needs the person, so the page behind stays usable.
            variant="persistent"
            anchor="bottom"
            open
            slotProps={{ paper: { role: 'region', 'aria-label': 'Conversation', sx: { maxHeight: '85vh' } } as object }}
          >
            {body}
          </Drawer>
        ) : null}
      </Box>
    );
  }
  return open ? (
    <Box
      component="aside"
      aria-label="Conversation"
      ref={asideRef}
      sx={{
        ...(wide ? { flex: 1, minWidth: 0 } : { ...WIDTH, flexShrink: 0 }),
        alignSelf: 'flex-start',
        position: 'sticky',
        top: 16,
        height: 'calc(100vh - 32px)',
        display: 'flex',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
      }}
    >
      {body}
    </Box>
  ) : (
    <Box
      component="aside"
      aria-label="Conversation rail"
      sx={{ width: RAIL_PX, flexShrink: 0, position: 'relative', alignSelf: 'flex-start', mt: 3 }}
    >
      <IconButton
        aria-label={unseen ? 'Open the conversation, something new' : 'Open the conversation'}
        onClick={() => setOpen(true)}
      >
        <ChatIcon />
      </IconButton>
      {unseen ? <Mark /> : null}
    </Box>
  );
}
