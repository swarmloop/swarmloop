'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import type { RunSummary } from '@contract/api';
import type { StateTone } from '@contract/run-state';
import { taskGroup } from '@contract/task-order';
import { DisclosureIcon } from '../../components/ui/disclosure-icon';
import { toneColor } from '../run';
import { needsLook, orderedTasks, statusOf, taskCountsOf } from './epic-tasks';
import { RunRow } from './run-row';
import { runWord } from './run-word';
import { TaskLine } from './task-line';

type Group = ReturnType<typeof taskGroup>;

const BAR: { group: Group; tone: StateTone }[] = [
  { group: 'settled', tone: 'done' },
  { group: 'running', tone: 'working' },
  { group: 'waiting', tone: 'neutral' },
  { group: 'person', tone: 'error' },
];

/** Segment sizes of the progress bar: how many tasks are in each group, from the plan's per-status counts. */
function barCounts(counts: ReturnType<typeof taskCountsOf>): Map<Group, number> {
  const groups = new Map<Group, number>();
  for (const [status, count] of Object.entries(counts)) {
    const group = taskGroup(status as Parameters<typeof taskGroup>[0]);
    groups.set(group, (groups.get(group) ?? 0) + count);
  }
  return groups;
}

/** A parent run and its tasks on one surface: a two-line row, a progress bar, and the tasks hanging under a guide line. */
export function EpicGroup({
  run,
  tasks,
  selected,
  now,
  onOpen,
  onRemove,
}: {
  run: RunSummary;
  tasks: RunSummary[];
  selected: string;
  now: number;
  onOpen: (key: string) => void;
  onRemove: (run: RunSummary) => void;
}): ReactElement {
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  const [settledOpen, setSettledOpen] = useState(false);
  const open = override ?? tasks.some(needsLook);
  const counts = taskCountsOf(run, tasks);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const blocked = counts.blocked ?? 0;
  const needsYou = tasks.filter((task) => runWord(task).tone === 'person').length;
  const { open: openTasks, settled } = orderedTasks(tasks);
  const skipped = settled.filter((task) => statusOf(task) === 'skipped').length;
  const merged = settled.length - skipped;
  const segments = barCounts(counts);
  const tint = (tone: StateTone, text: string): ReactElement => (
    <>
      {' · '}
      <Box component="span" sx={{ color: toneColor(tone) }}>
        {text}
      </Box>
    </>
  );
  return (
    <Box component="li" sx={{ listStyle: 'none', mb: 1.5, borderRadius: 1, bgcolor: 'action.hover', py: 0.25 }}>
      <List disablePadding>
        <RunRow
          run={run}
          selected={!open && run.key === selected}
          now={now}
          onOpen={onOpen}
          onRemove={onRemove}
          toggle={
            <IconButton
              size="small"
              aria-label={`${open ? 'Collapse' : 'Expand'} subtasks of ${run.name}`}
              aria-expanded={open}
              sx={{ p: 0, width: 22, height: 22, flexShrink: 0 }}
              onClick={(event) => {
                event.stopPropagation();
                setOverride(!open);
              }}
            >
              <DisclosureIcon open={open} />
            </IconButton>
          }
          extras={
            <>
              {` · ${total} tasks · ${counts.merged ?? 0} merged`}
              {blocked > 0 ? tint('error', `${blocked} blocked`) : null}
              {needsYou > 0 ? tint('person', `${needsYou} needs you`) : null}
            </>
          }
        />
      </List>
      <Box sx={{ display: 'flex', gap: '2px', height: 3, mx: 1, mb: 0.5 }}>
        {BAR.filter(({ group }) => segments.has(group)).map(({ group, tone }) => (
          <Box
            key={group}
            data-testid="progress-segment"
            sx={{ flex: segments.get(group), bgcolor: toneColor(tone), borderRadius: 2 }}
          />
        ))}
      </Box>
      {open ? (
        <Box sx={{ ml: 2.5, pl: 1, position: 'relative' }}>
          <Box aria-hidden data-testid="guide-line" sx={GUIDE} />
          <List disablePadding aria-label={`Tasks of ${run.name}`}>
            {openTasks.map((task) => (
              <TaskLine
                key={task.key}
                run={task}
                selected={task.key === selected}
                onOpen={onOpen}
                onRemove={onRemove}
              />
            ))}
            {settled.length > 0 && !settledOpen ? (
              <ListItem disablePadding disableGutters>
                <ListItemButton component="div" data-nav onClick={() => setSettledOpen(true)} sx={{ py: 0.25, px: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    {`✓ ${merged} merged${skipped > 0 ? ` · ${skipped} skipped` : ''}`}
                  </Typography>
                </ListItemButton>
              </ListItem>
            ) : null}
            {settledOpen
              ? settled.map((task) => (
                  <TaskLine
                    key={task.key}
                    run={task}
                    selected={task.key === selected}
                    onOpen={onOpen}
                    onRemove={onRemove}
                  />
                ))
              : null}
          </List>
        </Box>
      ) : null}
    </Box>
  );
}

/** The thin vertical line from the arrow down along the open tasks. */
const GUIDE = {
  position: 'absolute',
  left: 0,
  top: 2,
  bottom: 2,
  width: '1px',
  bgcolor: 'text.disabled',
} as const;
