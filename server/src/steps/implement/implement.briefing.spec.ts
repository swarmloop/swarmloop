import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { bootOnce, reply, result, seed } from './implement.step.spec-helpers';

const once = bootOnce();

const TASKS = JSON.stringify([
  {
    id: 'a',
    title: 'Use the tool',
    description: 'Uses it.',
    depends: ['b'],
    files: ['a.ts'],
    proof: 'a',
    status: 'running',
  },
  {
    id: 'b',
    title: 'Make the tool',
    description: 'Makes it.',
    depends: [],
    files: ['b.ts'],
    proof: 'b',
    status: 'merged',
  },
]);
const CONTRACT = '- tool (owner b): the tool takes a path\n\ndecisions:\n';

/** A subtask `a` of a parent run, whose approved plan is implemented in its own run. */
async function subtask(key: string, parentContract = CONTRACT) {
  const app = once.app();
  const worktree = once.tree(key, 'billing-api');
  once.use(async (_input: AgentRunInput) => {
    writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
    return { ...result(reply), chatId: 'impl-chat' };
  });
  await seed(app, key, 'approve');
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const parent = await runs.openWaiting(`${key}-parent`, '/target');
  await documents.putDocument(parent, 'subtasks', TASKS);
  await documents.putDocument(parent, 'contract', parentContract);
  const sibling = await runs.openSubtask(`${key}-parent-b`, parent.id, 'b');
  const run = (await runs.findRun(key))!;
  run.parentRunId = parent.id;
  run.taskId = 'a';
  await runs.saveRun(run);
  return { app, runs, documents, parent, sibling, run };
}

function resumeChat(key: string): void {
  mkdirSync(join(once.root(), 'data', 'agent-state', key, 'implement'), { recursive: true });
  writeFileSync(
    join(once.root(), 'data', `${key}-implement-session.json`),
    // A subtask's implement runs on the agent of the subtask tier, which this setup leaves at its default runtime.
    JSON.stringify({ runtime: 'claude', chatId: 'impl-chat', completed: true, usd: 0, resultName: 'implementation' }),
  );
}

const promptOf = (): string => (once.agent.mock.calls[0]?.[0] as AgentRunInput).prompt;

describe('what a subtask is told in implement', () => {
  it('carries the task map and the contract in the first prompt of a new chat', async () => {
    const { app } = await subtask('PROJ-1900');

    await app.get(PipelineService).step('implement', 'PROJ-1900');

    expect(promptOf()).toContain('Task map, the other tasks of the parent run:');
    expect(promptOf()).toContain('- b (merged): Make the tool - files: b.ts - owns: tool (delivered)');
    expect(promptOf()).toContain('Contract:\n- tool (owner b): the tool takes a path');
  });

  it('carries the summary, the files and the items of a dependency that merged, in a new chat', async () => {
    const { app, documents, sibling } = await subtask('PROJ-1901');
    await documents.putDocument(
      sibling,
      'merge_request',
      'project: web\niid: 7\nurl: https://host/7\ndraft: false\n\nMakes the tool.\n',
    );
    await documents.putDocument(sibling, 'merged_files', 'b.ts\nshared/tool.ts');

    await app.get(PipelineService).step('implement', 'PROJ-1901');

    expect(promptOf()).toContain('Merged dependency b, files: b.ts, shared/tool.ts\nMakes the tool.');
    expect(promptOf()).toContain('Contract items it delivered:\n- tool: the tool takes a path');
  });

  it('tells a continued chat only the decision a sibling made since its last prompt, and not again', async () => {
    const { app, documents } = await subtask(
      'PROJ-1902',
      `${CONTRACT}- subtask b at 2026-11-20T10:00:00.000Z: paths are absolute\n`,
    );
    await documents.putDocument(
      (await app.get(RunRepository).findRun('PROJ-1902'))!,
      'starter_briefing',
      JSON.stringify({ 'impl-chat': { decisions: [], merged: ['b'], items: { tool: 'delivered' } } }),
    );
    resumeChat('PROJ-1902');

    await app.get(PipelineService).step('implement', 'PROJ-1902');

    const prompt = promptOf();
    expect(prompt).toContain(
      'New decisions since your last prompt:\n- subtask b at 2026-11-20T10:00:00.000Z: paths are absolute',
    );
    expect(prompt).not.toContain('Task map');
    expect(prompt).not.toContain('Merged dependency');
    const record = JSON.parse((await documents.latestBody('PROJ-1902', 'starter_briefing')) ?? '{}');
    expect(record['impl-chat'].decisions).toEqual(['subtask b at 2026-11-20T10:00:00.000Z: paths are absolute']);
  });

  it('tells a run that is not a subtask nothing and keeps no record', async () => {
    const app = once.app();
    const worktree = once.tree('PROJ-1903', 'billing-api');
    once.use(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(reply);
    });
    await seed(app, 'PROJ-1903', 'approve');

    await app.get(PipelineService).step('implement', 'PROJ-1903');

    expect(promptOf()).not.toContain('Task map');
    expect(await app.get(DocumentRepository).latestBody('PROJ-1903', 'starter_briefing')).toBeNull();
  });
});
