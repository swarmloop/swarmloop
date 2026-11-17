'use client';

import type { ReactElement } from 'react';
import type { PhaseName } from '@contract/steps';
import type { FlowView } from '@contract/api';
import { ConfirmDialog } from '../../../shell';

/** The confirms of Stop and of Replay. Replay asks after its instructions form; it is Stop and start when another step is running. */
export function RunDialogs({
  flow,
  confirmStop,
  setConfirmStop,
  pending,
  setPending,
  replay,
  runningElsewhere,
  stopRun,
  startReplay,
}: {
  flow: FlowView;
  confirmStop: boolean;
  setConfirmStop: (open: boolean) => void;
  pending: { prompt: string; phases: PhaseName[] } | null;
  setPending: (pending: { prompt: string; phases: PhaseName[] } | null) => void;
  replay: string | null;
  runningElsewhere: boolean;
  stopRun: () => Promise<void>;
  startReplay: (step: string, prompt: string, phases: PhaseName[]) => Promise<void>;
}): ReactElement {
  return (
    <>
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${flow.key}?`}
        body="The agent stops now. Its commits, its pushes and an open merge request stay, and CI on the host keeps running."
        verb="Stop"
        tone="danger"
        onConfirm={stopRun}
        onClose={() => setConfirmStop(false)}
      />
      <ConfirmDialog
        open={pending !== null}
        title={runningElsewhere ? `Stop ${flow.currentStep}?` : `Replay from ${replay}?`}
        body={
          runningElsewhere
            ? `${flow.currentStep} is running. It stops now, then ${replay} starts again.`
            : `Everything after ${replay} is done again. For a split run's plan, the subtasks are removed.`
        }
        verb={runningElsewhere ? 'Stop and start' : 'Replay'}
        tone="danger"
        onConfirm={() => (replay && pending ? startReplay(replay, pending.prompt, pending.phases) : Promise.resolve())}
        onClose={() => setPending(null)}
      />
    </>
  );
}
