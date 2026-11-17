'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import { getFlow, getRunLog } from '../../lib/endpoints';
import { openElapsed, visitStored } from '../../lib/elapsed';
import { useLiveActions, useLiveBridge } from '../shell';
import { useRunCommands } from './use-run-commands';
import { applyFlow, applyReviewLog, type FlowMemory } from './flow-state';
import { pipelineStepOf, REVIEW_STEPS, type PhaseName } from '@contract/steps';
import { reviewChipStatus } from '@contract/readable-log-review';
import type { FlowView } from '@contract/api';
import type { LiveLog } from '@contract/live';

export function useRunFlow(runKey: string): {
  flow: FlowView | null;
  setFlow: Dispatch<SetStateAction<FlowView | null>>;
  error: string | null;
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
  /** Fetch the run again, for the Retry of a failed load. */
  reload: () => void;
  applyWaiting: (next: FlowView) => void;
  stopRun: () => Promise<void>;
  rebaseRun: () => Promise<void>;
  startReplay: (step: string, prompt: string, phases: PhaseName[]) => Promise<void>;
  startReviewer: (step: string) => Promise<void>;
  resumeRun: () => void;
} {
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [replay, setReplay] = useState<string | null>(null);
  const [pending, setPending] = useState<{ prompt: string; phases: PhaseName[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the load runs for a run key or a Retry, not for each render's callbacks
  }, [runKey, loads]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyBody is rebuilt every render; the effect follows the live data
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
        if (flow.status === 'done') {
          return null;
        }
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

  const reload = (): void => {
    setError(null);
    setLoads((count) => count + 1);
  };

  const commands = useRunCommands({
    flow,
    setFlow,
    setError,
    setNow,
    setSelected,
    setReplay,
    setPending,
    memory,
    followStep,
  });

  return {
    ...commands,
    flow,
    setFlow,
    error,
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
    reload,
    applyWaiting,
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
