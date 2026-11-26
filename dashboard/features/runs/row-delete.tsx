'use client';

import { useState } from 'react';
import type { FocusEvent, ReactElement } from 'react';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import MoreHoriz from '@mui/icons-material/MoreHoriz';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import useMediaQuery from '@mui/material/useMediaQuery';
import type { RunSummary } from '@contract/api';
import { usePhone } from '../../lib/use-phone';

/** Whether the pointer or the keyboard focus is inside a row, and the handlers that track it. */
export function useRowReveal(): {
  shown: boolean;
  handlers: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
} {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return {
    shown: hovered || focused,
    handlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: (event) => setFocused(event.currentTarget.contains(event.relatedTarget)),
    },
  };
}

/** The delete of a row: an icon while the row is hovered or has focus, a `⋯` menu where there is no hover. */
export function RowDelete({
  run,
  shown,
  onRemove,
}: {
  run: RunSummary;
  shown: boolean;
  onRemove: (run: RunSummary) => void;
}): ReactElement {
  const noHover = useMediaQuery('(hover: none)');
  const phone = usePhone();
  const touch = noHover || phone;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (touch) {
    return (
      <>
        <IconButton
          size="small"
          aria-label={`More actions for ${run.title}`}
          sx={{ color: 'text.secondary', p: 0, minWidth: 40, minHeight: 40, flexShrink: 0 }}
          onClick={(event) => {
            event.stopPropagation();
            setAnchor(event.currentTarget);
          }}
        >
          <MoreHoriz sx={{ fontSize: 18 }} />
        </IconButton>
        <Menu
          open={anchor !== null}
          anchorEl={anchor}
          onClose={() => setAnchor(null)}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onRemove(run);
            }}
          >
            Remove
          </MenuItem>
        </Menu>
      </>
    );
  }
  return (
    <IconButton
      size="small"
      aria-label={`Remove ${run.title}`}
      aria-hidden={shown ? undefined : true}
      tabIndex={shown ? undefined : -1}
      sx={{
        color: 'text.secondary',
        p: 0,
        width: 22,
        height: 22,
        flexShrink: 0,
        visibility: shown ? 'visible' : 'hidden',
      }}
      onClick={(event) => {
        event.stopPropagation();
        onRemove(run);
      }}
    >
      <DeleteOutline sx={{ fontSize: 16 }} />
    </IconButton>
  );
}
