'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { usePhone } from '../../../../lib/use-phone';
import { useDocumentTitle } from '../../../../lib/document-title';
import { useRunFlow } from '../../use-run-flow';
import { NewRunDialog } from '../../../new-run';
import { expandReviewPhases, replaySelection } from '../../phases';
import { PHASES, pipelineStepOf } from '@contract/steps';
import { FlowBoard } from '../flow-board';
import { skipTask } from '../../../../lib/endpoints';
import { GitAuthBanner } from '../git-auth-banner';
import { LimitBanner } from '../limit-banner';
import type { PlanRevision } from '@contract/plan-chat';
import { ConversationColumn } from '../../conversation/conversation-column';
import { useWideConversation } from '../../conversation/use-wide-conversation';
import { latestRevision } from '../../conversation/revision-marks';
import { FinishedSummary } from './finished-summary';
import { RunDialogs } from './run-dialogs';
import { RunHeader } from './run-header';
import { StepWindow } from './step-window';
import { TaskLayers } from './task-layers';

export function RunScreen({ runKey }: { runKey: string }): ReactElement {
  const {
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
    stopRun,
    rebaseRun,
    startReplay,
    resumeRun,
  } = useRunFlow(runKey);

  const [wide, setWide] = useWideConversation();
  const sideBySide = !usePhone();
  useDocumentTitle(flow?.title ?? null);

  if (!flow) {
    return error ? (
      <Box>
        <Typography color="error">{`The run could not be loaded: ${error}`}</Typography>
        <Button onClick={reload} sx={{ mt: 1 }}>
          Retry
        </Button>
      </Box>
    ) : (
      <Box aria-label="Loading the run">
        <Skeleton variant="text" width={320} height={40} />
        <Skeleton variant="rounded" height={120} sx={{ mt: 1 }} />
      </Box>
    );
  }

  const phases = expandReviewPhases(flow.phases);
  const chip = phases.flatMap((phase) => phase.steps).find((step) => step.name === selected);
  const runningElsewhere =
    flow.status === 'running' && replay !== null && pipelineStepOf(flow.currentStep) !== pipelineStepOf(replay);
  const launches = flow.launches ?? [];
  const original = launches.find((launch) => launch.fromStep === null)?.phases ?? [...PHASES];
  const latest = launches.at(-1)?.phases ?? original;
  const choice = replay ? replaySelection(original, latest, replay) : null;
  const revision = latestRevision(flow.conversation?.revisions);
  const layers = (planRevision: PlanRevision | null): ReactElement | null =>
    flow.tasks?.length ? (
      <TaskLayers
        tasks={flow.tasks}
        now={now}
        revision={planRevision}
        epic={flow.epic}
        ownUsd={flow.metrics.usd}
        mergeQueue={flow.mergeQueue}
        decisions={flow.decisions}
        onSkip={(taskId) => skipTask(flow.key, taskId)}
      />
    ) : null;
  const planWindow = selected === 'plan';
  const tasks = layers(planWindow ? revision : null);
  const summary = flow.status === 'done' && selected === null;
  const chooseStep = (name: string): void => {
    setWide(false);
    selectStep(name);
  };
  return (
    <Box sx={{ minWidth: 0 }}>
      {flow.parentKey ? (
        <Typography variant="body2" sx={{ mb: 1 }}>
          Subtask of <Link href={`/runs/${encodeURIComponent(flow.parentKey)}` as Route}>{flow.parentKey}</Link>
        </Typography>
      ) : null}
      <LimitBanner flow={flow} />
      <GitAuthBanner flow={flow} />
      <RunHeader
        flow={flow}
        openMs={openMs}
        now={now}
        onRebase={rebaseRun}
        onStop={() => setConfirmStop(true)}
        onOpenRequirements={() => chooseStep('requirements')}
      />
      {error ? (
        <Typography color="error" variant="body2" sx={{ mt: 1 }}>
          {error}
        </Typography>
      ) : null}
      <FlowBoard
        phases={phases}
        returns={flow.returns}
        selected={selected}
        onSelect={chooseStep}
        checkCommands={flow.checkCommands}
        stateReason={flow.stateReason ?? null}
      />
      {summary ? null : tasks}
      <Box
        data-testid="step-row"
        sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, alignItems: 'flex-start' }}
      >
        {wide && sideBySide ? null : (
          <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
            {summary ? <FinishedSummary flow={flow} tasks={tasks} /> : null}
            {selected ? (
              <StepWindow
                flow={flow}
                step={selected}
                attempts={chip?.attempts ?? 0}
                restartedAt={chip?.restartedAt}
                now={now}
                planRevision={planWindow ? revision : undefined}
                onReplay={setReplay}
                onResume={resumeRun}
              />
            ) : null}
          </Box>
        )}
        <ConversationColumn flow={flow} onResume={resumeRun} onChange={applyWaiting} wide={wide} onWide={setWide} />
      </Box>
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
        onSubmit={(prompt, phases, attachments) => {
          if (replay) {
            setPending({ prompt, phases, attachments });
          }
          return Promise.resolve(replay ? 'hold' : undefined);
        }}
      />
      <RunDialogs
        flow={flow}
        confirmStop={confirmStop}
        setConfirmStop={setConfirmStop}
        pending={pending}
        setPending={setPending}
        replay={replay}
        runningElsewhere={runningElsewhere}
        stopRun={stopRun}
        startReplay={startReplay}
      />
    </Box>
  );
}
