import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../../contract/error-codes';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunRepository } from '../../history/run.repository';
import type { RunEntity } from '../../history/entities';
import { InputReader } from '../contract/input-reader';
import { implementRunner } from '../implement/split-or-fix';
import { settledAt } from './subtask-settled-at';
import { NEEDS_ANSWERS, REASON } from '../../contract/run-state';
import { storedState } from '../../history/run-state';

/** Between passes: the parent waits for its subtasks, or a blocked subtask stopped it. */
export function betweenPasses(parent: RunEntity): boolean {
  const { state, reason } = storedState(parent);
  const code = reason?.code ?? '';
  return (
    parent.currentStep === 'implement' &&
    ((state === 'waiting' && SUBTASK_WAIT_CODES.some((wait) => wait === code)) ||
      (state === 'blocked' && code === ERROR_CODES.SUBTASK_BLOCKED))
  );
}

/** The epic waits at implement on questions that its parts or its gaps raised. */
export function asksAtImplement(parent: RunEntity): boolean {
  const { state, reason } = storedState(parent);
  const code = reason?.code ?? '';
  return (
    parent.currentStep === 'implement' && state === 'waiting' && (code === NEEDS_ANSWERS || code === REASON.asksPlanner)
  );
}

/** The epic waits at implement for a green main (`WAITS_FOR_MAIN`). */
function waitsForMainAtImplement(parent: RunEntity): boolean {
  const { state, reason } = storedState(parent);
  return parent.currentStep === 'implement' && state === 'waiting' && reason?.code === REASON.waitsForMain;
}

/**
 * The epic the main move takes: between passes, or waiting at implement on questions that its parts or its gaps raised,
 * or for a green main.
 * A wait of the epic's own agent (a parked conflict of its own branch, a resolution round, a defect return it fixes)
 * is not one of those: its rebase is parked and a move would resume it on the old base. The routing of
 * `implementRunner` tells them apart. `betweenPasses` alone says when the epic's pass is due, so a question never
 * resumes it.
 */
export async function takesMain(
  documents: DocumentRepository,
  runs: Pick<RunRepository, 'findSubtask'>,
  parent: RunEntity,
): Promise<boolean> {
  if (!parent.split) return false;
  if (betweenPasses(parent)) return true;
  if (!asksAtImplement(parent) && !waitsForMainAtImplement(parent)) return false;
  const subtasks = { settledAt: (run: RunEntity, id: string) => settledAt(runs, documents, run, id) };
  return (await implementRunner(new InputReader(documents), documents, subtasks, parent)) === 'split';
}
