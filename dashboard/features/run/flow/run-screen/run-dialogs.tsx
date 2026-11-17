'use client';

import type { ReactElement } from 'react';
import type { PhaseName } from '@contract/steps';
import type { FlowView } from '@contract/api';
import { ConfirmDialog } from '../../../shell';
import { stepLabel } from '../../phases';
import { replayBody, reviewerBody, stopAndStartBody, stopBody } from './confirm-texts';

/** The confirms of Stop, Replay and Run again of a reviewer. Replay asks after its instructions form; it is Stop and start when another step is running. */
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
  reviewer,
  setReviewer,
  startReviewer,
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
  /** The reviewer step whose Run again waits for a confirm. */
  reviewer: string | null;
  setReviewer: (step: string | null) => void;
  startReviewer: (step: string) => Promise<void>;
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
        onConfirm={() => (replay && pending ? startReplay(replay, pending.prompt, pending.phases) : Promise.resolve())}
        onClose={() => setPending(null)}
      />
      <ConfirmDialog
        open={reviewer !== null}
        title={`Run ${stepLabel(reviewer ?? '')} again?`}
        body={reviewerBody(reviewer ?? '')}
        verb="Run again"
        tone="danger"
        onConfirm={() => (reviewer ? startReviewer(reviewer) : Promise.resolve())}
        onClose={() => setReviewer(null)}
      />
    </>
  );
}
