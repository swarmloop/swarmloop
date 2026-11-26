'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { BacklogLabel } from '../../../../components/ui/backlog-label';
import { when } from '../../../../lib/format';
import type { FlowView } from '@contract/api';
import { personLabel } from '@contract/people';

/** The line under the state: the run key, its backlog, who started it, its projects. On a phone a chip keeps its whole label. */
export function RunIdentity({ flow, phone }: { flow: FlowView; phone: boolean }): ReactElement {
  const chipWhole = phone ? { flexShrink: 0, '& .MuiChip-label': { overflow: 'visible', textOverflow: 'clip' } } : {};
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
      <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} color="text.secondary">
        {flow.key}
      </Typography>
      {flow.backlog ? <BacklogLabel label={flow.backlog} /> : null}
      {flow.startedBy ? (
        <Typography variant="body2" color="text.secondary">
          Started by {personLabel(flow.startedBy)}
        </Typography>
      ) : null}
      {flow.startedBy && flow.ownerSince ? (
        <Typography variant="body2" color="text.secondary">
          Owned by {flow.startedBy} since {when(flow.ownerSince)}, before personal tokens it ran as machine
        </Typography>
      ) : null}
      {flow.projects.map((project) => (
        <Chip
          key={project}
          size="small"
          variant="outlined"
          label={project}
          sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12, ...chipWhole }}
        />
      ))}
      {flow.workspace === 'removed' ? (
        <Chip
          size="small"
          variant="outlined"
          label="workspace removed"
          sx={{ height: 22, fontSize: 12, ...chipWhole }}
        />
      ) : null}
    </Box>
  );
}
