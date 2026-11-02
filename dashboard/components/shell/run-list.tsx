'use client';

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
import { RunSummary } from '../../lib/types';
import { statusColor } from '../../theme/theme';

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
}) {
  return (
    <Box sx={{ flex: 1, overflow: 'auto' }}>
      <Box sx={{ px: 1.5, pt: 1 }}>
        <TextField value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Filter by key" size="small" fullWidth />
      </Box>
      {visible.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 2 }}>
          {runs.length === 0 ? 'No runs yet.' : 'No key matches.'}
        </Typography>
      ) : null}
      <List sx={{ px: 0.5, py: 0.5 }}>
        {visible.map((run) => (
          <ListItem key={run.key} disablePadding disableGutters divider sx={{ mb: 1 }}>
            <ListItemButton component="div" selected={run.key === selected} onClick={() => onOpen(run.key)} sx={{ alignItems: 'flex-start', py: 0.5, px: 1 }}>
              <Box sx={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'nowrap', minWidth: 0 }}>
                  <Tooltip title={run.name}>
                    <Typography noWrap sx={{ fontWeight: 500, fontSize: 14, flex: 1, minWidth: 0 }}>
                      {run.name}
                    </Typography>
                  </Tooltip>
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
                        '& .MuiChip-label': { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 12, px: 0.75 },
                      }}
                    />
                  </Tooltip>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'nowrap', minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', fontSize: 12, flexShrink: 0 }}>{money(run.usd)}</Typography>
                  <Tooltip title="Total time the steps have run. Reviewers that run together count as the slowest one, then the report and the remaining time in that step. Time waiting on a person, and time sitting idle after a failure, is not included.">
                    <Box
                      component="span"
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'text.secondary' }}
                    >
                      <Schedule sx={{ fontSize: 14 }} />
                      {duration(run.durationMs + openRunMs(run, now))}
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
              </Box>
            </ListItemButton>
          </ListItem>
        ))}
      </List>
      {error ? (
        <Typography variant="body2" color="error" sx={{ px: 2 }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}
