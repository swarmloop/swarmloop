'use client';

import { type ReactElement, useEffect, useState } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import Chip from '@mui/material/Chip';
import type { RepositoryMainView } from '@contract/repository-main';
import type { StateTone } from '@contract/run-state';
import { getRepositoryMain } from '../../lib/backlog-endpoints';
import { toneColor, WorkingIcon } from '../run';

const STATES = {
  green: { words: 'green', tone: 'done', Icon: CheckCircleIcon },
  pending: { words: 'running', tone: 'working', Icon: WorkingIcon },
  red: { words: 'red', tone: 'error', Icon: ErrorOutlineIcon },
} as const;

/** One repository of a backlog with the state of its main; a failed read leaves a neutral chip. */
export function RepositoryChip({ repository }: { repository: string }): ReactElement {
  const [main, setMain] = useState<RepositoryMainView | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRepositoryMain(repository)
      .then((view) => {
        if (!cancelled) {
          setMain(view);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMain(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const state = main ? STATES[main.state] : null;
  const tone: StateTone = state?.tone ?? 'neutral';
  const Icon = state?.Icon ?? HelpOutlineIcon;
  const link = main?.url
    ? { component: 'a', href: main.url, clickable: true, target: '_blank', rel: 'noreferrer' }
    : {};

  return (
    <Chip
      size="small"
      variant="outlined"
      label={repository}
      aria-label={state ? `${repository}: main is ${state.words}` : repository}
      icon={<Icon sx={{ color: `${toneColor(tone)} !important` }} />}
      {...link}
    />
  );
}
