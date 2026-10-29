'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import DataUsage from '@mui/icons-material/DataUsage';
import MemoryIcon from '@mui/icons-material/Memory';
import Paid from '@mui/icons-material/Paid';
import Schedule from '@mui/icons-material/Schedule';
import Speed from '@mui/icons-material/Speed';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Tooltip from '@mui/material/Tooltip';
import { api } from '../../lib/api';
import { NewRunDialog } from '../new-run-dialog';
import { duration, memory, money, tokens } from '../../lib/format';
import { liveSocket } from '../../lib/live';
import { expandReviewPhases, keepOpenReviews, latestPhaseLabels, markReviewFinished, markReviewLive, PHASES, PhaseName, pipelineStep, replaySelection, REVIEW_STEPS, reviewChipName } from '../../lib/phases';
import { reviewChipStatus } from '../../lib/readable-log';
import { FlowView } from '../../lib/types';
import { statusColor } from '../../theme/theme';
import { FlowBoard } from './flow-board';
import { StepDetail } from './step-detail';
import { WaitingPanel } from './waiting-panel';

export function RunScreen({ runKey }: { runKey: string }) {
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const [rebaseError, setRebaseError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [replay, setReplay] = useState<string | null>(null);
  const [pending, setPending] = useState<{ prompt: string; phases: PhaseName[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const pinnedAt = useRef<string | null>(null);
  const followStep = useRef(true);
  const heldMs = useRef(0);
  const heldStart = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    const openReviews = new Set<string>();
    const apply = (body: FlowView | null): void => {
      if (stopped || !body || body.key !== runKey) {
        return;
      }
      setFlow((current) => {
        if (pinnedAt.current && body.updatedAt === pinnedAt.current && current?.status === 'running' && body.status === 'waiting') {
          return current;
        }
        pinnedAt.current = null;
        if (heldMs.current > 0 && visitStored(body.metrics.closedStarts, heldStart.current)) {
          heldMs.current = 0;
          heldStart.current = null;
        }
        if (body.status !== 'running' || body.currentStep !== 'code-review') {
          openReviews.clear();
        }
        const phases = keepOpenReviews(body.phases, openReviews);
        for (const phase of phases) {
          for (const step of phase.steps) {
            if (step.status === 'done' || step.status === 'waiting') {
              openReviews.delete(step.name);
            }
          }
        }
        return { ...body, phases };
      });
      setError(null);
      void probeFinishedReviews(body, runKey, (name, status) => {
        if (openReviews.has(name)) {
          return;
        }
        setFlow((current) => (current?.key === runKey ? { ...current, phases: markReviewFinished(current.phases, name, status) } : current));
      });
    };
    const load = (): void => {
      api<FlowView>(`/runs/${encodeURIComponent(runKey)}`)
        .then(apply)
        .catch((cause: unknown) => {
          if (!stopped) {
            setError(cause instanceof Error ? cause.message : 'run is missing');
          }
        });
    };
    const socket = liveSocket();
    const watch = (): void => {
      socket.emit('watch', runKey);
    };
    const onLog = (entry: { key: string; step: string; body: string }): void => {
      if (stopped || entry.key !== runKey || !entry.step.startsWith('code-review-')) {
        return;
      }
      const chip = reviewChipName(entry.step);
      const status = reviewChipStatus(entry.body);
      const trimmed = entry.body.trim();
      if (status) {
        openReviews.delete(chip);
      } else if (trimmed !== '' && trimmed !== 'waiting for output' && trimmed !== 'starting') {
        openReviews.add(chip);
      }
      setFlow((current) => {
        if (!current) {
          return current;
        }
        if (status) {
          return { ...current, phases: markReviewFinished(current.phases, chip, status) };
        }
        if (current.status !== 'running' || current.currentStep !== 'code-review' || trimmed === '' || trimmed === 'waiting for output' || trimmed === 'starting') {
          return current;
        }
        return { ...current, phases: markReviewLive(current.phases, chip) };
      });
    };
    socket.on('connect', watch);
    socket.on('flow', apply);
    socket.on('log', onLog);
    watch();
    load();
    return () => {
      stopped = true;
      socket.off('connect', watch);
      socket.off('flow', apply);
      socket.off('log', onLog);
    };
  }, [runKey]);

  useEffect(() => {
    if (flow?.status !== 'running') {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [flow?.status]);

  useEffect(() => {
    if (flow && followStep.current) {
      setSelected((current) => {
        if (flow.currentStep === 'code-review') {
          return current && pipelineStep(current) === 'code-review' ? current : REVIEW_STEPS[0];
        }
        return flow.currentStep;
      });
    }
  }, [flow]);

  if (!flow) {
    return <Typography color={error ? 'error' : 'text.secondary'}>{error ?? 'Loading the run.'}</Typography>;
  }

  const metric = flow.metrics;
  const gap = heldMs.current > 0 && !visitStored(metric.closedStarts, heldStart.current);
  const staleStart = gap && flow.stepStartedAt !== null && flow.stepStartedAt === heldStart.current;
  const live = flow.status === 'running' && flow.stepStartedAt && !staleStart ? openElapsed(flow.stepStartedAt, now) : 0;
  const openMs = live + (gap ? heldMs.current : 0);
  const metricItems: { Icon?: typeof Schedule; text: string; tip: string; color?: string }[] = [
    { text: metric.status, tip: 'Run status', color: statusColor(metric.status) },
    {
      Icon: Schedule,
      text: duration(metric.durationMs + openMs),
      tip: 'Total time the steps have run. Reviewers that run together count as the slowest one, then the report and the remaining time in that step. Time waiting on a person, and time sitting idle after a failure, is not included.',
    },
    { Icon: Paid, text: money(metric.usd), tip: 'Session spend' },
    { Icon: DataUsage, text: `${tokens(metric.tokens)} tok`, tip: 'Session tokens' },
    { Icon: Speed, text: `cpu ${metric.cpuPeak.toFixed(0)}%`, tip: 'Highest CPU in the session' },
    { Icon: MemoryIcon, text: `mem ${memory(metric.memPeak)}`, tip: 'Highest memory in the session' },
  ];
  const phases = expandReviewPhases(flow.phases);
  const runningElsewhere = flow.status === 'running' && replay !== null && pipelineStep(flow.currentStep) !== pipelineStep(replay);
  const launches = flow.launches ?? [];
  const original = launches.find((launch) => launch.fromStep === null)?.phases ?? [...PHASES];
  const latest = launches.at(-1)?.phases ?? original;
  const choice = replay ? replaySelection(original, latest, replay) : null;
  const stopRun = (): void => {
    setStopping(true);
    setError(null);
    api(`/runs/${encodeURIComponent(flow.key)}/stop`, { method: 'POST' })
      .then(() => {
        setConfirmStop(false);
        setFlow((current) => {
          if (!current) {
            return current;
          }
          heldMs.current = current.stepStartedAt ? openElapsed(current.stepStartedAt, Date.now()) : 0;
          heldStart.current = current.stepStartedAt;
          return { ...current, status: 'failed', resume: 'ready' };
        });
        setNow(Date.now());
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'stop failed'))
      .finally(() => setStopping(false));
  };
  const rebaseRun = (): void => {
    setRebasing(true);
    setRebaseError(null);
    api(`/runs/${encodeURIComponent(flow.key)}/rebase`, { method: 'POST' })
      .then(() => {
        followStep.current = true;
        setFlow((current) =>
          current
            ? {
                ...current,
                status: 'running',
                resume: 'running',
                stepStartedAt: null,
                currentStep: current.status === 'done' ? 'code-review' : current.currentStep,
              }
            : current,
        );
      })
      .catch((cause: unknown) => setRebaseError(cause instanceof Error ? cause.message : 'rebase failed'))
      .finally(() => setRebasing(false));
  };
  const startReplay = (step: string, prompt: string, phases: PhaseName[]): Promise<void> =>
    api(`/runs/${encodeURIComponent(flow.key)}/steps/${encodeURIComponent(step)}/replay`, {
      method: 'POST',
      body: JSON.stringify({ prompt, phases }),
    }).then(() => {
      followStep.current = true;
      setSelected(step);
      pinnedAt.current = flow.updatedAt;
      setFlow((current) => (current ? { ...current, status: 'running', currentStep: step, resume: 'running', stepStartedAt: null } : current));
      setReplay(null);
      setPending(null);
    });
  const startReviewer = (step: string): void => {
    setError(null);
    api(`/runs/${encodeURIComponent(flow.key)}/steps/${encodeURIComponent(step)}`, { method: 'POST' })
      .then(() => {
        followStep.current = true;
        setSelected(step);
        pinnedAt.current = flow.updatedAt;
        setFlow((current) => (current ? { ...current, status: 'running', currentStep: 'code-review', resume: 'running', stepStartedAt: null } : current));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'start failed'));
  };
  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Tooltip title={flow.name}>
            <Typography variant="h5" noWrap>
              {flow.name}
            </Typography>
          </Tooltip>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} color="text.secondary">
              {flow.key}
            </Typography>
            {flow.projects.map((project) => (
              <Chip key={project} size="small" variant="outlined" label={project} sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
            ))}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          {flow.status === 'failed' || flow.status === 'done' || flow.status === 'waiting' ? (
            <Button variant="outlined" disabled={rebasing} onClick={rebaseRun}>
              Rebase
            </Button>
          ) : null}
          {flow.status === 'running' ? (
            <Button color="error" variant="outlined" disabled={stopping} onClick={() => setConfirmStop(true)}>
              Stop
            </Button>
          ) : null}
          <Button component={Link} href={`/runs/${flow.key}/history`} color="inherit">
            All history
          </Button>
        </Box>
      </Box>
      {rebaseError ? (
        <Typography color="error" variant="body2" sx={{ mt: 1 }}>
          {rebaseError}
        </Typography>
      ) : null}
      <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 2, rowGap: 0.75, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'text.secondary' }}>
        {metricItems.map(({ Icon, text, tip, color }) => (
          <Tooltip key={tip} title={tip}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color }}>
              {Icon ? <Icon sx={{ fontSize: 16 }} /> : null}
              {text}
            </Box>
          </Tooltip>
        ))}
      </Box>
      {launches.length > 0 ? (
        <Box sx={{ mt: 0.75, display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {latestPhaseLabels(launches).map((label) => (
            <Chip key={label} size="small" variant="outlined" label={label} sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          ))}
        </Box>
      ) : null}
      <FlowBoard
        phases={phases}
        returns={flow.returns}
        selected={selected}
        onSelect={(name) => {
          followStep.current = pipelineStep(name) === flow.currentStep;
          setSelected(name);
        }}
      />
      {flow.status === 'waiting' || flow.status === 'blocked' || flow.status === 'failed' ? (
        <WaitingPanel
          flow={flow}
          onChange={(next) => {
            if (next.status === 'running') {
              followStep.current = true;
              pinnedAt.current = next.updatedAt;
            }
            setFlow(next);
          }}
        />
      ) : null}
      {selected ? (
        <StepDetail
          key={selected}
          runKey={flow.key}
          step={selected}
          live={flow.status === 'running' && pipelineStep(selected) === flow.currentStep}
          revision={flow.updatedAt}
          attempts={phases.flatMap((phase) => phase.steps).find((step) => step.name === selected)?.attempts ?? 0}
          now={now}
          onReplay={
            selected === 'code-review' || flow.status === 'running'
              ? undefined
              : (REVIEW_STEPS as readonly string[]).includes(selected)
                ? () => startReviewer(selected)
                : () => setReplay(pipelineStep(selected))
          }
          runStatus={pipelineStep(selected) === flow.currentStep ? flow.status : undefined}
          onResume={
            pipelineStep(selected) === flow.currentStep &&
            (flow.status === 'failed' || flow.status === 'blocked') &&
            flow.resume === 'ready'
              ? () => {
                  api(`/runs/${encodeURIComponent(flow.key)}/resume`, { method: 'POST' })
                    .then(() => {
                      followStep.current = true;
                      pinnedAt.current = flow.updatedAt;
                      setFlow((current) => (current ? { ...current, status: 'running', resume: 'running', stepStartedAt: null } : current));
                    })
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'resume failed'));
                }
              : undefined
          }
        />
      ) : null}
      <NewRunDialog
        key={replay ?? 'closed'}
        open={replay !== null && pending === null}
        title={replay ?? 'New run'}
        selected={choice?.selected}
        locked={choice?.locked}
        lockedProjects={flow.projects ?? []}
        runKey={flow.key}
        onProjects={(projects) => setFlow((current) => (current ? { ...current, projects } : current))}
        onClose={() => setReplay(null)}
        onSubmit={async (prompt, phases) => {
          if (!replay) {
            return;
          }
          if (runningElsewhere) {
            setPending({ prompt, phases });
            return 'hold';
          }
          await startReplay(replay, prompt, phases);
        }}
      />
      <Dialog open={confirmStop} onClose={() => (stopping ? undefined : setConfirmStop(false))} fullWidth maxWidth="xs">
        <DialogTitle>Stop {flow.currentStep}?</DialogTitle>
        <DialogContent>
          <Typography>The agent for {flow.key} is killed and this run is marked failed. Files already written stay in the worktree.</Typography>
          {error ? (
            <Typography color="error" variant="body2" sx={{ mt: 1 }}>
              {error}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmStop(false)} disabled={stopping}>
            Keep running
          </Button>
          <Button color="error" variant="contained" disabled={stopping} onClick={stopRun}>
            Stop
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={pending !== null} onClose={() => setPending(null)} fullWidth maxWidth="sm">
        <DialogTitle>Stop {flow.currentStep}?</DialogTitle>
        <DialogContent>
          <Typography>
            {flow.currentStep} is running. Starting {replay} again stops it.
          </Typography>
          {error ? (
            <Typography color="error" variant="body2" sx={{ mt: 1 }}>
              {error}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPending(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (replay && pending) {
                startReplay(replay, pending.prompt, pending.phases).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'replay failed'));
              }
            }}
          >
            Stop and start
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function visitStored(starts: readonly string[], heldStart: string | null): boolean {
  return heldStart !== null && starts.includes(heldStart);
}

function openElapsed(startedAt: string | null, now: number): number {
  if (!startedAt) {
    return 0;
  }
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

async function probeFinishedReviews(flow: FlowView, runKey: string, mark: (name: string, status: string) => void): Promise<void> {
  const names = flow.phases
    .flatMap((phase) => phase.steps)
    .filter((step) => step.name.startsWith('code-review-') && step.status === 'running')
    .map((step) => step.name);
  await Promise.all(
    names.map(async (name) => {
      try {
        const response = await fetch(`/run-logs/${runKey}-${name}-output.txt`, { cache: 'no-store' });
        if (!response.ok) {
          return;
        }
        const status = reviewChipStatus(await response.text());
        if (status) {
          mark(name, status);
        }
      } catch {
        // nest still owns the live board until the next rebuild
      }
    }),
  );
}
