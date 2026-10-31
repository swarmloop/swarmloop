'use client';

import { useEffect, useRef, useState } from 'react';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useStep } from '../../../hooks/use-step';
import { shownStatus, stepText, visitChecks } from '../../../lib/step-view';
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
  attempts: number;
}) {
  const { view, attempt, setAttempt, error, follow } = useStep(runKey, step, live, revision, attempts);
  const [check, setCheck] = useState<string | null>(null);
  const stick = useRef(true);
  const logBox = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCheck(null);
  }, [runKey, step]);

  useEffect(() => {
    const node = logBox.current;
    if (node && stick.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [view]);

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
  const label = visit ? shownStatus(visit.status, attempt === view.visits.length - 1, runStatus, step, visit.decision) : '';
  const shownDuration = visit?.status === 'running' ? Math.max(0, now - Date.parse(revision)) : (visit?.durationMs ?? 0);
  const shownAttempt = visit?.attempt ?? 0;
  const checks = visitChecks(visit);
  const shownChecks = checks.length > 0 ? checks : view.checks;
  const selected = shownChecks.find((item) => item.name === check);
  const { logs, document } = stepText(step, visit, selected, checks);
  return (
    <Paper sx={{ mt: 3, p: 2.5, border: 1, borderColor: 'divider' }}>
      <StepHeader
        step={step}
        runStatus={runStatus}
        onReplay={onReplay}
        onResume={onResume}
        view={view}
        attempt={attempt}
        setAttempt={setAttempt}
        follow={follow}
        attempts={attempts}
        visit={visit}
        label={label}
        shownDuration={shownDuration}
        shownAttempt={shownAttempt}
      />
      <StepDocuments
        shownChecks={shownChecks}
        check={check}
        setCheck={setCheck}
        visit={visit}
        logs={logs}
        document={document}
        logBox={logBox}
        stick={stick}
      />
    </Paper>
  );
}
