'use client';

import { type ElementType, type ReactElement, useEffect, useState } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import Chip from '@mui/material/Chip';
import type { RepositoryMainView } from '@contract/repository-main';
import type { StateTone } from '@contract/run-state';
import { getRepositoryMain } from '../../lib/backlog-endpoints';
import { toneColor, WorkingIcon } from '../run';

/** Per state of a main: what the chip says for a screen reader, its tone and icon, and a note shown after the name. */
const STATES: Record<RepositoryMainView['state'], { said: string; note?: string; tone: StateTone; Icon: ElementType }> =
  {
    green: { said: 'main is green', tone: 'done', Icon: CheckCircleIcon },
    pending: { said: 'main is running', tone: 'working', Icon: WorkingIcon },
    red: { said: 'main is red', tone: 'error', Icon: ErrorOutlineIcon },
    none: { said: 'no CI', note: 'no CI', tone: 'neutral', Icon: RemoveCircleOutlineIcon },
  };

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
      label={state?.note ? `${repository} · ${state.note}` : repository}
      aria-label={state ? `${repository}: ${state.said}` : repository}
      icon={<Icon sx={{ color: `${toneColor(tone)} !important` }} />}
      {...link}
    />
  );
}
