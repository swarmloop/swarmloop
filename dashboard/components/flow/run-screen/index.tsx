'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useRunFlow } from '../../../hooks/use-run-flow';
import { NewRunDialog } from '../../new-run-dialog';
import { expandReviewPhases, PHASES, pipelineStep, replaySelection, REVIEW_STEPS } from '../../../lib/phases';
import { FlowBoard } from '../flow-board';
import { StepDetail } from '../step-detail';
import { WaitingPanel } from '../waiting-panel';
import { RunDialogs } from './run-dialogs';
import { RunHeader } from './run-header';

export function RunScreen({ runKey }: { runKey: string }) {
  const {
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
  } = useRunFlow(runKey);

  if (!flow) {
    return <Typography color={error ? 'error' : 'text.secondary'}>{error ?? 'Loading the run.'}</Typography>;
  }

  const phases = expandReviewPhases(flow.phases);
  const runningElsewhere = flow.status === 'running' && replay !== null && pipelineStep(flow.currentStep) !== pipelineStep(replay);
  const launches = flow.launches ?? [];
  const original = launches.find((launch) => launch.fromStep === null)?.phases ?? [...PHASES];
  const latest = launches.at(-1)?.phases ?? original;
  const choice = replay ? replaySelection(original, latest, replay) : null;
  return (
    <Box>
      <RunHeader flow={flow} openMs={openMs} rebasing={rebasing} stopping={stopping} rebaseError={rebaseError} onRebase={rebaseRun} onStop={() => setConfirmStop(true)} />
      <FlowBoard phases={phases} returns={flow.returns} selected={selected} onSelect={selectStep} />
      {flow.status === 'waiting' || flow.status === 'blocked' || flow.status === 'failed' ? <WaitingPanel flow={flow} onChange={applyWaiting} /> : null}
      {selected ? (
        <StepDetail
          key={selected}
          runKey={flow.key}
          step={selected}
          live={flow.status === 'running' && pipelineStep(selected) === flow.currentStep}
          revision={flow.updatedAt}
          attempts={phases.flatMap((phase) => phase.steps).find((step) => step.name === selected)?.attempts ?? 0}
          now={now}
          onReplay={
            selected === 'code-review' || flow.status === 'running'
              ? undefined
              : (REVIEW_STEPS as readonly string[]).includes(selected)
                ? () => startReviewer(selected)
                : () => setReplay(pipelineStep(selected))
          }
          runStatus={pipelineStep(selected) === flow.currentStep ? flow.status : undefined}
          onResume={
            pipelineStep(selected) === flow.currentStep && (flow.status === 'failed' || flow.status === 'blocked') && flow.resume === 'ready' ? resumeRun : undefined
          }
        />
      ) : null}
      <NewRunDialog
        key={replay ?? 'closed'}
        open={replay !== null && pending === null}
        title={replay ?? 'New run'}
        selected={choice?.selected}
        locked={choice?.locked}
        lockedProjects={flow.projects ?? []}
        runKey={flow.key}
        onProjects={(projects) => setFlow((current) => (current ? { ...current, projects } : current))}
        onClose={() => setReplay(null)}
        onSubmit={async (prompt, phases) => {
          if (!replay) {
            return;
          }
          if (runningElsewhere) {
            setPending({ prompt, phases });
            return 'hold';
          }
          await startReplay(replay, prompt, phases);
        }}
      />
      <RunDialogs
        flow={flow}
        error={error}
        stopping={stopping}
        confirmStop={confirmStop}
        setConfirmStop={setConfirmStop}
        pending={pending}
        setPending={setPending}
        replay={replay}
        stopRun={stopRun}
        startReplay={startReplay}
        setError={setError}
      />
    </Box>
  );
}
