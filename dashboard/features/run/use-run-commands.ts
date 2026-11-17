'use client';

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useState } from 'react';
import {
  rebaseRun as rebaseEndpoint,
  replayStep,
  resumeRun as resumeEndpoint,
  startReviewer as reviewerEndpoint,
  stopRun as stopEndpoint,
} from '../../lib/endpoints';
import { openElapsed } from '../../lib/elapsed';
import { inState } from '../../lib/run-actions';
import type { FlowMemory } from './flow-state';
import type { PhaseName } from '@contract/steps';
import type { FlowView, ReplayBody } from '@contract/api';

/** What the commands read and write of the run screen's state. */
interface CommandContext {
  flow: FlowView | null;
  setFlow: Dispatch<SetStateAction<FlowView | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNow: Dispatch<SetStateAction<number>>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setConfirmStop: Dispatch<SetStateAction<boolean>>;
  setReplay: Dispatch<SetStateAction<string | null>>;
  setPending: Dispatch<SetStateAction<{ prompt: string; phases: PhaseName[] } | null>>;
  memory: MutableRefObject<FlowMemory>;
  followStep: MutableRefObject<boolean>;
}

/** The commands of a run (stop, rebase, replay, reviewer, resume) with their busy and error state. */
export function useRunCommands({
  flow,
  setFlow,
  setError,
  setNow,
  setSelected,
  setConfirmStop,
  setReplay,
  setPending,
  memory,
  followStep,
}: CommandContext): {
  stopping: boolean;
  rebasing: boolean;
  rebaseError: string | null;
  stopRun: () => void;
  rebaseRun: () => void;
  startReplay: (step: string, prompt: string, phases: PhaseName[]) => Promise<void>;
  startReviewer: (step: string) => void;
  resumeRun: () => void;
} {
  const [stopping, setStopping] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const [rebaseError, setRebaseError] = useState<string | null>(null);

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
          return { ...inState(current, 'stopped'), status: 'failed', resume: 'ready' };
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
                ...inState(current, 'running'),
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
          ? {
              ...inState(current, 'running'),
              status: 'running',
              currentStep: step,
              resume: 'running',
              stepStartedAt: null,
            }
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
            ? {
                ...inState(current, 'running'),
                status: 'running',
                currentStep: 'code-review',
                resume: 'running',
                stepStartedAt: null,
              }
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
          current
            ? { ...inState(current, 'running'), status: 'running', resume: 'running', stepStartedAt: null }
            : current,
        );
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'resume failed'));
  };

  return { stopping, rebasing, rebaseError, stopRun, rebaseRun, startReplay, startReviewer, resumeRun };
}
