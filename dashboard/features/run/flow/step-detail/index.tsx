'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { PlanRevision } from '@contract/plan-chat';
import { useStep } from '../../use-step';
import { issueLinks, problemSummary } from '../../transcript/transcript-model';
import { slowestBeforeAttempt } from '../../transcript/prepared-wait';
import { useStepEvents } from '../../transcript/use-step-events';
import type { CheckCommandView } from '@contract/api';
import { commandSummary, liveCommands as withLive, visitCommands } from '../../check-commands';
import { stepText, visitChecks, windowLabel } from '../../step-view';
import { useVisitLog } from '../../use-visit-log';
import { StepDocuments } from './step-documents';
import { StepHeader } from './step-header';
import { StepNotice } from './step-notice';

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
  resumeTip,
  attempts,
  liveCommands,
  restartedAt,
  planRevision,
  returnWords,
  boardStatus,
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
  resumeTip?: string;
  attempts: number;
  /** The rows of the latest checks attempt from the live flow: they replace the step view's rows of that attempt. */
  liveCommands?: CheckCommandView[];
  /** When the server restarted while this step's agent kept running; set only during that wait. */
  restartedAt?: string;
  /** For the plan step: the latest plan change, marked in the plan checklist. */
  planRevision?: PlanRevision | null;
  /** Why this step sent work back, in words from the server. */
  returnWords?: string;
  /** The status of this step's chip on the board: `idle` over old visits means a relaunch will run it again. */
  boardStatus?: string;
}): React.ReactElement | null {
  const { view, attempt, setAttempt, error, loading, retry, follow } = useStep(runKey, step, live, revision, attempts);
  const [check, setCheck] = useState<string | null>(null);
  const running = view?.visits[attempt]?.status === 'running';
  const stored = useVisitLog(runKey, step, view?.visits[attempt]);
  const { events, error: eventsError } = useStepEvents(runKey, step, view?.eventsCursor ?? null, running);
  // The source of a returned issue is another step, so its events are read only when this step took a handoff.
  const received = events?.some((event) => event.kind === 'handoff.received') ?? false;
  const waited = (view?.visits[attempt]?.preparedMs ?? 0) > 30_000;
  const run = useStepEvents(runKey, null, received || waited ? (view?.eventsCursor ?? null) : null, running);
  const problems = useMemo(() => (events ? problemSummary(events) : null), [events]);
  const issues = useMemo(() => issueLinks(run.events ?? []), [run.events]);

  useEffect(() => {
    setCheck(null);
  }, [runKey, step]);

  if (error) {
    return (
      <Box sx={{ mt: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography color="error">{error}</Typography>
        <Button size="small" variant="outlined" onClick={retry}>
          Retry
        </Button>
      </Box>
    );
  }
  if (loading || !view) {
    return <Skeleton variant="rounded" height={240} aria-label="Loading the step" sx={{ mt: 3 }} />;
  }
  const visit = view.visits[attempt];
  const latest = attempt === view.visits.length - 1;
  const restartWait = Boolean(restartedAt) && latest && visit?.status === 'running';
  const label = windowLabel(restartWait, boardStatus, visit, latest, runStatus, step);
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
  const text = stepText(step, shownVisit, selected, checks, latest ? view.report : undefined);
  const logs = selected ? '' : text.logs || (stored.text ?? '');
  const { document } = text;
  const commands = view.commands ? visitCommands(withLive(view.commands, liveCommands), visit) : undefined;
  return (
    <Paper sx={{ mt: 3, p: 2.5, border: 1, borderColor: 'divider', minWidth: 0 }}>
      <StepHeader
        step={step}
        runStatus={runStatus}
        onReplay={onReplay}
        onResume={onResume}
        resumeLabel={resumeLabel}
        resumeTip={resumeTip}
        view={view}
        attempt={attempt}
        setAttempt={setAttempt}
        follow={follow}
        attempts={attempts}
        visit={visit}
        label={label}
        shownDuration={shownDuration}
        shownAttempt={shownAttempt}
        problemId={problems?.firstId ?? null}
        problemCount={problems?.count ?? 0}
        commands={commands ? commandSummary(commands, now) : undefined}
        preparing={live && !visit}
        slowestPrepared={
          waited && visit?.attemptId && run.events
            ? slowestBeforeAttempt(run.events, visit.attemptId, visit.preparedMs ?? 0)
            : null
        }
      />
      <StepNotice
        returnWords={returnWords}
        restartedAt={restartWait ? restartedAt : undefined}
        interruption={visit?.interruption}
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
          visits={view.visits}
          logs={logs}
          document={document}
          role={view.descriptor.agent}
          commands={commands}
          now={now}
          restarted={restartWait}
          planRevision={planRevision}
        />
      </Box>
    </Paper>
  );
}
