'use client';

import type { ReactElement } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import type { StepState } from '@contract/step-state';
import { StepStateIcon } from './step-state-icon';

interface AttemptItem {
  /** Unique in the list. */
  key: string;
  label: string;
  color: string;
  /** The state of the attempt, when it has one: its icon is drawn beside the number. */
  state?: StepState;
  /** The line of the item in the `Earlier` menu. */
  menuText: string;
}

/** The newest attempts shown as buttons; the rest sit behind the `Earlier` menu. */
const VISIBLE_ATTEMPTS = 8;

export function AttemptSelector({
  items,
  selected,
  onSelect,
  caption = 'Attempt',
}: {
  items: AttemptItem[];
  selected: string | undefined;
  onSelect: (key: string) => void;
  /** The word before the numbers; empty when each label already names its step. */
  caption?: string;
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
    <Box sx={{ display: 'flex', alignItems: 'center', overflowX: 'auto', minWidth: 0 }}>
      {caption ? (
        <Typography component="span" color="text.secondary" sx={{ fontSize: 13, flexShrink: 0 }}>
          {`${caption} `}
        </Typography>
      ) : null}
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
      {shown.map((item, index) => {
        const active = item.key === selected;
        return (
          <Fragment key={item.key}>
            {index > 0 ? (
              <Typography component="span" color="text.secondary" aria-hidden sx={{ flexShrink: 0 }}>
                {' · '}
              </Typography>
            ) : null}
            <Button
              ref={active ? current : undefined}
              size="small"
              variant={active ? 'outlined' : 'text'}
              onClick={() => onSelect(item.key)}
              sx={{
                flexShrink: 0,
                gap: 0.5,
                color: item.color,
                ...(active ? { fontWeight: 700, borderColor: item.color, '&:hover': { borderColor: item.color } } : {}),
              }}
            >
              {item.state ? <StepStateIcon state={item.state} size={12} /> : null}
              {item.label}
            </Button>
          </Fragment>
        );
      })}
    </Box>
  );
}
