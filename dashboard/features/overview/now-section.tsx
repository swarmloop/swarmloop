'use client';

import { type ReactElement, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { RunSummary } from '@contract/api';
import { nested } from '@contract/run-list';
import { backlogPath } from '../../lib/backlog-path';
import { etaText } from '../../lib/eta-words';
import { phaseLabel } from '../../lib/phase-label';
import { useBacklogs } from '../backlogs';
import { RunStateIcon, phaseOf, runWord, toneColor } from '../run';
import { useOverviewRuns } from './use-overview-runs';

const SHOWN = 6;
const TICK_MS = 30_000;

interface Card {
  id: string;
  title: string;
  href: Route;
  /** Tasks merged and in all, for a milestone or an epic. */
  tasks?: { merged: number; total: number };
  /** The step a run is at, in words. */
  step?: string;
  run?: RunSummary;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function runCard(run: RunSummary): Card {
  const counts = run.taskCounts;
  const total = Object.values(counts ?? {}).reduce((sum, value) => sum + value, 0);
  return {
    id: run.key,
    title: run.title,
    href: `/runs/${encodeURIComponent(run.key)}` as Route,
    run,
    ...(counts ? { tasks: { merged: counts.merged ?? 0, total } } : { step: phaseLabel(phaseOf(run.currentStep)) }),
  };
}

function CardView({ card, now }: { card: Card; now: number }): ReactElement {
  const view = card.run ? runWord(card.run) : null;
  const eta = card.run?.eta ? etaText(card.run.eta, now) : null;
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
      {card.step ? <Typography variant="body2">{card.step}</Typography> : null}
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

/** What works now: active milestones, then top-level runs and epics that move by themselves. */
export function NowSection(): ReactElement {
  const { loaded, active } = useOverviewRuns();
  const { backlogs } = useBacklogs();
  const now = useNow();
  const milestones: Card[] = backlogs.flatMap((backlog) =>
    backlog.milestones
      .filter((milestone) => milestone.status === 'active')
      .map((milestone) => {
        const tasks = backlog.tasks.filter((task) => task.milestone === milestone.number);
        return {
          id: `${backlog.name}/${milestone.number}`,
          title: milestone.title,
          href: backlogPath(backlog.name),
          tasks: { merged: tasks.filter((task) => task.status === 'merged').length, total: tasks.length },
        };
      }),
  );
  const working = nested(active)
    .tops.filter((run) => !run.backlog && runWord(run).tone === 'working')
    .map(runCard);
  const cards = [...milestones, ...working].slice(0, SHOWN);
  return (
    <Box component="section" aria-label="Now" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2" component="h2">
          Now
        </Typography>
        <Link href="/">All runs</Link>
      </Box>
      {!loaded ? (
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} variant="rounded" height={84} data-testid="now-placeholder" />
          ))}
        </Box>
      ) : cards.length === 0 ? (
        <Typography color="text.secondary">Nothing running</Typography>
      ) : (
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          {cards.map((card) => (
            <CardView key={card.id} card={card} now={now} />
          ))}
        </Box>
      )}
    </Box>
  );
}
