'use client';

import type { KeyboardEvent, ReactElement } from 'react';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { RunSummary } from '@contract/api';
import { EpicGroup } from './epic-group';
import { byDay, nested } from './run-days';
import { RunRow } from './run-row';

/** Moves focus to the previous or next row, task line or fold button in the list. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (step === undefined || !event.currentTarget.contains(event.target as Node)) {
    return;
  }
  const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
  const at = stops.findIndex((stop) => stop.contains(document.activeElement));
  const next = stops[at < 0 ? (step > 0 ? 0 : stops.length - 1) : at + step];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

export function RunList({
  query,
  onQuery,
  runs,
  visible,
  selected,
  now,
  error,
  onOpen,
  onRemove,
}: {
  query: string;
  onQuery: (query: string) => void;
  runs: RunSummary[];
  visible: RunSummary[];
  selected: string;
  now: number;
  error: string | null;
  onOpen: (key: string) => void;
  onRemove: (run: RunSummary) => void;
}): ReactElement {
  const { tops, children } = nested(visible);
  return (
    <Box sx={{ flex: 1, overflow: 'auto' }}>
      <Box sx={{ px: 1.5, pt: 1 }}>
        <TextField
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filter by key"
          size="small"
          fullWidth
        />
      </Box>
      {visible.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 2 }}>
          {runs.length === 0 ? 'No runs yet.' : 'No key matches.'}
        </Typography>
      ) : null}
      <Box onKeyDown={moveFocus} sx={{ px: 0.5, py: 0.5 }}>
        {byDay(tops, now).map((day) => (
          <Box component="section" key={day.label} aria-label={day.label}>
            <Typography variant="overline" color="text.secondary" sx={{ px: 1, display: 'block', lineHeight: 2 }}>
              {day.label}
            </Typography>
            <List disablePadding>
              {day.runs.map((run) => {
                const tasks = children.get(run.key) ?? [];
                return tasks.length > 0 ? (
                  <EpicGroup
                    key={run.key}
                    run={run}
                    tasks={tasks}
                    selected={selected}
                    now={now}
                    onOpen={onOpen}
                    onRemove={onRemove}
                  />
                ) : (
                  <RunRow
                    key={run.key}
                    run={run}
                    selected={run.key === selected}
                    now={now}
                    onOpen={onOpen}
                    onRemove={onRemove}
                  />
                );
              })}
            </List>
          </Box>
        ))}
      </Box>
      {error ? (
        <Typography variant="body2" color="error" sx={{ px: 2 }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}
