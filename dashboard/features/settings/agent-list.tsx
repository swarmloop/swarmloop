'use client';

import type { DragEvent, KeyboardEvent, ReactElement } from 'react';
import { useState } from 'react';
import DragIndicator from '@mui/icons-material/DragIndicator';
import Close from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';

/** `runtime:model` entries; the first is used and the next ones are the fallback. */
export function AgentList({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string[];
  choices: string[];
  onChange: (value: string[]) => void;
}): ReactElement {
  const [dragging, setDragging] = useState<number | null>(null);
  const addable = choices.filter((choice) => !value.includes(choice));

  function move(from: number, to: number): void {
    if (to < 0 || to >= value.length || from === to) {
      return;
    }
    const next = [...value];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  }

  function onKeyDown(event: KeyboardEvent, index: number): void {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
    }
  }

  function onDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    if (dragging !== null) {
      move(dragging, index);
    }
    setDragging(null);
  }

  return (
    <Box>
      <Box component="ol" aria-label={label} sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {value.map((entry, index) => (
          <Box
            component="li"
            key={entry}
            tabIndex={0}
            draggable
            aria-label={`${entry}, ${index + 1} of ${value.length}`}
            onKeyDown={(event) => onKeyDown(event, index)}
            onDragStart={() => setDragging(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, index)}
            onDragEnd={() => setDragging(null)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1,
              py: 0.5,
              mb: 0.5,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'background.paper',
              opacity: dragging === index ? 0.5 : 1,
              '&:focus-visible': { outline: 2, outlineColor: 'primary.main' },
            }}
          >
            <DragIndicator fontSize="small" color="disabled" />
            <ListItemText primary={entry} secondary={index === 0 ? 'used first' : 'fallback'} />
            <IconButton
              size="small"
              aria-label={`Remove ${entry}`}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <Close fontSize="small" />
            </IconButton>
          </Box>
        ))}
      </Box>
      {addable.length > 0 ? (
        <Select
          size="small"
          displayEmpty
          value=""
          onChange={(event) => onChange([...value, event.target.value])}
          inputProps={{ 'aria-label': `Add to ${label}` }}
          renderValue={() => 'Add runtime:model'}
          sx={{ minWidth: 240 }}
        >
          {addable.map((choice) => (
            <MenuItem key={choice} value={choice}>
              {choice}
            </MenuItem>
          ))}
        </Select>
      ) : null}
    </Box>
  );
}
