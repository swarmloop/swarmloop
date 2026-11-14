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
}): ReactElement | null {
  const touch = useMediaQuery('(hover: none)');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (touch) {
    return (
      <>
        <IconButton
          size="small"
          aria-label={`More actions for ${run.name}`}
          sx={{ color: 'text.secondary', p: 0, width: 22, height: 22, flexShrink: 0 }}
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
  if (!shown) {
    return null;
  }
  return (
    <IconButton
      size="small"
      aria-label={`Remove ${run.name}`}
      sx={{ color: 'text.secondary', p: 0, width: 22, height: 22, flexShrink: 0 }}
      onClick={(event) => {
        event.stopPropagation();
        onRemove(run);
      }}
    >
      <DeleteOutline sx={{ fontSize: 16 }} />
    </IconButton>
  );
}
