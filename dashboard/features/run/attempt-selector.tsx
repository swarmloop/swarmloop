'use client';

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';

export interface AttemptItem {
  /** Unique in the list. */
  key: string;
  label: string;
  color: string;
  /** The line of the item in the `Earlier` menu. */
  menuText: string;
}

/** The newest attempts shown as buttons; the rest sit behind the `Earlier` menu. */
export const VISIBLE_ATTEMPTS = 8;

export function AttemptSelector({
  items,
  selected,
  onSelect,
}: {
  items: AttemptItem[];
  selected: string | undefined;
  onSelect: (key: string) => void;
}): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = useRef<HTMLButtonElement | null>(null);
  const earlier = items.slice(0, -VISIBLE_ATTEMPTS);
  const chosen = earlier.find((item) => item.key === selected);
  const shown = [...(chosen ? [chosen] : []), ...items.slice(-VISIBLE_ATTEMPTS)];

  useEffect(() => {
    current.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [selected, items.length]);

  return (
    <Box sx={{ display: 'flex', gap: 0.5, overflowX: 'auto', minWidth: 0 }}>
      {earlier.length > 0 ? (
        <>
          <Button size="small" onClick={(event) => setAnchor(event.currentTarget)} sx={{ flexShrink: 0 }}>
            Earlier ({earlier.length})
          </Button>
          <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
            {earlier.map((item) => (
              <MenuItem
                key={item.key}
                selected={item.key === selected}
                onClick={() => {
                  setAnchor(null);
                  onSelect(item.key);
                }}
                sx={{ color: item.color }}
              >
                {item.menuText}
              </MenuItem>
            ))}
          </Menu>
        </>
      ) : null}
      {shown.map((item) => {
        const active = item.key === selected;
        return (
          <Button
            key={item.key}
            ref={active ? current : undefined}
            size="small"
            variant={active ? 'contained' : 'text'}
            onClick={() => onSelect(item.key)}
            sx={{
              flexShrink: 0,
              ...(active ? { bgcolor: item.color, '&:hover': { bgcolor: item.color } } : { color: item.color }),
            }}
          >
            {item.label}
          </Button>
        );
      })}
    </Box>
  );
}
