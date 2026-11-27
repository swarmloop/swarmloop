import { BacklogRepository } from '../../history/backlog.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { RunQueriesService } from '../../api/run-queries.service';
import { RunListRows } from '../../api/run-list-rows';
import { runTaskStatus } from '../../contract/subtask';
import type { RunState, StateReason } from '../../contract/run-state';
import { BacklogQueries } from '../../pipeline/backlog/backlog-queries';
import { BacklogPlanner } from '../../pipeline/backlog/planner/backlog-planner';
import { BacklogTurnState, type TaskState } from '../../pipeline/backlog/planner/turn-state';
import { CommandService } from '../../pipeline/command.service';
import { PipelineService } from '../../pipeline/pipeline.service';
import { Reconciler } from '../../pipeline/reconciler';
import { StartWaits } from '../../steps/shared/start-waits';
import { assertInvariants } from '../flow-invariants';
import type { TestApp } from '../test-app';

/** The turn key the planner's read is asked for: a read for the check, with no items of any turn. */
const CHECK_TURN = 'settle-check';

async function drain(app: TestApp): Promise<void> {
  const runs = await app.app.get(RunRepository).listRuns();
  await app.app.get(CommandService).idle();
  for (const run of runs) await app.app.get(PipelineService).whenIdle(run.key);
  await app.app.get(BacklogPlanner).whenIdle();
  await app.app.get(StartWaits).settled();
}

/** Lets the system settle: every running thing ends, the reconciler takes one pass, and what it started ends too. Time moves only through the app's clock. */
export async function settle(app: TestApp): Promise<void> {
  await drain(app);
  await app.app.get(Reconciler).reconcileAll();
  await drain(app);
}

/** A restart, and the new process settles. Returns the new app. */
export async function restartAndSettle(app: TestApp): Promise<TestApp> {
  const next = await app.restart();
  await settle(next);
  return next;
}

function sameState(
  rule: string,
  key: string,
  stored: { state: RunState; reason: StateReason | null },
  shown: { state: RunState; stateReason: StateReason | null },
): string[] {
  if (stored.state === shown.state && JSON.stringify(stored.reason) === JSON.stringify(shown.stateReason)) return [];
  return [
    `${key}: ${rule} shows ${shown.state} ${JSON.stringify(shown.stateReason)}, but the stored state is ${stored.state} ${JSON.stringify(stored.reason)}`,
  ];
}

/** Every run reads the same state in every place, and no claim outlives its owner. It throws one error that lists each run and rule that broke. */
export async function assertSettled(app: TestApp): Promise<void> {
  await assertInvariants(app);
  const runs = app.app.get(RunRepository);
  const rows = new Map((await app.app.get(RunListRows).read()).view.runs.map((row) => [row.key, row]));
  const backlogs = app.app.get(BacklogRepository);
  const taskStatus = new Map<string, { shown: string; planner: string }[]>();
  for (const backlog of await backlogs.listBacklogs()) {
    const view = await app.app.get(BacklogQueries).view(backlog.name);
    const turn = await app.app.get(BacklogTurnState).read(backlog.name, CHECK_TURN);
    const planned = [turn.active, ...turn.planned].flatMap((milestone) => milestone?.tasks ?? []);
    for (const task of view.tasks) {
      if (task.runKey === null) continue;
      const seen: TaskState | undefined = [...planned, ...turn.items].find((item) => item.runKey === task.runKey);
      const list = taskStatus.get(task.runKey) ?? [];
      list.push({ shown: task.status, planner: seen?.status ?? 'missing from the planner' });
      taskStatus.set(task.runKey, list);
    }
  }
  const broken: string[] = [];
  for (const run of await runs.listRuns()) {
    const stored = storedState(run);
    const flow = await app.app.get(RunQueriesService).flow(run.key);
    broken.push(...sameState('the run view', run.key, stored, flow));
    const row = rows.get(run.key);
    if (row) broken.push(...sameState('the list row', run.key, stored, row));
    else broken.push(`${run.key}: the run list has no row`);
    const expected = runTaskStatus({ state: stored.state, currentStep: run.currentStep });
    for (const { shown, planner } of taskStatus.get(run.key) ?? []) {
      if (shown !== expected) broken.push(`${run.key}: the backlog shows its task ${shown}, its run gives ${expected}`);
      if (planner !== expected)
        broken.push(`${run.key}: the planner reads its task ${planner}, its run gives ${expected}`);
    }
    if ((run.ownerPid !== null || run.activeAttempt !== null) && !runs.held(run)) {
      broken.push(
        `${run.key}: holds a claim (owner ${run.ownerPid}, attempt ${run.activeAttempt}) that no live owner has`,
      );
    }
  }
  if (broken.length > 0) throw new Error(broken.join('\n'));
}
