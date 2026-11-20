import type { ReactElement } from 'react';
import type { FlowView } from '@contract/api';
import type { PlanRevision } from '@contract/plan-chat';
import { pipelineStepOf, REVIEW_STEPS } from '@contract/steps';
import { resumeLabel, resumeTip } from '../../../../lib/ci-infra';
import { StepDetail } from '../step-detail';

/** The window of the selected step: its transcript and documents, with the Replay and Resume it offers. */
export function StepWindow({
  flow,
  step,
  attempts,
  restartedAt,
  now,
  planRevision,
  onReviewer,
  onReplay,
  onResume,
}: {
  flow: FlowView;
  step: string;
  attempts: number;
  restartedAt?: string;
  now: number;
  planRevision?: PlanRevision | null;
  /** Opens the reviewer's replay choice. */
  onReviewer: (step: string) => void;
  onReplay: (step: string) => void;
  onResume: () => void;
}): ReactElement {
  const current = pipelineStepOf(step) === flow.currentStep;
  return (
    <StepDetail
      key={step}
      runKey={flow.key}
      step={step}
      live={flow.status === 'running' && current}
      revision={flow.updatedAt}
      planRevision={planRevision}
      attempts={attempts}
      restartedAt={restartedAt}
      now={now}
      liveCommands={flow.checkCommands}
      onReplay={
        step === 'code-review' || flow.status === 'running' || !flow.actions.includes('replay')
          ? undefined
          : REVIEW_STEPS.includes(step)
            ? () => onReviewer(step)
            : () => onReplay(pipelineStepOf(step))
      }
      runStatus={current ? flow.status : undefined}
      onResume={
        current && (flow.status === 'failed' || flow.status === 'blocked') && flow.actions.includes('resume')
          ? onResume
          : undefined
      }
      resumeLabel={resumeLabel(flow.stateReason?.code)}
      resumeTip={resumeTip(flow.stateReason?.code)}
    />
  );
}
