'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import type { PlanRevision } from '@contract/plan-chat';
import { plainText } from './conversation-words';

function Items({ title, items }: { title: string; items: string[] }): ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <Box component="section" aria-label={title}>
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {items.map((item) => (
          <Typography key={item} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {plainText(item)}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

/** What one change of the plan did: its reason in one line and the items or tasks added, changed and removed. */
export function RevisionCard({ revision }: { revision: PlanRevision }): ReactElement {
  const line = [revision.summary, revision.reason].filter((part) => part !== '').join(' · ');
  return (
    <Box
      component="section"
      aria-label={`Plan v${revision.version}`}
      sx={(theme) => ({
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        display: 'grid',
        gap: 0.75,
        minWidth: 0,
        bgcolor: alpha(theme.palette.primary.main, 0.06),
      })}
    >
      <Typography variant="subtitle2">{`Plan v${revision.version} · what changed`}</Typography>
      {line ? (
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {plainText(line)}
        </Typography>
      ) : null}
      <Items title="Added" items={revision.added} />
      <Items title="Changed" items={revision.changed} />
      <Items title="Removed" items={revision.dropped} />
    </Box>
  );
}
