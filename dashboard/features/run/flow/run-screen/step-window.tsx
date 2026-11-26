import type { ReactElement } from 'react';
import type { FlowView } from '@contract/api';
import type { PlanRevision } from '@contract/plan-chat';
import { pipelineStepOf, REVIEW_STEPS } from '@contract/steps';
import { resumeLabel, resumeTip } from '../../../../lib/ci-infra';
import { StepDetail } from '../step-detail';

/**
 * The status of the step's chip on the board. `idle` is kept only for a step the open relaunch runs again: a chip
 * that is idle for any other reason (a review that failed before any reviewer decided) says nothing of its visits.
 */
function boardStatusOf(flow: FlowView, step: string): string | undefined {
  const status = flow.phases.flatMap((phase) => phase.steps).find((item) => item.name === step)?.status;
  if (status !== 'idle') {
    return status;
  }
  const relaunched = (flow.relaunches ?? []).some((item) => item.open && item.steps.includes(pipelineStepOf(step)));
  return relaunched ? status : undefined;
}

/** Why the step sent work back, only while its chip reads `returned`: a step that went on is not shown as returned. */
function returnWordsOf(flow: FlowView, step: string, boardStatus: string | undefined): string | undefined {
  return boardStatus === 'returned'
    ? flow.returns.find((edge) => edge.from === pipelineStepOf(step))?.words
    : undefined;
}

/** The window of the selected step: its transcript and documents, with the Replay and Resume it offers. */
export function StepWindow({
  flow,
  step,
  attempts,
  restartedAt,
  now,
  planRevision,
  onReplay,
  onResume,
}: {
  flow: FlowView;
  step: string;
  attempts: number;
  restartedAt?: string;
  now: number;
  planRevision?: PlanRevision | null;
  onReplay: (step: string) => void;
  onResume: () => void;
}): ReactElement {
  const current = pipelineStepOf(step) === flow.currentStep;
  const boardStatus = boardStatusOf(flow, step);
  return (
    <StepDetail
      key={step}
      runKey={flow.key}
      step={step}
      live={flow.status === 'running' && current}
      revision={flow.updatedAt}
      planRevision={planRevision}
      attempts={attempts}
      boardStatus={boardStatus}
      returnWords={returnWordsOf(flow, step, boardStatus)}
      restartedAt={restartedAt}
      now={now}
      liveCommands={flow.checkCommands}
      onReplay={
        step === 'code-review' ||
        REVIEW_STEPS.includes(step) ||
        flow.status === 'running' ||
        !flow.actions.includes('replay')
          ? undefined
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
