import 'reflect-metadata';

import { rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';

import type { AgentRunInput } from '../../agent/agent-runner';
import { REBASE_CONFLICT } from '../../git/rebase';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SubtaskOps } from '../shared/subtask-ops';
import {
  boot,
  conflictedTree,
  git,
  implAnswer,
  rebaseReply,
  result,
  seed,
  writeEnv,
} from './implement.step.spec-helpers';

const BRANCH = (key: string) => `feature/${key}-ship-the-field`;
const IS_CONFLICT = (input: AgentRunInput) => input.prompt.includes('The commit being replayed is');
const TASKS = [
  {
    id: 'a',
    title: 'Task a',
    description: 'Do a.',
    depends: [],
    files: ['src/a.ts'],
    proof: 'a.spec.ts',
    status: 'running',
  },
];

/** What an agent that gives the merge up leaves: the parked rebase is gone and the files are as before, so the next rebase stops on the same file. */
function undoMerge(tree: string, tip: string): void {
  const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
  rmSync(isAbsolute(state) ? state : join(tree, state), { force: true });
  git(tree, ['reset', '--hard', tip]);
}

/** A conflicted worktree of a split run with an open task, its marker parked at implement. */
async function splitWorld(key: string, agent: jest.Mock) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-conflict-'));
  await writeEnv(root);
  const tree = conflictedTree(root, key, 'billing-api');
  const app = await boot(root, agent);
  await seed(app, key, 'approve');
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const run = (await runs.findRun(key))!;
  await runs.saveRun({ ...run, split: true });
  await documents.putDocument(run, 'subtasks', `${JSON.stringify(TASKS)}\n`);
  await documents.putDocument(run, REBASE_CONFLICT, 'pending-implement\n');
  return { app, tree, root, runs, documents };
}

describe('implement with a parked conflict of an epic whose tasks are open', () => {
  it('resolves it with the conflict agent, pushes it and goes on at checks with the round open', async () => {
    const key = 'PROJ-701';
    const tree = { path: '' };
    const tip = { value: '' };
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (IS_CONFLICT(input)) writeFileSync(join(tree.path, 'src', 'field.ts'), 'export const field = 3;\n');
      return result(rebaseReply);
    });
    const world = await splitWorld(key, agent);
    tree.path = world.tree;
    tip.value = git(world.tree, ['rev-parse', `refs/heads/${BRANCH(key)}`]);
    const rebase = jest.spyOn(world.app.get(SubtaskOps), 'rebase');
    try {
      const done = await world.app.get(PipelineService).step('implement', key);
      expect(done.exitCode).toBe(0);
      const prompt = agent.mock.calls[0]?.[0].prompt;
      expect(prompt).toContain('- src/field.ts');
      expect(git(world.tree, ['ls-remote', 'origin', `refs/heads/${BRANCH(key)}`])).toContain(
        git(world.tree, ['rev-parse', 'HEAD']),
      );
      expect((await world.runs.findRun(key))?.currentStep).toBe('checks');
      expect((await world.documents.latestBody(key, REBASE_CONFLICT))?.trim()).toBe('review');
      expect((await world.documents.latestBody(key, 'epic_round'))?.trim()).toBe('open');
      expect(rebase).not.toHaveBeenCalled();
    } finally {
      await world.app.close();
    }
  });

  it('asks the planner when the agent leaves the same files conflicting, and stays parked', async () => {
    const key = 'PROJ-702';
    const tree = { path: '' };
    const tip = { value: '' };
    const agent = jest.fn(async () => {
      undoMerge(tree.path, tip.value);
      return result(rebaseReply);
    });
    const world = await splitWorld(key, agent);
    tree.path = world.tree;
    tip.value = git(world.tree, ['rev-parse', `refs/heads/${BRANCH(key)}`]);
    try {
      const done = await world.app.get(PipelineService).step('implement', key);
      expect(done.exitCode).toBe(0);
      const run = (await world.runs.findRun(key))!;
      expect(run.status).toBe('waiting');
      expect(storedState(run).reason).toMatchObject({ code: 'ASKS_PLANNER' });
      const questions = await world.app.get(PlanChatStore).pendingQuestions(key);
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({ from: 'implement' });
      expect(questions[0]?.text).toContain('billing-api still conflicts in src/field.ts');
      expect((await world.documents.latestBody(key, REBASE_CONFLICT))?.trim()).toBe('pending-implement');
      expect(await world.documents.latestBody(key, 'rebase_journal')).toContain('"conflict"');
    } finally {
      await world.app.close();
    }
  });

  it('hands the planner’s answer to the conflict agent, takes it, and keeps it out of a task’s checklist prompt', async () => {
    const key = 'PROJ-703-t1';
    const tree = { path: '' };
    const tip = { value: '' };
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (!IS_CONFLICT(input)) return result(implAnswer(['changed the field'], ['did it']));
      if (input.prompt.includes('Keep the base version.')) {
        writeFileSync(join(tree.path, 'src', 'field.ts'), 'export const field = 3;\n');
      } else {
        undoMerge(tree.path, tip.value);
      }
      return result(rebaseReply);
    });
    const world = await splitWorld(key, agent);
    tree.path = world.tree;
    tip.value = git(world.tree, ['rev-parse', `refs/heads/${BRANCH(key)}`]);
    try {
      // A task of an epic: not split itself, so its conflict ends at its own checklist.
      const parent = await world.runs.openWaiting('PROJ-703', '/target');
      await world.runs.saveRun({
        ...(await world.runs.findRun(key))!,
        split: false,
        parentRunId: parent.id,
        taskId: 't1',
      });
      await world.app.get(PipelineService).step('implement', key);
      const chat = world.app.get(PlanChatStore);
      await chat.appendEntry(key, {
        key: 'answer-ask-implement-conflict-attempt-1',
        role: 'planner',
        kind: 'answer',
        from: 'implement',
        text: 'Keep the base version.',
        at: '2026-01-01T00:00:00.000Z',
        state: 'pending',
      });
      const before = agent.mock.calls.length;
      await world.app.get(PipelineService).step('implement', key);
      const prompts = agent.mock.calls.slice(before).map((call) => call[0].prompt);
      expect(prompts[0]).toContain('The commit being replayed is');
      expect(prompts[0]).toContain('Keep the base version.');
      expect(prompts[1]).toContain('add the field');
      expect(prompts[1]).not.toContain('Keep the base version.');
      expect(await chat.answerFor(key, 'implement')).toBeNull();
    } finally {
      await world.app.close();
    }
  });

  it('leaves a planner answer to the checklist question for the checklist prompt, not the conflict agent', async () => {
    const key = 'PROJ-704-t1';
    const tree = { path: '' };
    const tip = { value: '' };
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (!IS_CONFLICT(input)) return result(implAnswer(['changed the field'], ['did it']));
      writeFileSync(join(tree.path, 'src', 'field.ts'), 'export const field = 3;\n');
      return result(rebaseReply);
    });
    const world = await splitWorld(key, agent);
    tree.path = world.tree;
    tip.value = git(world.tree, ['rev-parse', `refs/heads/${BRANCH(key)}`]);
    try {
      // A task of an epic: not split itself, so its conflict ends at its own checklist.
      const parent = await world.runs.openWaiting('PROJ-704', '/target');
      await world.runs.saveRun({
        ...(await world.runs.findRun(key))!,
        split: false,
        parentRunId: parent.id,
        taskId: 't1',
      });
      await world.app.get(PipelineService).step('implement', key);
      const chat = world.app.get(PlanChatStore);
      await chat.appendEntry(key, {
        key: 'answer-ask-implement-attempt-1',
        role: 'planner',
        kind: 'answer',
        from: 'implement',
        text: 'Keep the base version.',
        at: '2026-01-01T00:00:00.000Z',
        state: 'pending',
      });
      const before = agent.mock.calls.length;
      await world.app.get(PipelineService).step('implement', key);
      const prompts = agent.mock.calls.slice(before).map((call) => call[0].prompt);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain('The commit being replayed is');
      expect(prompts[0]).toContain('Keep the base version.');
      expect(await chat.answerFor(key, 'implement')).toBeNull();
    } finally {
      await world.app.close();
    }
  });
});
