'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import MuiLink from '@mui/material/Link';
import { backlogLine, type RunBacklog } from '@contract/backlog';
import { backlogPath } from '../../lib/backlog-path';

/** The backlog a run belongs to, as a small link to that backlog's page. */
export function BacklogLabel({ label }: { label: RunBacklog }): ReactElement {
  return (
    <MuiLink
      component={Link}
      href={`${backlogPath(label.name)}` as Route}
      variant="caption"
      aria-label={`Open backlog ${label.name}`}
      onClick={(event) => event.stopPropagation()}
    >
      {backlogLine(label)}
    </MuiLink>
  );
}
