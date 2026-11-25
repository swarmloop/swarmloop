'use client';

import type { ReactElement } from 'react';
import type { PhaseName } from '@contract/steps';
import type { FlowView } from '@contract/api';
import { ConfirmDialog } from '../../../shell';
import { replayBody, stopAndStartBody, stopBody } from './confirm-texts';

/** The confirms of Stop and Replay. Replay asks after its instructions form; it is Stop and start when another step is running. */
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
  pending: { prompt: string; phases: PhaseName[]; attachments?: string[] } | null;
  setPending: (pending: { prompt: string; phases: PhaseName[]; attachments?: string[] } | null) => void;
  replay: string | null;
  runningElsewhere: boolean;
  stopRun: () => Promise<void>;
  startReplay: (step: string, prompt: string, phases: PhaseName[], attachments?: string[]) => Promise<void>;
}): ReactElement {
  return (
    <>
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${flow.key}?`}
        body={stopBody(flow)}
        verb="Stop"
        tone="danger"
        onConfirm={stopRun}
        onClose={() => setConfirmStop(false)}
      />
      <ConfirmDialog
        open={pending !== null}
        title={runningElsewhere ? `Stop ${flow.currentStep}?` : `Replay from ${replay}?`}
        body={replay ? (runningElsewhere ? stopAndStartBody(flow, replay) : replayBody(flow, replay)) : ''}
        verb={runningElsewhere ? 'Stop and start' : 'Replay'}
        tone="danger"
        onConfirm={() =>
          replay && pending
            ? startReplay(replay, pending.prompt, pending.phases, ...(pending.attachments ? [pending.attachments] : []))
            : Promise.resolve()
        }
        onClose={() => setPending(null)}
      />
    </>
  );
}
