'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useQueries } from '@tanstack/react-query';
import { getFlow } from '../../lib/endpoints';
import { money } from '../../lib/format';
import type { Route } from 'next';
import { DONE_SHOWN, type DoneLatelyItem } from '@contract/overview-done';
import { backlogPath } from '../../lib/backlog-path';
import { RunStateIcon, runWord } from '../run';
import { longDuration, returnsWords } from './overview-format';
import { LoadFailed, Placeholders, sectionState } from './section-state';
import { useDoneLately } from './use-done-lately';

function hrefOf(item: DoneLatelyItem): Route {
  return 'run' in item.link ? (`/runs/${encodeURIComponent(item.link.run)}` as Route) : backlogPath(item.link.backlog);
}

function DoneLine({ item }: { item: DoneLatelyItem }): ReactElement {
  const flows = useQueries({
    queries: item.runKeys.map((key) => ({ queryKey: ['overview-flow', key], queryFn: () => getFlow(key) })),
  });
  const loaded = flows.every((flow) => flow.data !== undefined);
  const returns = flows.reduce(
    (sum, flow) => sum + (flow.data?.returns ?? []).reduce((all, one) => all + one.count, 0),
    0,
  );
  const request = item.milestone ? undefined : flows[0]?.data?.mergeRequests[0];
  const view = runWord(item.run);
  return (
    <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
      <Box
        component={Link}
        href={hrefOf(item)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flex: 1,
          minWidth: 0,
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        <RunStateIcon view={view} />
        <Typography noWrap sx={{ flex: 1 }}>
          {item.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {longDuration(item.durationMs)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {money(item.usd)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {loaded ? returnsWords(returns, item.run.state === 'done' || item.run.state === 'merged') : ''}
        </Typography>
      </Box>
      {request ? (
        <a href={request.url} target="_blank" rel="noreferrer">
          Merge request
        </a>
      ) : null}
    </Box>
  );
}

/** The last five finished top-level items, one line each. */
export function DoneLately(): ReactElement | null {
  const { items: lines, loaded, failed } = useDoneLately();
  const state = sectionState({ loaded, failed });
  if (state === 'ready' && lines.length === 0) {
    return null;
  }
  return (
    <Box component="section" aria-label="Done lately" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2" component="h2">
        Done lately
      </Typography>
      {state === 'loading' ? (
        <Placeholders count={DONE_SHOWN} height={32} testId="done-placeholder" grid={false} />
      ) : null}
      {state === 'failed' ? <LoadFailed what="what got done" /> : null}
      {state === 'ready' ? (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {lines.map((item) => (
            <DoneLine key={item.key} item={item} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
