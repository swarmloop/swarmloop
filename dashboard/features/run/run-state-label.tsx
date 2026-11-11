'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { MergeOutcome } from '@contract/run-state';
import { when } from '../../lib/format';

/** The colors are the chart tokens of the theme: green for merged, the muted tone for closed. */
const TONE = { ready: 'primary.main', merged: 'var(--chart-done)', closed: 'var(--swarmloop-skipped, #8a847a)' };

/** Who and when, from the facts of one or more repositories. The latest time wins; names are listed once. */
function ended(facts: { by: string | null; at: string }[]): string {
  const names = [...new Set(facts.flatMap((fact) => fact.by ?? []))];
  const latest = facts.map((fact) => fact.at).sort()[facts.length - 1];
  return [names.length > 0 ? `by ${names.join(', ')}` : '', latest ? when(latest) : ''].filter(Boolean).join(' · ');
}

/**
 * How a done run's merge request stands: ready to merge, merged (who, when, and the merge commit) or closed (who,
 * when). Nothing for a run that is not done.
 */
export function RunStateLabel({ status, merge }: { status: string; merge?: MergeOutcome }): ReactElement | null {
  if (status !== 'done') {
    return null;
  }
  const kind = !merge ? 'ready' : 'merged' in merge ? 'merged' : 'closed';
  const label = { ready: 'Ready to merge', merged: 'Merged', closed: 'Closed' }[kind];
  const facts = !merge ? [] : 'merged' in merge ? Object.values(merge.merged) : [merge.closed];
  const commits = !merge || !('merged' in merge) ? [] : Object.entries(merge.merged).filter(([, fact]) => fact.sha);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 0.75, rowGap: 0.25, minWidth: 0 }}>
      <Chip
        size="small"
        label={label}
        sx={{
          height: 18,
          bgcolor: 'transparent',
          color: TONE[kind],
          border: 1,
          borderColor: TONE[kind],
          '& .MuiChip-label': { fontSize: 12, px: 0.75 },
        }}
      />
      {facts.length > 0 ? (
        <Typography color="text.secondary" sx={{ fontSize: 12 }}>
          {ended(facts)}
        </Typography>
      ) : null}
      {commits.map(([repo, fact]) => {
        const text = (fact.sha ?? '').slice(0, 7);
        return fact.url ? (
          <Link
            key={repo}
            href={fact.url}
            target="_blank"
            rel="noreferrer"
            title={`Merge commit in ${repo}`}
            onClick={(event) => event.stopPropagation()}
            sx={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          >
            {text}
          </Link>
        ) : (
          <Typography key={repo} color="text.secondary" sx={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {text}
          </Typography>
        );
      })}
    </Box>
  );
}
