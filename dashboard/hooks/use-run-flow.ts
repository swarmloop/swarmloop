'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  getFlow,
  getRunLog,
  rebaseRun as rebaseEndpoint,
  replayStep,
  resumeRun as resumeEndpoint,
  startReviewer as reviewerEndpoint,
  stopRun as stopEndpoint,
} from '../lib/endpoints';
import { openElapsed, visitStored } from '../lib/elapsed';
import { useLiveActions, useLiveBridge } from './use-live-bridge';
import { applyFlow, applyReviewLog, type FlowMemory } from '../lib/flow-state';
import { pipelineStepOf, REVIEW_STEPS, type PhaseName } from '@contract/steps';
import { reviewChipStatus } from '@contract/readable-log';
import type { FlowView, ReplayBody } from '@contract/api';
import type { LiveLog } from '@contract/live';

export function useRunFlow(runKey: string): {
  flow: FlowView | null;
  setFlow: Dispatch<SetStateAction<FlowView | null>>;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  stopping: boolean;
  rebasing: boolean;
  rebaseError: string | null;
  confirmStop: boolean;
  setConfirmStop: Dispatch<SetStateAction<boolean>>;
  replay: string | null;
  setReplay: Dispatch<SetStateAction<string | null>>;
  pending: { prompt: string; phases: PhaseName[] } | null;
  setPending: Dispatch<SetStateAction<{ prompt: string; phases: PhaseName[] } | null>>;
  selected: string | null;
  now: number;
  openMs: number;
  selectStep: (name: string) => void;
  applyWaiting: (next: FlowView) => void;
  stopRun: () => void;
  rebaseRun: () => void;
  startReplay: (step: string, prompt: string, phases: PhaseName[]) => Promise<void>;
  startReviewer: (step: string) => void;
  resumeRun: () => void;
} {
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const [rebaseError, setRebaseError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [replay, setReplay] = useState<string | null>(null);
  const [pending, setPending] = useState<{ prompt: string; phases: PhaseName[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const memory = useRef<FlowMemory>({ pinnedAt: null, heldMs: 0, heldStart: null, openReviews: [] });
  const followStep = useRef(true);
  const [now, setNow] = useState(() => Date.now());
  const liveFlow = useLiveBridge((snapshot) => snapshot.flow);
  const logs = useLiveBridge((snapshot) => snapshot.logs);
  const { watchRun } = useLiveActions();

  const generation = useRef(0);
  const seenFlow = useRef<FlowView | null>(null);
  const seenLogs = useRef(new WeakSet<LiveLog>());

  const applyBody = (body: FlowView | null): void => {
    const mine = generation.current;
    if (!body || body.key !== runKey) {
      return;
    }
    setFlow((current) => {
      const result = applyFlow(current, body, memory.current);
      memory.current = result.memory;
      return result.flow;
    });
    setError(null);
    void probeFinishedReviews(body, runKey, (name, raw) => {
      if (generation.current !== mine || memory.current.openReviews.includes(name)) {
        return;
      }
      setFlow((current) => {
        if (current?.key !== runKey) {
          return current;
        }
        const result = applyReviewLog(current, memory.current, { key: runKey, step: name, body: raw });
        memory.current = result.memory;
        return result.flow;
      });
    });
  };

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    memory.current = { ...memory.current, openReviews: [] };
    watchRun(runKey);
    getFlow(runKey)
      .then((body) => {
        if (generation.current === mine) {
          applyBody(body);
        }
      })
      .catch((cause: unknown) => {
        if (generation.current === mine) {
          setError(cause instanceof Error ? cause.message : 'run is missing');
        }
      });
    return () => {
      generation.current += 1;
      watchRun(null);
    };
  }, [runKey]);

  useEffect(() => {
    const fresh = logs.filter((entry) => !seenLogs.current.has(entry));
    fresh.forEach((entry) => seenLogs.current.add(entry));
    const reviews = fresh.filter((entry) => entry.key === runKey && entry.step.startsWith('code-review-'));
    // Record the logs before the flow is applied, as before.
    for (const entry of reviews) {
      memory.current = applyReviewLog(null, memory.current, entry).memory;
    }
    if (liveFlow && liveFlow !== seenFlow.current) {
      seenFlow.current = liveFlow;
      applyBody(liveFlow);
    }
    for (const entry of reviews) {
      setFlow((current) => {
        const next = applyReviewLog(current, memory.current, entry);
        memory.current = next.memory;
        return next.flow;
      });
    }
  }, [liveFlow, logs, runKey]);

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
          return current && pipelineStepOf(current) === 'code-review' ? current : REVIEW_STEPS[0];
        }
        return flow.currentStep;
      });
    }
  }, [flow]);

  let openMs = 0;
  if (flow) {
    const gap = memory.current.heldMs > 0 && !visitStored(flow.metrics.closedStarts, memory.current.heldStart);
    const staleStart = gap && flow.stepStartedAt !== null && flow.stepStartedAt === memory.current.heldStart;
    const live =
      flow.status === 'running' && flow.stepStartedAt && !staleStart ? openElapsed(flow.stepStartedAt, now) : 0;
    openMs = live + (gap ? memory.current.heldMs : 0);
  }

  const selectStep = (name: string): void => {
    if (!flow) {
      return;
    }
    followStep.current = pipelineStepOf(name) === flow.currentStep;
    setSelected(name);
  };

  const applyWaiting = (next: FlowView): void => {
    if (next.status === 'running') {
      followStep.current = true;
      memory.current = { ...memory.current, pinnedAt: next.updatedAt };
    }
    setFlow(next);
  };

  const stopRun = (): void => {
    if (!flow) {
      return;
    }
    setStopping(true);
    setError(null);
    stopEndpoint(flow.key)
      .then(() => {
        setConfirmStop(false);
        setFlow((current) => {
          if (!current) {
            return current;
          }
          memory.current = {
            ...memory.current,
            heldMs: current.stepStartedAt ? openElapsed(current.stepStartedAt, Date.now()) : 0,
            heldStart: current.stepStartedAt,
          };
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
    rebaseEndpoint(flow.key)
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
    return replayStep(run.key, step, { prompt, phases } satisfies ReplayBody).then(() => {
      followStep.current = true;
      setSelected(step);
      memory.current = { ...memory.current, pinnedAt: run.updatedAt };
      setFlow((current) =>
        current
          ? { ...current, status: 'running', currentStep: step, resume: 'running', stepStartedAt: null }
          : current,
      );
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
    reviewerEndpoint(run.key, step)
      .then(() => {
        followStep.current = true;
        setSelected(step);
        memory.current = { ...memory.current, pinnedAt: run.updatedAt };
        setFlow((current) =>
          current
            ? { ...current, status: 'running', currentStep: 'code-review', resume: 'running', stepStartedAt: null }
            : current,
        );
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'start failed'));
  };

  const resumeRun = (): void => {
    if (!flow) {
      return;
    }
    const run = flow;
    resumeEndpoint(run.key)
      .then(() => {
        followStep.current = true;
        memory.current = { ...memory.current, pinnedAt: run.updatedAt };
        setFlow((current) =>
          current ? { ...current, status: 'running', resume: 'running', stepStartedAt: null } : current,
        );
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

async function probeFinishedReviews(
  flow: FlowView,
  runKey: string,
  mark: (name: string, raw: string) => void,
): Promise<void> {
  const names = flow.phases
    .flatMap((phase) => phase.steps)
    .filter((step) => step.name.startsWith('code-review-') && step.status === 'running')
    .map((step) => step.name);
  await Promise.all(
    names.map(async (name) => {
      try {
        const raw = await getRunLog(runKey, name);
        if (raw === null) {
          return;
        }
        const status = reviewChipStatus(raw);
        if (status) {
          mark(name, raw);
        }
      } catch {
        // the server still owns the live board until the next rebuild
      }
    }),
  );
}
