'use client';

import { type ReactElement, useEffect, useState } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { etaText } from '../../lib/eta-words';
import { useBacklogs } from '../backlogs';
import { RunStateIcon, runWord, toneColor } from '../run';
import { type NowCard, nowCards } from './now-items';
import { CARD_GRID_SX, LoadFailed, Placeholders, sectionState } from './section-state';
import { useOverviewRuns } from './use-overview-runs';

const TICK_MS = 30_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function CardView({ card, now }: { card: NowCard; now: number }): ReactElement {
  const view = card.run ? runWord(card.run) : null;
  const estimate = card.run ? card.run.eta : card.milestoneEta;
  const eta = estimate
    ? etaText(estimate, now)
    : card.milestoneEta === null
      ? { text: 'no estimate yet', tip: '' }
      : null;
  return (
    <Box
      component={Link}
      href={card.href}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        color: 'inherit',
        textDecoration: 'none',
        minWidth: 0,
      }}
    >
      <Typography noWrap>{card.title}</Typography>
      {card.tasks ? (
        <>
          <LinearProgress
            variant="determinate"
            value={card.tasks.total === 0 ? 0 : (card.tasks.merged / card.tasks.total) * 100}
            sx={{ my: 0.5 }}
          />
          <Typography variant="body2">{`${card.tasks.merged}/${card.tasks.total} tasks`}</Typography>
        </>
      ) : null}
      {card.step ? (
        <>
          <LinearProgress variant="determinate" value={card.step.percent} sx={{ my: 0.5 }} />
          <Typography variant="body2">{card.step.label}</Typography>
        </>
      ) : null}
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', color: view ? toneColor(view.tone) : 'info.main' }}>
        {view ? <RunStateIcon view={view} size={16} /> : null}
        <Typography variant="body2" noWrap>
          {view ? view.word : 'Working'}
        </Typography>
        {eta ? (
          <Typography variant="body2" color="text.secondary" title={eta.tip} noWrap sx={{ ml: 'auto' }}>
            {eta.text}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}

/** What works now, as cards. */
export function NowSection(): ReactElement {
  const runs = useOverviewRuns();
  const { backlogs, loaded, error } = useBacklogs();
  const now = useNow();
  const state = sectionState(runs, { loaded, failed: error !== null });
  const cards = nowCards(backlogs, runs.active, now);
  return (
    <Box component="section" aria-label="Now" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2" component="h2">
          Now
        </Typography>
        <Link href="/">All runs</Link>
      </Box>
      {state === 'loading' ? (
        <Placeholders count={3} height={84} testId="now-placeholder" grid />
      ) : state === 'failed' ? (
        <LoadFailed what="what runs now" />
      ) : cards.length === 0 ? (
        <Typography color="text.secondary">Nothing running</Typography>
      ) : (
        <Box sx={CARD_GRID_SX}>
          {cards.map((card) => (
            <CardView key={card.id} card={card} now={now} />
          ))}
        </Box>
      )}
    </Box>
  );
}
