'use client';

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  rebaseRun as rebaseEndpoint,
  replayStep,
  resumeRun as resumeEndpoint,
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
  setReplay: Dispatch<SetStateAction<string | null>>;
  setPending: Dispatch<SetStateAction<{ prompt: string; phases: PhaseName[] } | null>>;
  memory: MutableRefObject<FlowMemory>;
  followStep: MutableRefObject<boolean>;
}

/** The commands of a run (stop, rebase, replay, resume). Stop, rebase and replay return their promise, so the confirm that asked for them shows a failure. */
export function useRunCommands({
  flow,
  setFlow,
  setError,
  setNow,
  setSelected,
  setReplay,
  setPending,
  memory,
  followStep,
}: CommandContext): {
  stopRun: () => Promise<void>;
  rebaseRun: () => Promise<void>;
  startReplay: (step: string, prompt: string, phases: PhaseName[], attachments?: string[]) => Promise<void>;
  resumeRun: () => void;
} {
  const stopRun = (): Promise<void> => {
    if (!flow) {
      return Promise.resolve();
    }
    return stopEndpoint(flow.key).then(() => {
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
    });
  };

  const rebaseRun = (): Promise<void> => {
    if (!flow) {
      return Promise.resolve();
    }
    return rebaseEndpoint(flow.key).then(() => {
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
    });
  };

  const startReplay = (step: string, prompt: string, phases: PhaseName[], attachments?: string[]): Promise<void> => {
    if (!flow) {
      return Promise.resolve();
    }
    const run = flow;
    return replayStep(run.key, step, {
      prompt,
      phases,
      ...(attachments ? { attachments } : {}),
    } satisfies ReplayBody).then(() => {
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

  return { stopRun, rebaseRun, startReplay, resumeRun };
}
