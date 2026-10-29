'use client';

import { useEffect, useRef, useState } from 'react';
import DataUsage from '@mui/icons-material/DataUsage';
import MemoryIcon from '@mui/icons-material/Memory';
import Paid from '@mui/icons-material/Paid';
import Schedule from '@mui/icons-material/Schedule';
import Speed from '@mui/icons-material/Speed';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { statusColor } from '../../theme/theme';
import { SeriesChart } from '../charts/series';
import { MarkdownBody } from '../markdown-body';
import { api } from '../../lib/api';
import { duration } from '../../lib/format';
import { liveSocket } from '../../lib/live';
import { liveLogStep } from '../../lib/phases';
import { reviewChipStatus, usageFromLog } from '../../lib/readable-log';
import { StepMetricKind, stepMetrics } from '../../lib/step-metrics';
import { LogTranscript } from '../log-transcript';
import { StepView } from '../../lib/types';

const stepMetricIcon: Partial<Record<StepMetricKind, typeof Schedule>> = {
  duration: Schedule,
  spend: Paid,
  'tokens-in': DataUsage,
  'tokens-out': DataUsage,
  cpu: Speed,
  memory: MemoryIcon,
};

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
  const [view, setView] = useState<StepView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const follow = useRef(true);
  const stick = useRef(true);
  const latestLog = useRef<{ body: string; samples: StepView['visits'][number]['samples']; usage?: LiveUsage } | null>(null);
  const logBox = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    follow.current = true;
    setCheck(null);
    setView(null);
    setAttempt(0);
    setError(null);
  }, [runKey, step]);

  useEffect(() => {
    let stopped = false;
    latestLog.current = null;
    if (live) {
      follow.current = true;
    }
    api<StepView>(`/runs/${encodeURIComponent(runKey)}/steps/${encodeURIComponent(step)}`)
      .then((body) => {
        if (stopped) {
          return;
        }
        const running = body.visits.at(-1)?.status === 'running';
        const liveLog = latestLog.current;
        if (!running && !liveLog) {
          latestLog.current = null;
        }
        const fetched = running ? withFileUsage(body) : body;
        setView(liveLog ? withLog(fetched, liveLog.body, liveLog.samples, liveLog.usage) : fetched);
        setAttempt((current) => (follow.current ? Math.max(body.visits.length - 1, 0) : current));
        setError(null);
      })
      .catch(async (cause: unknown) => {
        if (stopped) {
          return;
        }
        if (step.startsWith('code-review-')) {
          try {
            const response = await fetch(`/run-logs/${runKey}-${step}-output.txt`, { cache: 'no-store' });
            if (response.ok) {
              const raw = await response.text();
              const fetched = withFileUsage(fileView(step, raw));
              setView(fetched);
              setAttempt(0);
              setError(null);
              return;
            }
          } catch {
            // nest will serve this step after it is rebuilt
          }
        }
        setError(cause instanceof Error ? cause.message : 'step failed');
      });
    return () => {
      stopped = true;
    };
  }, [runKey, step, live, revision, attempts]);

  useEffect(() => {
    const socket = liveSocket();
    const apply = (entry: { key: string; step: string; body: string; samples?: StepView['visits'][number]['samples']; usage?: LiveUsage }): void => {
      if (entry.key !== runKey || !liveLogStep(entry.step, step)) {
        return;
      }
      const samples = entry.samples ?? [];
      latestLog.current = { body: entry.body, samples, usage: entry.usage };
      setView((current) => (current ? withLog(current, entry.body, samples, entry.usage) : current));
    };
    socket.on('log', apply);
    return () => {
      socket.off('log', apply);
    };
  }, [runKey, step]);

  useEffect(() => {
    if (!live) {
      return;
    }
    follow.current = true;
    if (!view) {
      return;
    }
    const last = Math.max(view.visits.length - 1, 0);
    setAttempt((current) => (current === last ? current : last));
  }, [live]);

  useEffect(() => {
    if (!follow.current || !view) {
      return;
    }
    const last = Math.max(view.visits.length - 1, 0);
    setAttempt((current) => (current === last ? current : last));
  }, [view]);

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
  const logs = selected ? '' : (visit?.documents.filter((item) => item.kind === 'log').map((item) => item.body).join('\n') ?? '');
  const storedReport = step === 'code-review' ? visit?.documents.find((item) => item.kind === 'review_report')?.body : undefined;
  const report = reportAgrees(storedReport, visit?.decision) ? storedReport : undefined;
  const angleNotes = checks.map((item) => item.body).filter(Boolean);
  const document =
    selected?.body ??
      (report ||
      (angleNotes.length > 0 ? angleNotes.join('\n\n') : '') ||
      visit?.documents
        .filter((item) => item.kind !== 'log' && item.kind !== 'review_report')
        .map((item) => item.body)
        .filter(Boolean)
        .join('\n\n') ||
      '');
  return (
    <Paper sx={{ mt: 3, p: 2.5, border: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontFamily: 'var(--font-mono)' }}>
            {step === 'code-review' ? 'report' : step.startsWith('code-review-') ? step.slice('code-review-'.length) : step}
          </Typography>
          {!step.startsWith('code-review-') && (runStatus === 'failed' || runStatus === 'blocked') ? (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: statusColor(runStatus) }}>{runStatus}</Typography>
          ) : null}
          {onReplay && step !== 'done' ? (
            <Button size="small" variant="contained" onClick={onReplay}>
              Run again
            </Button>
          ) : null}
          {onResume ? (
            <Button size="small" variant="contained" onClick={onResume}>
              Resume
            </Button>
          ) : null}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {(view.visits.length > 1 || attempts > 0) && view.visits.map((item, index) => {
            const color = statusColor(shownStatus(item.status, index === view.visits.length - 1, runStatus, step, item.decision));
            return (
              <Button
                key={item.id}
                size="small"
                variant={index === attempt ? 'contained' : 'text'}
                onClick={() => {
                  follow.current = index === view.visits.length - 1;
                  setAttempt(index);
                }}
                sx={index === attempt ? { bgcolor: color, '&:hover': { bgcolor: color } } : { color }}
              >
                {item.attempt}
              </Button>
            );
          })}
        </Box>
      </Box>
      {visit ? (
        <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 2, rowGap: 0.75, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'text.secondary' }}>
          {stepMetrics({
            status: label,
            attempt: shownAttempt,
            durationMs: shownDuration,
            tokensIn: visit.tokensIn,
            tokensOut: visit.tokensOut,
            usd: visit.usd,
            cpuAvg: visit.cpuAvg,
            cpuPeak: visit.cpuPeak,
            memAvg: visit.memAvg,
            memPeak: visit.memPeak,
          }).map((item) => {
            const Icon = stepMetricIcon[item.kind];
            return (
              <Tooltip key={item.tip} title={item.tip}>
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: item.kind === 'status' ? statusColor(label) : undefined }}>
                  {Icon ? <Icon sx={{ fontSize: 16 }} /> : null}
                  {item.text}
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      ) : (
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          This step has not run.
        </Typography>
      )}
      {shownChecks.length > 0 ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
          {shownChecks.map((item) => {
            const tone = item.decision === 'decision: ok' ? 'done' : item.decision === 'decision: return' ? 'waiting' : '';
            return (
              <Button
                key={item.name}
                size="small"
                variant={item.name === check ? 'contained' : 'outlined'}
                onClick={() => setCheck(item.name)}
                sx={
                  tone
                    ? item.name === check
                      ? { bgcolor: statusColor(tone), '&:hover': { bgcolor: statusColor(tone) } }
                      : { color: statusColor(tone), borderColor: statusColor(tone) }
                    : undefined
                }
              >
                {item.name} {item.decision?.replace('decision: ', '') ?? ''}
              </Button>
            );
          })}
        </Box>
      ) : null}
      {visit && (visit.status === 'running' || visit.samples.length > 0) ? (
        <Box sx={{ mt: 2 }}>
          <SeriesChart samples={visit.samples} />
        </Box>
      ) : null}
      {logs ? (
        <Box
          ref={logBox}
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}
          sx={{ mt: 2, maxHeight: 520, overflow: 'auto' }}
        >
          <LogTranscript raw={logs} />
        </Box>
      ) : null}
      {document ? <MarkdownBody text={document} /> : null}
      {visit?.exchanges.map((exchange, index) => (
        <Accordion key={`${exchange.model}-${index}`} disableGutters elevation={0} sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'transparent' }}>
          <AccordionSummary>
            <Typography variant="body2">
              {exchange.model} · {duration(exchange.durationMs)}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="overline">Request</Typography>
            <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {exchange.request}
            </Typography>
            <Typography variant="overline">Response</Typography>
            <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {exchange.response}
            </Typography>
          </AccordionDetails>
        </Accordion>
      ))}
    </Paper>
  );
}

interface LiveUsage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

function fileView(step: string, body: string): StepView {
  const done = reviewChipStatus(body);
  return {
    step,
    checks: [],
    visits: [
      {
        id: -1,
        attempt: 1,
        status: done ?? 'running',
        model: null,
        mode: 'agent',
        durationMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        cpuAvg: 0,
        cpuPeak: 0,
        memAvg: 0,
        memPeak: 0,
        killReason: null,
        decision: null,
        documents: [{ kind: 'log', attempt: 1, body: body || 'waiting for output\n', createdAt: new Date().toISOString() }],
        exchanges: [],
        samples: [],
      },
    ],
  };
}

function withFileUsage(view: StepView): StepView {
  const visit = view.visits.at(-1);
  const log = visit?.documents.find((item) => item.kind === 'log')?.body;
  if (!visit || !log) {
    return view;
  }
  const reported = visit.tokensIn > 0 || visit.tokensOut > 0 || visit.usd > 0 ? { tokensIn: visit.tokensIn, tokensOut: visit.tokensOut, usd: visit.usd } : undefined;
  if (visit.status === 'running') {
    return withLog(view, log, visit.samples, reported);
  }
  const parsed = tokenUsage(log, reported);
  if (Object.keys(parsed).length === 0) {
    return view;
  }
  const visits = view.visits.slice();
  visits[visits.length - 1] = { ...visit, ...parsed };
  return { ...view, visits };
}

function withLog(view: StepView, body: string, samples: StepView['visits'][number]['samples'], reported?: LiveUsage): StepView {
  const index = view.visits.length - 1;
  const visit = view.visits[index];
  if (!visit) {
    return view;
  }
  if (visit.status !== 'running') {
    if (reviewChipStatus(body)) {
      if (samples.length === 0 || visit.samples.length > 0) {
        return view;
      }
      const visits = view.visits.slice();
      visits[index] = { ...visit, samples, ...usage(samples), ...tokenUsage(body, reported) };
      return { ...view, visits };
    }
    const attempt = visit.attempt + 1;
    const counted = tokenUsage(body, reported);
    const opened: StepView['visits'][number] = {
      ...visit,
      id: -1,
      attempt,
      status: reviewChipStatus(body) ?? 'running',
      durationMs: 0,
      killReason: null,
      decision: null,
      documents: [{ kind: 'log', attempt, body, createdAt: new Date().toISOString() }],
      exchanges: [],
      samples,
      ...usage(samples),
      ...counted,
    };
    if (!('tokensIn' in counted)) {
      opened.tokensIn = 0;
      opened.tokensOut = 0;
      opened.usd = 0;
    }
    return { ...view, visits: [...view.visits, opened] };
  }
  const documents = visit.documents.some((item) => item.kind === 'log')
    ? visit.documents.map((item) => (item.kind === 'log' ? { ...item, body } : item))
    : [...visit.documents, { kind: 'log', attempt: visit.attempt, body, createdAt: new Date().toISOString() }];
  const visits = view.visits.slice();
  visits[index] = {
    ...visit,
    documents,
    samples,
    status: visit.decision === 'decision: ok' && reviewChipStatus(body) === 'waiting' ? 'done' : (reviewChipStatus(body) ?? visit.status),
    ...usage(samples),
    ...tokenUsage(body, reported),
  };
  return { ...view, visits };
}

function visitChecks(visit: StepView['visits'][number] | undefined): StepView['checks'] {
  if (!visit) {
    return [];
  }
  return visit.documents
    .filter((item) => item.kind.startsWith('review_') && item.kind !== 'review_report' && item.kind !== 'review_residual')
    .map((item) => ({ name: item.kind.slice('review_'.length), decision: decisionLine(item.body), body: item.body }));
}

function reportAgrees(body: string | undefined, decision: string | null | undefined): boolean {
  if (!body) {
    return false;
  }
  const line = decisionLine(body);
  if (!line || !decision) {
    return true;
  }
  return line === decision;
}

function decisionLine(body: string): string | null {
  return (
    body
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item.startsWith('decision:'))
      .pop() ?? null
  );
}

function shownStatus(status: string, latest: boolean, runStatus?: string, step?: string, decision?: string | null): string {
  if (step?.startsWith('code-review') && status !== 'running') {
    if (decision === 'decision: ok') {
      return 'done';
    }
    if (decision === 'decision: return') {
      return 'waiting';
    }
  }
  if (step?.startsWith('code-review-') && (status === 'waiting' || status === 'failed')) {
    return status;
  }
  if (status === 'waiting' && !(latest && runStatus === 'waiting')) {
    return 'done';
  }
  return status;
}

function tokenUsage(body: string, reported?: LiveUsage): { tokensIn: number; tokensOut: number; usd: number } | Record<string, never> {
  const parsed = usageFromLog(body);
  const tokensIn = reported && reported.tokensIn > 0 ? reported.tokensIn : (parsed?.tokensIn ?? reported?.tokensIn);
  const tokensOut = reported && reported.tokensOut > 0 ? reported.tokensOut : (parsed?.tokensOut ?? reported?.tokensOut);
  if (tokensIn === undefined || tokensOut === undefined) {
    return {};
  }
  const usd = reported?.usd ?? 0;
  return { tokensIn, tokensOut, usd };
}

function usage(samples: { cpu: number; memory: number }[]): { cpuAvg: number; cpuPeak: number; memAvg: number; memPeak: number } {
  if (samples.length === 0) {
    return { cpuAvg: 0, cpuPeak: 0, memAvg: 0, memPeak: 0 };
  }
  const cpu = samples.map((sample) => sample.cpu);
  const memoryBytes = samples.map((sample) => sample.memory);
  const avg = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    cpuAvg: avg(cpu),
    cpuPeak: Math.max(...cpu),
    memAvg: Math.round(avg(memoryBytes)),
    memPeak: Math.max(...memoryBytes),
  };
}
