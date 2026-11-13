'use client';

import { Fragment, useState } from 'react';
import type { ReactElement } from 'react';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import Schedule from '@mui/icons-material/Schedule';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { openRunMs } from '../../lib/elapsed';
import { duration, money, when } from '../../lib/format';
import type { RunSummary } from '@contract/api';
import { statusColor } from '../../theme/theme';
import { RunStateLabel } from '../run';

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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
      <List sx={{ px: 0.5, py: 0.5 }}>
        {tops.map((run) => {
          const subtasks = children.get(run.key) ?? [];
          const open = subtasks.length > 0 && (expanded[run.key] ?? run.status !== 'done');
          return (
            <Fragment key={run.key}>
              <RunRow
                run={run}
                depth={0}
                toggle={
                  subtasks.length > 0 ? (
                    <IconButton
                      size="small"
                      aria-label={`${open ? 'Collapse' : 'Expand'} subtasks of ${run.name}`}
                      aria-expanded={open}
                      sx={{ p: 0, width: 22, height: 22, flexShrink: 0 }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpanded((current) => ({ ...current, [run.key]: !open }));
                      }}
                    >
                      {open ? <ExpandLess sx={{ fontSize: 18 }} /> : <ExpandMore sx={{ fontSize: 18 }} />}
                    </IconButton>
                  ) : null
                }
                selected={selected}
                now={now}
                onOpen={onOpen}
                onRemove={onRemove}
              />
              {open
                ? subtasks.map((subtask) => (
                    <RunRow
                      key={subtask.key}
                      run={subtask}
                      depth={1}
                      toggle={null}
                      selected={selected}
                      now={now}
                      onOpen={onOpen}
                      onRemove={onRemove}
                    />
                  ))
                : null}
            </Fragment>
          );
        })}
      </List>
      {error ? (
        <Typography variant="body2" color="error" sx={{ px: 2 }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}

function RunRow({
  run,
  depth,
  toggle,
  selected,
  now,
  onOpen,
  onRemove,
}: {
  run: RunSummary;
  depth: number;
  toggle: ReactElement | null;
  selected: string;
  now: number;
  onOpen: (key: string) => void;
  onRemove: (run: RunSummary) => void;
}): ReactElement {
  return (
    <ListItem disablePadding disableGutters divider sx={{ mb: 1, pl: depth * 2 }}>
      <ListItemButton
        component="div"
        selected={run.key === selected}
        onClick={() => onOpen(run.key)}
        sx={{ alignItems: 'flex-start', py: 0.5, px: 1 }}
      >
        <Box sx={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'nowrap', minWidth: 0 }}>
            {toggle}
            <Tooltip title={run.name}>
              <Typography noWrap sx={{ fontWeight: 500, fontSize: 14, flex: 1, minWidth: 0 }}>
                {run.name}
              </Typography>
            </Tooltip>
            {depth > 0 && run.status === 'waiting' ? (
              <Typography color="text.secondary" sx={{ fontSize: 12, flexShrink: 0 }}>
                waiting
              </Typography>
            ) : null}
            <Tooltip title={run.currentStep}>
              <Chip
                size="small"
                label={run.currentStep}
                sx={{
                  maxWidth: '40%',
                  minWidth: 0,
                  flexShrink: 1,
                  overflow: 'hidden',
                  bgcolor: 'transparent',
                  color: statusColor(run.status),
                  border: 1,
                  borderColor: statusColor(run.status),
                  height: 18,
                  '& .MuiChip-label': {
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontSize: 12,
                    px: 0.75,
                  },
                }}
              />
            </Tooltip>
          </Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              flexWrap: run.epic ? 'wrap' : 'nowrap',
              minWidth: 0,
            }}
          >
            <Typography sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', fontSize: 12, flexShrink: 0 }}>
              {run.epic ? `${money(run.epic.usd)} total · ${money(run.usd)} this run` : money(run.usd)}
            </Typography>
            <Tooltip title="Total time the steps have run. Reviewers that run together count as the slowest one, then the report and the remaining time in that step. Time waiting on a person, and time sitting idle after a failure, is not included.">
              <Box
                component="span"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.25,
                  flexShrink: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'text.secondary',
                }}
              >
                <Schedule sx={{ fontSize: 14 }} />
                {run.epic
                  ? `${duration(run.epic.durationMs)} total · ${duration(run.durationMs + openRunMs(run, now))} this run`
                  : duration(run.durationMs + openRunMs(run, now))}
              </Box>
            </Tooltip>
            <Typography noWrap color="text.secondary" sx={{ fontSize: 12, minWidth: 0, ml: 'auto' }}>
              {when(run.createdAt)}
            </Typography>
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
          </Box>
          <RunStateLabel
            status={run.status}
            merge={run.merge}
            subtask={Boolean(run.parentKey)}
            mergeWait={run.mergeWait}
          />
        </Box>
      </ListItemButton>
    </ListItem>
  );
}

/** The runs that are not shown under a parent, and each parent's subtasks in list order. */
function nested(visible: RunSummary[]): { tops: RunSummary[]; children: Map<string, RunSummary[]> } {
  const keys = new Set(visible.map((run) => run.key));
  const children = new Map<string, RunSummary[]>();
  const tops: RunSummary[] = [];
  for (const run of visible) {
    if (run.parentKey && keys.has(run.parentKey)) {
      children.set(run.parentKey, [...(children.get(run.parentKey) ?? []), run]);
    } else {
      tops.push(run);
    }
  }
  return { tops, children };
}
