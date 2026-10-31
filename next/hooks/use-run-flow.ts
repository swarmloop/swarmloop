'use client';

import { useEffect, useRef, useState } from 'react';
import { api, runLog } from '../lib/api';
import { openElapsed, visitStored } from '../lib/elapsed';
import { liveSocket } from '../lib/live';
import { keepOpenReviews, markReviewFinished, markReviewLive, pipelineStep, REVIEW_STEPS, reviewChipName, type PhaseName } from '../lib/phases';
import { reviewChipStatus } from '../lib/readable-log';
import { FlowView } from '../lib/types';

export function useRunFlow(runKey: string) {
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

  let openMs = 0;
  if (flow) {
    const gap = heldMs.current > 0 && !visitStored(flow.metrics.closedStarts, heldStart.current);
    const staleStart = gap && flow.stepStartedAt !== null && flow.stepStartedAt === heldStart.current;
    const live = flow.status === 'running' && flow.stepStartedAt && !staleStart ? openElapsed(flow.stepStartedAt, now) : 0;
    openMs = live + (gap ? heldMs.current : 0);
  }

  const selectStep = (name: string): void => {
    if (!flow) {
      return;
    }
    followStep.current = pipelineStep(name) === flow.currentStep;
    setSelected(name);
  };

  const applyWaiting = (next: FlowView): void => {
    if (next.status === 'running') {
      followStep.current = true;
      pinnedAt.current = next.updatedAt;
    }
    setFlow(next);
  };

  const stopRun = (): void => {
    if (!flow) {
      return;
    }
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
    if (!flow) {
      return;
    }
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

  const startReplay = (step: string, prompt: string, phases: PhaseName[]): Promise<void> => {
    if (!flow) {
      return Promise.resolve();
    }
    const run = flow;
    return api(`/runs/${encodeURIComponent(run.key)}/steps/${encodeURIComponent(step)}/replay`, {
      method: 'POST',
      body: JSON.stringify({ prompt, phases }),
    }).then(() => {
      followStep.current = true;
      setSelected(step);
      pinnedAt.current = run.updatedAt;
      setFlow((current) => (current ? { ...current, status: 'running', currentStep: step, resume: 'running', stepStartedAt: null } : current));
      setReplay(null);
      setPending(null);
    });
  };

  const startReviewer = (step: string): void => {
    if (!flow) {
      return;
    }
    const run = flow;
    setError(null);
    api(`/runs/${encodeURIComponent(run.key)}/steps/${encodeURIComponent(step)}`, { method: 'POST' })
      .then(() => {
        followStep.current = true;
        setSelected(step);
        pinnedAt.current = run.updatedAt;
        setFlow((current) => (current ? { ...current, status: 'running', currentStep: 'code-review', resume: 'running', stepStartedAt: null } : current));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'start failed'));
  };

  const resumeRun = (): void => {
    if (!flow) {
      return;
    }
    const run = flow;
    api(`/runs/${encodeURIComponent(run.key)}/resume`, { method: 'POST' })
      .then(() => {
        followStep.current = true;
        pinnedAt.current = run.updatedAt;
        setFlow((current) => (current ? { ...current, status: 'running', resume: 'running', stepStartedAt: null } : current));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'resume failed'));
  };

  return {
    flow,
    setFlow,
    error,
    setError,
    stopping,
    rebasing,
    rebaseError,
    confirmStop,
    setConfirmStop,
    replay,
    setReplay,
    pending,
    setPending,
    selected,
    now,
    openMs,
    selectStep,
    applyWaiting,
    stopRun,
    rebaseRun,
    startReplay,
    startReviewer,
    resumeRun,
  };
}

async function probeFinishedReviews(flow: FlowView, runKey: string, mark: (name: string, status: string) => void): Promise<void> {
  const names = flow.phases
    .flatMap((phase) => phase.steps)
    .filter((step) => step.name.startsWith('code-review-') && step.status === 'running')
    .map((step) => step.name);
  await Promise.all(
    names.map(async (name) => {
      try {
        const raw = await runLog(runKey, name);
        if (raw === null) {
          return;
        }
        const status = reviewChipStatus(raw);
        if (status) {
          mark(name, status);
        }
      } catch {
        // nest still owns the live board until the next rebuild
      }
    }),
  );
}
