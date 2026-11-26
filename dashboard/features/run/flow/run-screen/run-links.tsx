'use client';

import type { ReactElement } from 'react';
import OpenInNew from '@mui/icons-material/OpenInNew';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import type { FlowView } from '@contract/api';

/** The merge requests of a run and the merge commit of each merged repository that has a link. */
export function RunLinks({
  mergeRequests,
  commits,
}: {
  mergeRequests: FlowView['mergeRequests'];
  commits: { repo: string; sha: string; url: string }[];
}): ReactElement | null {
  if (mergeRequests.length === 0 && commits.length === 0) {
    return null;
  }
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 0.5 }}>
      {mergeRequests.map((request) => (
        <MuiLink
          key={request.url}
          href={request.url}
          target="_blank"
          rel="noreferrer"
          variant="body2"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
        >
          {`${request.repo} · ${request.state}`}
          <OpenInNew sx={{ fontSize: 14 }} />
        </MuiLink>
      ))}
      {commits.map((commit) => (
        <MuiLink
          key={commit.repo}
          href={commit.url}
          target="_blank"
          rel="noreferrer"
          variant="body2"
          title={`Merge commit in ${commit.repo}`}
          sx={{ fontFamily: 'var(--font-mono)' }}
        >
          {commit.sha.slice(0, 7)}
        </MuiLink>
      ))}
    </Box>
  );
}
