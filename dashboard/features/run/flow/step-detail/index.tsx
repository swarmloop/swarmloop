'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useStep } from '../../use-step';
import { firstProblemId, issueLinks } from '../../transcript/transcript-model';
import { useStepEvents } from '../../transcript/use-step-events';
import { commandSummary, visitCommands } from '../../check-commands';
import { shownStatus, stepText, visitChecks } from '../../step-view';
import { useVisitLog } from '../../use-visit-log';
import { StepDocuments } from './step-documents';
import { StepHeader } from './step-header';

export function StepDetail({
  runKey,
  step,
  live,
  revision,
  now,
  onReplay,
  runStatus,
  onResume,
  resumeLabel,
  attempts,
}: {
  runKey: string;
  step: string;
  live: boolean;
  revision: string;
  now: number;
  onReplay?: () => void;
  runStatus?: string;
  onResume?: () => void;
  resumeLabel?: string;
  attempts: number;
}): React.ReactElement | null {
  const { view, attempt, setAttempt, error, follow } = useStep(runKey, step, live, revision, attempts);
  const [check, setCheck] = useState<string | null>(null);
  const running = view?.visits[attempt]?.status === 'running';
  const stored = useVisitLog(runKey, step, view?.visits[attempt]);
  const { events, error: eventsError } = useStepEvents(runKey, step, view?.eventsCursor ?? null, running);
  // The source of a returned issue is another step, so its events are read only when this step took a handoff.
  const received = events?.some((event) => event.kind === 'handoff.received') ?? false;
  const run = useStepEvents(runKey, null, received ? (view?.eventsCursor ?? null) : null, running);
  const issues = useMemo(() => issueLinks(run.events ?? []), [run.events]);

  useEffect(() => {
    setCheck(null);
  }, [runKey, step]);

  if (error) {
    return (
      <Typography color="error" sx={{ mt: 3 }}>
        {error}
      </Typography>
    );
  }
  if (!view) {
    return null;
  }
  const visit = view.visits[attempt];
  const label = visit
    ? shownStatus(visit.status, attempt === view.visits.length - 1, runStatus, step, visit.decision)
    : '';
  const shownDuration =
    visit?.status === 'running' ? Math.max(0, now - Date.parse(revision)) : (visit?.durationMs ?? 0);
  const shownAttempt = visit?.attempt ?? 0;
  const checks = visitChecks(visit);
  const shownChecks = checks.length > 0 ? checks : view.checks;
  const selected = shownChecks.find((item) => item.name === check);
  // A step that recorded events shows its errors and returns in the transcript, not as documents.
  const recorded = events !== null && events.length > 0;
  const shownVisit =
    recorded && visit
      ? { ...visit, documents: visit.documents.filter((item) => item.kind !== 'error' && item.kind !== 'return') }
      : visit;
  const text = stepText(step, shownVisit, selected, checks);
  const logs = selected ? '' : text.logs || (stored.text ?? '');
  const { document } = text;
  const commands = view.commands ? visitCommands(view.commands, visit) : undefined;
  return (
    <Paper sx={{ mt: 3, p: 2.5, border: 1, borderColor: 'divider', minWidth: 0 }}>
      <StepHeader
        step={step}
        runStatus={runStatus}
        onReplay={onReplay}
        onResume={onResume}
        resumeLabel={resumeLabel}
        view={view}
        attempt={attempt}
        setAttempt={setAttempt}
        follow={follow}
        attempts={attempts}
        visit={visit}
        label={label}
        shownDuration={shownDuration}
        shownAttempt={shownAttempt}
        problemId={events ? firstProblemId(events) : null}
        commands={commands ? commandSummary(commands, now) : undefined}
      />
      {eventsError ? (
        <Typography color="error" sx={{ mt: 2 }}>
          {eventsError}
        </Typography>
      ) : null}
      <Box
        onScrollCapture={(event) => {
          if (event.target instanceof HTMLElement && event.target.scrollTop === 0) {
            stored.loadEarlier();
          }
        }}
      >
        <StepDocuments
          runKey={runKey}
          events={eventsError ? [] : events}
          issues={issues}
          shownChecks={shownChecks}
          check={check}
          setCheck={setCheck}
          visit={visit}
          logs={logs}
          document={document}
          role={view.descriptor.agent}
          commands={commands}
          now={now}
        />
      </Box>
    </Paper>
  );
}
