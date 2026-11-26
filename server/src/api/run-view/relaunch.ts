import type { RelaunchView } from '../../contract/relaunch';
import { PHASE_STEPS, STEPS } from '../../contract/steps';
import type { PhaseName } from '../../contract/steps';
import { normalizePhases } from '../../core/pipeline-result';
import type { DocumentEntity, FlowEntity, RunEntity, StepStatEntity } from '../../history/entities';
import type { FlowRepository } from '../../history/flow.repository';
import type { VisitRepository } from '../../history/visit.repository';
import { ARTIFACTS } from '../../steps/contract/artifacts';
import { handoffSection } from '../../steps/shared/handoff';

/** The flow rows a relaunch is read from. */
type RebaseRow = Pick<FlowEntity, 'phases' | 'fromStep' | 'createdAt'>;

/** What a visit says of when its step ran. */
type StepRan = Pick<StepStatEntity, 'step' | 'finishedAt'>;

/** One version of the run's handoff document. */
type HandoffVersion = Pick<DocumentEntity, 'body' | 'createdAt'>;

/** The phases a flow row names, as the flow runs them; a row nobody can read runs no phase. */
function phasesOf(row: RebaseRow): PhaseName[] {
  try {
    const parsed = JSON.parse(row.phases) as unknown;
    return Array.isArray(parsed)
      ? normalizePhases(parsed.filter((item): item is string => typeof item === 'string'))
      : [];
  } catch {
    return [];
  }
}

/** The steps of the row's phases from its first step on. `done` is the run's end, not a step that runs. */
function stepsOf(row: RebaseRow, phases: readonly PhaseName[]): string[] {
  const from = row.fromStep === null ? 0 : STEPS.indexOf(row.fromStep as (typeof STEPS)[number]);
  return phases
    .flatMap((phase) => PHASE_STEPS[phase])
    .filter((step) => step !== 'done' && STEPS.indexOf(step as (typeof STEPS)[number]) >= Math.max(from, 0));
}

/** The one rule for a step that has run on the new head: it has a visit that finished after the relaunch. */
const finishedAfter = (stat: Pick<StepStatEntity, 'finishedAt'>, at: string): boolean => stat.finishedAt > at;

/** True once the step has a visit that finished after `at`. */
const ranSince = (step: string, at: string, stats: readonly StepRan[]): boolean =>
  stats.some((stat) => stat.step === step && finishedAfter(stat, at));

/** True for a step of the open relaunch that has not run since, given its latest visit. */
export function awaitsRelaunch(
  step: string,
  stat: Pick<StepStatEntity, 'finishedAt'> | undefined,
  relaunch: RelaunchView | undefined,
): boolean {
  return !!relaunch && relaunch.steps.includes(step) && !(stat && finishedAfter(stat, relaunch.at));
}

/** The reason in words: the subtask's own note from the handoff, else where the run was rebased onto. */
function reasonOf(isSubtask: boolean, note: string): string {
  const words = note || (isSubtask ? 'rebased onto the epic' : 'rebased onto main');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The `rebase` note of the newest handoff version made before `before`, or the newest of all when `before` is null. */
function noteBefore(handoffs: readonly HandoffVersion[], before: string | null): string {
  const version = [...handoffs].reverse().find((item) => before === null || item.createdAt < before);
  return version ? handoffSection(version.body, 'rebase') : '';
}

/** The relaunches of the run's rebase rows, oldest first, each with its reason and whether its steps have run since. */
function viewsOf(
  run: Pick<RunEntity, 'parentRunId' | 'status'>,
  rows: readonly RebaseRow[],
  stats: readonly StepRan[],
  handoffs: readonly HandoffVersion[],
): RelaunchView[] {
  return rows.map((row, index) => {
    const steps = stepsOf(row, phasesOf(row));
    const phases = phasesOf(row).filter((phase) => PHASE_STEPS[phase].some((step) => steps.includes(step)));
    return {
      at: row.createdAt,
      reason: reasonOf(typeof run.parentRunId === 'number', noteBefore(handoffs, rows[index + 1]?.createdAt ?? null)),
      phases,
      steps,
      open:
        index === rows.length - 1 &&
        run.status !== 'done' &&
        !steps.every((step) => ranSince(step, row.createdAt, stats)),
    };
  });
}

/** The relaunches a rebase made of the run, from its flow rows, stats and documents; oldest first. */
export function relaunchViews(
  run: Pick<RunEntity, 'parentRunId' | 'status'>,
  flows: readonly (RebaseRow & Pick<FlowEntity, 'cause'>)[],
  stats: readonly StepRan[],
  documents: readonly (HandoffVersion & Pick<DocumentEntity, 'kind'>)[],
): RelaunchView[] {
  const handoffs = documents.filter((document) => document.kind === ARTIFACTS.handoff.kind);
  return viewsOf(
    run,
    flows.filter((row) => row.cause === 'rebase'),
    stats,
    handoffs,
  );
}

/** The latest relaunch that is still open. */
export function openRelaunch(relaunches: readonly RelaunchView[] | undefined): RelaunchView | undefined {
  return [...(relaunches ?? [])].reverse().find((relaunch) => relaunch.open);
}

/** The steps the run's open relaunch still has to run on the new head; undefined when no relaunch is open. */
function stepsToRun(rows: readonly RebaseRow[], stats: readonly StepRan[]): string[] | undefined {
  const open = openRelaunch(viewsOf({ parentRunId: null, status: 'waiting' }, rows, stats, []));
  return open?.steps.filter((step) => !ranSince(step, open.at, stats));
}

/**
 * The steps each run's open relaunch still has to run, by run id, for the runs that have one: the relaunch rows of all
 * the runs in one read, and the finish times only of the runs that have such a row, in one read.
 */
export async function relaunchSteps(
  flows: Pick<FlowRepository, 'listRebases'>,
  visits: Pick<VisitRepository, 'finishesOf'>,
  runIds: number[],
): Promise<Map<number, string[]>> {
  const steps = new Map<number, string[]>();
  const rebases = await flows.listRebases(runIds);
  const finishes = await visits.finishesOf([...rebases.keys()]);
  for (const [runId, rows] of rebases) {
    const left = stepsToRun(rows, finishes.get(runId) ?? []);
    if (left) steps.set(runId, left);
  }
  return steps;
}
