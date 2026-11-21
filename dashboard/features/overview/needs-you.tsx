'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { RunSummary } from '@contract/api';
import { NEEDS_ANSWERS, needsPerson } from '@contract/run-state';
import { nested } from '@contract/run-list';
import { backlogPath } from '../../lib/backlog-path';
import { useBacklogs } from '../backlogs';
import { runWord } from '../run';
import { useOverviewRuns } from './use-overview-runs';

const SHOWN = 3;

interface Card {
  id: string;
  title: string;
  detail: string;
  button: string;
  href: Route;
}

const runHref = (key: string): Route => `/runs/${encodeURIComponent(key)}` as Route;

function runCard(run: RunSummary, button: string): Card {
  return { id: run.key, title: run.title, detail: runWord(run).word, button, href: runHref(run.key) };
}

/** What waits for a person: questions first, then failures, then milestones that ask to run. */
export function NeedsYou(): ReactElement | null {
  const { loaded, active } = useOverviewRuns();
  const { backlogs } = useBacklogs();
  const { tops } = nested(active);
  const isQuestion = (run: RunSummary): boolean =>
    needsPerson(run.state, run.stateReason) && run.stateReason?.code === NEEDS_ANSWERS;
  const cards: Card[] = [
    ...tops.filter(isQuestion).map((run) => runCard(run, 'Answer')),
    ...tops
      .filter((run) => !isQuestion(run) && (run.state === 'failed' || run.state === 'blocked'))
      .map((run) => runCard(run, 'Resume')),
    ...backlogs.flatMap((backlog) =>
      backlog.milestones
        .filter((milestone) => milestone.status === 'proposed')
        .map((milestone) => ({
          id: `${backlog.name}/${milestone.number}`,
          title: milestone.title,
          detail: `Asks to run in ${backlog.name}`,
          button: 'Open',
          href: backlogPath(backlog.name),
        })),
    ),
  ];
  if (!loaded || cards.length === 0) {
    return null;
  }
  const more = cards.length - SHOWN;
  return (
    <Box component="section" aria-label="Needs you" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2" component="h2">
        Needs you
      </Typography>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {cards.slice(0, SHOWN).map((card) => (
          <Box
            key={card.id}
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              p: 1.5,
              display: 'flex',
              gap: 1,
              alignItems: 'center',
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography noWrap>{card.title}</Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {card.detail}
              </Typography>
            </Box>
            <Button component={Link} href={card.href} variant="outlined" size="small">
              {card.button}
            </Button>
          </Box>
        ))}
      </Box>
      {more > 0 ? <Link href="/">{`+${more} more`}</Link> : null}
    </Box>
  );
}
