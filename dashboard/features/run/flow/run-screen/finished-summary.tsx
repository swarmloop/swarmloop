'use client';

import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { FlowView, StepView } from '@contract/api';
import { epicFigures } from '@contract/epic-figures';
import { MarkdownBody } from '../../../../components/ui/markdown-body';
import { duration, money } from '../../../../lib/format';
import { useStep } from '../../use-step';

/** The review report of a finished run: the one rendered from its state, else the latest stored one. */
function reportOf(view: StepView): string | null {
  if (view.report) {
    return view.report;
  }
  for (const visit of [...view.visits].reverse()) {
    const document = visit.documents.find((item) => item.kind === 'review_report');
    if (document) {
      return document.body;
    }
  }
  return null;
}

/** What a finished run shows in place of a step: its review report and its cost, with `tasks` for a split run. */
export function FinishedSummary({ flow, tasks }: { flow: FlowView; tasks?: ReactNode }): ReactElement {
  const { view, error, loading, retry } = useStep(flow.key, 'code-review', false, flow.updatedAt, 0);
  const cost = flow.epic
    ? epicFigures(
        {
          epicUsd: flow.epic.usd,
          ownUsd: flow.metrics.usd,
          epicMs: flow.epic.durationMs,
          taskCount: flow.tasks?.length ?? 0,
          workedMs: null,
        },
        { money, duration },
      ).money
    : money(flow.metrics.usd);
  const report = view ? reportOf(view) : null;
  return (
    <Box component="section" aria-label="Summary" sx={{ my: 2, display: 'grid', gap: 1.5, minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">{`Cost ${cost}`}</Typography>
      {error ? (
        <Box>
          <Typography color="error">{`The review report could not be loaded: ${error}`}</Typography>
          <Button onClick={retry}>Retry</Button>
        </Box>
      ) : loading || !view ? (
        <Skeleton variant="rounded" height={160} />
      ) : report ? (
        <MarkdownBody text={report} />
      ) : (
        <Typography color="text.secondary">The review report is not available.</Typography>
      )}
      {tasks}
    </Box>
  );
}
