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
import type { SettingsView } from '@contract/settings';
import { agentOf, entryOf } from './agent-entry';

type Runtimes = SettingsView['runtimes'];

const keyOf = (entry: string): string => {
  const { runtime, model } = agentOf(entry);
  return `${runtime}:${model}`;
};

/** `runtime:model[:effort]` entries; the first is used and the next ones are the fallback. */
export function AgentList({
  label,
  value,
  runtimes,
  onChange,
}: {
  label: string;
  value: string[];
  runtimes: Runtimes;
  onChange: (value: string[]) => void;
}): ReactElement {
  const [dragging, setDragging] = useState<number | null>(null);
  const used = new Set(value.map((entry) => keyOf(entry)));
  const addable = runtimes
    .flatMap(({ runtime, models }) => models.map((model) => `${runtime}:${model}`))
    .filter((choice) => !used.has(choice));

  function change(index: number, next: { model?: string; effort?: string }): void {
    const agent = { ...agentOf(value[index]), ...next };
    const levels = runtimes.find((item) => item.runtime === agent.runtime)?.efforts[agent.model] ?? [];
    const { effort, ...rest } = agent;
    const entry = entryOf(effort && levels.includes(effort) ? agent : rest);
    onChange(value.map((old, i) => (i === index ? entry : old)));
  }

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
        {value.map((entry, index) => {
          const { runtime, model, effort } = agentOf(entry);
          const info = runtimes.find((item) => item.runtime === runtime);
          const levels = info?.efforts[model] ?? [];
          const models = (info?.models ?? []).filter((name) => name === model || !used.has(`${runtime}:${name}`));
          return (
            <Box
              component="li"
              key={`${runtime}:${model}`}
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
              <Select
                size="small"
                value={model}
                onChange={(event) => change(index, { model: event.target.value })}
                inputProps={{ 'aria-label': `Model of ${entry}` }}
                sx={{ minWidth: 140 }}
              >
                {models.includes(model) ? null : <MenuItem value={model}>{model}</MenuItem>}
                {models.map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </Select>
              {levels.length > 0 ? (
                <Select
                  size="small"
                  value={effort ?? ''}
                  onChange={(event) => change(index, { effort: event.target.value })}
                  inputProps={{ 'aria-label': `Effort of ${entry}` }}
                  sx={{ minWidth: 140 }}
                >
                  <MenuItem value="">Runtime default</MenuItem>
                  {levels.map((level) => (
                    <MenuItem key={level} value={level}>
                      {level}
                    </MenuItem>
                  ))}
                </Select>
              ) : null}
              <IconButton
                size="small"
                aria-label={`Remove ${entry}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <Close fontSize="small" />
              </IconButton>
            </Box>
          );
        })}
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
