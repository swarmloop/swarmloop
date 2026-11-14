import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import type { RunEntity } from '../history/entities';
import { planFields, withPlan } from '../steps/plan/plan-record';
import type { createFlowHarness } from './flow-harness';
import { remember } from './runs.spec-helpers';
import { git } from './runs.spec-helpers';
import { writeFileSync } from 'fs';
import { join } from 'path';

type Flow = Awaited<ReturnType<typeof createFlowHarness>>;

/** A run waiting at `step` with the approved plan one checklist item long, as the implement steps start from. */
export async function approvedRun(flow: Flow, key: string, step: string): Promise<RunEntity> {
  const runs = flow.app.app.get(RunRepository);
  const documents = flow.app.app.get(DocumentRepository);
  const run = await remember(runs, documents, key, step, 'waiting');
  const body = (await documents.latestBody(key, 'requirements')) ?? '';
  const plan = { ...planFields(['add the field']), decision: 'approve' as const };
  await documents.putDocument(run, 'requirements', withPlan(body, plan));
  return run;
}

/** The notes a later step sent back to implement. */
export async function returnedTo(flow: Flow, run: RunEntity, notes: string): Promise<void> {
  await flow.app.app.get(DocumentRepository).putDocument(run, 'return', notes);
}

/** Leaves the feature worktree in a rebase whose two edits to the same field conflict. */
export function conflictingRebase(flow: Flow): void {
  const clone = join(flow.app.root, 'demo');
  writeFileSync(join(flow.tree, 'src', 'readme.ts'), 'export const readme = 2;\n');
  git(flow.tree, ['commit', '-am', 'feature change']);
  git(clone, ['switch', 'main']);
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 3;\n');
  git(clone, ['commit', '-am', 'base change']);
  git(clone, ['push', 'origin', 'main']);
  git(clone, ['switch', 'holder']);
  git(flow.tree, ['fetch', 'origin', 'main']);
  expect(() => git(flow.tree, ['rebase', 'origin/main'])).toThrow();
}
