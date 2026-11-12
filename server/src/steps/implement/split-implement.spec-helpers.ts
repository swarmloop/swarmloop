import { parseSubtasks, type Subtask } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { deriveState, writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { save } from '../../testing/runs.spec-helpers';

export const KEY = 'PROJ-300';

export const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

export const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

/** An app with the real implement step. Starting a subtask run is recorded, not run. */
export async function world(env: Record<string, string> = {}) {
  const app = await createTestApp({
    realImplement: true,
    env,
    sandbox: { stopRun: () => Promise.resolve('gone') },
  });
  return { app, ...instrument(app) };
}

function instrument(app: TestApp) {
  const launched: string[] = [];
  const original = app.pipeline.startDetached.bind(app.pipeline);
  jest.spyOn(app.pipeline, 'startDetached').mockImplementation((key, ...rest) => {
    if (key === KEY) return original(key, ...rest);
    launched.push(key);
    return Promise.resolve({ exitCode: 0, message: `${key} started` });
  });
  return { launched };
}

export async function seedParent(app: TestApp, tasks: Subtask[]) {
  const runs = app.app.get(RunRepository);
  const parent = await save(runs, KEY, 'implement', 'waiting');
  parent.split = true;
  parent.projects = 'demo\n';
  await runs.saveRun(parent);
  const documents = app.app.get(DocumentRepository);
  await documents.putDocument(parent, 'requirements', requirements);
  await documents.putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
  return parent;
}

export async function pass(app: TestApp) {
  return app.pipeline.step('implement', KEY);
}

/** Waits for the commands accepted so far and for the pass they started. */
export async function settle(app: TestApp): Promise<void> {
  await app.app.get(CommandService).idle();
  await app.pipeline.whenIdle(KEY);
}

export async function tasksOf(app: TestApp): Promise<Subtask[]> {
  return parseSubtasks(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks'));
}

export const statuses = async (app: TestApp) =>
  Object.fromEntries((await tasksOf(app)).map((item) => [item.id, item.status]));

export async function setStatus(app: TestApp, id: string, status: Subtask['status']): Promise<void> {
  const parent = (await app.app.get(RunRepository).findRun(KEY))!;
  const tasks = (await tasksOf(app)).map((item) => (item.id === id ? { ...item, status } : item));
  await app.app.get(DocumentRepository).putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
}

export async function child(app: TestApp, id: string) {
  return (await app.app.get(RunRepository).findRun(`${KEY}-${id}`))!;
}

/** The subtask run works: its owner is alive. */
export async function work(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'running', currentStep: 'research', ownerPid: process.pid });
  await app.app.get(RunRepository).saveRun(run);
}

export async function finish(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'done', currentStep: 'done' });
  await app.app.get(RunRepository).saveRun(run);
}

export async function parentState(app: TestApp) {
  return deriveState((await app.app.get(RunRepository).findRun(KEY))!);
}
