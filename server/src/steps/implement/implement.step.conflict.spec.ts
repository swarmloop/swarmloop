import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';

import { existsSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';

import type { AgentRunInput } from '../../agent/agent-runner';
import { fingerprintOf, REBASE_CONFLICT } from '../../git/rebase';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { PipelineService } from '../../pipeline/pipeline.service';
import { FlowRepository } from '../../history/flow.repository';
import { hostConflictMarker } from '../shared/host-conflict-marker';
import { ownConflictMarker } from './own-conflict-marker';
import { runJournal } from '../shared/rebase-journal';
import { SubtaskOps } from '../shared/subtask-ops';
import {
  boot,
  conflictedTree,
  featureTree,
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
  await storeRun(runs, { ...run, split: true });
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
      await storeRun(world.runs, {
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
      await storeRun(world.runs, {
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

describe('implement with a parked conflict of a split parent’s own edits', () => {
  const OWN_TEXT = 'The own edits conflict with the merged tasks';
  const ANSWER = {
    key: 'answer-ask-implement-attempt-1',
    role: 'planner',
    kind: 'answer',
    from: 'implement',
    text: 'Keep the base version.',
    at: '2026-01-01T00:00:00.000Z',
    state: 'pending',
  } as const;

  it('leaves a planner answer to another question for the visit that asked it, not the conflict agent', async () => {
    const key = 'PROJ-706-t1';
    const tree = { path: '' };
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (!input.prompt.includes(OWN_TEXT)) return result(implAnswer(['changed the field'], ['did it']));
      writeFileSync(join(tree.path, 'src', 'field.ts'), 'export const field = 3;\n');
      return result(rebaseReply);
    });
    const world = await splitWorld(key, agent);
    tree.path = world.tree;
    try {
      // A task of an epic: not split itself, so its next visit is its own checklist.
      const parent = await world.runs.openWaiting('PROJ-706', '/target');
      const run = (await world.runs.findRun(key))!;
      await storeRun(world.runs, { ...run, split: false, parentRunId: parent.id, taskId: 't1' });
      await world.documents.putDocument(run, 'implementation', '- changed the field\n');
      await world.documents.putDocument(run, REBASE_CONFLICT, ownConflictMarker(OWN_TEXT));
      const chat = world.app.get(PlanChatStore);
      await chat.appendEntry(key, ANSWER);

      await world.app.get(PipelineService).step('implement', key);
      const conflictPrompts = agent.mock.calls.map((call) => call[0].prompt);
      expect(conflictPrompts).toHaveLength(1);
      expect(conflictPrompts[0]).toContain(OWN_TEXT);
      expect(conflictPrompts[0]).not.toContain('Keep the base version.');
      expect((await chat.answerFor(key, 'implement'))?.key).toBe(ANSWER.key);

      await world.app.get(PipelineService).step('implement', key);
      const prompts = agent.mock.calls.slice(1).map((call) => call[0].prompt);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain(OWN_TEXT);
      expect(prompts[0]).toContain('Keep the base version.');
      expect(await chat.answerFor(key, 'implement')).toBeNull();
    } finally {
      await world.app.close();
    }
  });

  it('resolves an own-edits conflict through the one loop and completes its journal', async () => {
    const key = 'PROJ-707';
    const tree = { path: '' };
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.prompt.includes(OWN_TEXT))
        writeFileSync(join(tree.path, 'src', 'field.ts'), 'export const field = 3;\n');
      return result(rebaseReply);
    });
    const world = await splitWorld(key, agent);
    tree.path = world.tree;
    try {
      const run = (await world.runs.findRun(key))!;
      await world.documents.putDocument(run, REBASE_CONFLICT, ownConflictMarker(OWN_TEXT));
      const head = git(world.tree, ['rev-parse', 'origin/main']);
      // The feature branch is on origin, as it is for a parent that has merged tasks: the resolution goes on top of it.
      git(world.tree, ['push', 'origin', `origin/main:refs/heads/${BRANCH(key)}`]);
      git(world.tree, ['fetch', 'origin']);
      const journal = runJournal(world.documents, run);
      await journal.put('billing-api', {
        path: world.tree,
        branch: BRANCH(key),
        oldHead: head,
        fingerprint: await fingerprintOf(world.tree),
        protectRef: `refs/swarmloop/pre-rebase/${BRANCH(key)}`,
        expectedRemoteTip: null,
        baseSha: head,
        ownBase: head,
        checkpoint: 'conflict',
      });

      const done = await world.app.get(PipelineService).step('implement', key);

      expect(done.exitCode).toBe(0);
      expect(agent.mock.calls.map((call) => call[0].prompt)).toHaveLength(1);
      expect(agent.mock.calls[0]?.[0].prompt).toContain(OWN_TEXT);
      expect(git(world.tree, ['status', '--porcelain'])).toBe('');
      expect(git(world.tree, ['ls-remote', 'origin', `refs/heads/${BRANCH(key)}`])).toContain(
        git(world.tree, ['rev-parse', 'HEAD']),
      );
      expect((await journal.entry('billing-api'))?.checkpoint).toBe('completed');
      expect((await world.runs.findRun(key))?.currentStep).toBe('checks');
    } finally {
      await world.app.close();
    }
  });

  it('leaves a planner answer to another question pending when it settles the conflict', async () => {
    const key = 'PROJ-708';
    const tree = { path: '' };
    const agent = jest.fn(async (input: AgentRunInput) => {
      if (input.prompt.includes(OWN_TEXT))
        writeFileSync(join(tree.path, 'src', 'field.ts'), 'export const field = 3;\n');
      return result(rebaseReply);
    });
    const world = await splitWorld(key, agent);
    tree.path = world.tree;
    try {
      const run = (await world.runs.findRun(key))!;
      await world.documents.putDocument(run, REBASE_CONFLICT, ownConflictMarker(OWN_TEXT));
      const chat = world.app.get(PlanChatStore);
      await chat.appendEntry(key, ANSWER);

      await world.app.get(PipelineService).step('implement', key);

      expect(agent).toHaveBeenCalledTimes(1);
      const prompt = agent.mock.calls[0]?.[0].prompt;
      expect(prompt).toContain(OWN_TEXT);
      expect(prompt).not.toContain('Keep the base version.');
      expect((await chat.answerFor(key, 'implement'))?.key).toBe(ANSWER.key);
    } finally {
      await world.app.close();
    }
  });
});

describe('implement resuming a part whose move the squash from git merge base parked', () => {
  it('stands on the new tip with no agent and no commit, and keeps the question the part waited on', async () => {
    const key = 'PROJ-705-t1';
    const agent = jest.fn(async () => result(rebaseReply));
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-retake-'));
    await writeEnv(root);
    const tree = featureTree(root, key, 'billing-api');
    const clone = join(root, 'billing-api');
    git(clone, ['config', 'user.email', 'dev@example.com']);
    git(clone, ['config', 'user.name', 'Dev']);
    // The part stands on the old tip of its epic and has no commit of its own.
    writeFileSync(join(tree, 'epic.ts'), 'epic\n');
    git(tree, ['add', 'epic.ts']);
    git(tree, ['commit', '-m', 'epic']);
    const epicTip = git(tree, ['rev-parse', 'HEAD']);
    // The epic was rewritten: the new tip does not contain the old one.
    writeFileSync(join(clone, 'rewritten.ts'), 'rewritten\n');
    git(clone, ['add', 'rewritten.ts']);
    git(clone, ['commit', '-m', 'rewritten']);
    git(clone, ['push', 'origin', 'main']);
    const newTip = git(clone, ['rev-parse', 'HEAD']);
    // What the old squash left: the worktree at the new tip, the old head kept, the conflict parked.
    const branch = BRANCH(key);
    git(tree, ['update-ref', `refs/swarmloop/pre-rebase/${branch}`, epicTip]);
    git(tree, ['reset', '--hard', newTip]);
    const gitDir = git(tree, ['rev-parse', '--absolute-git-dir']);
    writeFileSync(join(gitDir, 'swarmloop-rebase'), `${newTip}\nfeat(${key}): Ship the field\n`);
    const app = await boot(root, agent);
    try {
      await seed(app, key, 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = (await runs.findRun(key))!;
      // No tip is recorded for the part: it is a run made before tips were. Its parent's journal holds the old epic head.
      const parent = await runs.openWaiting('PROJ-705', '/target');
      await runJournal(documents, parent).put('billing-api', {
        path: '/epic',
        branch: 'feature/PROJ-705-ship-the-field',
        oldHead: epicTip,
        fingerprint: '',
        protectRef: 'refs/swarmloop/pre-rebase/feature/PROJ-705-ship-the-field',
        expectedRemoteTip: null,
        baseSha: newTip,
        checkpoint: 'completed',
      });
      await storeRun(runs, { ...(await runs.findRun(key))!, parentRunId: parent.id, taskId: 't1' });
      await runJournal(documents, run).put('billing-api', {
        path: tree,
        branch,
        oldHead: epicTip,
        fingerprint: await fingerprintOf(tree),
        protectRef: `refs/swarmloop/pre-rebase/${branch}`,
        expectedRemoteTip: null,
        baseSha: newTip,
        checkpoint: 'conflict',
      });
      await documents.putDocument(run, REBASE_CONFLICT, 'pending-implement\n');
      await app.get(PlanChatStore).appendEntry(key, {
        key: 'ask-implement-attempt-1',
        role: 'planner',
        kind: 'question',
        from: 'implement',
        text: 'Which host does the message wait for?',
        at: '2026-01-01T00:00:00.000Z',
        state: 'pending',
      });

      const done = await app.get(PipelineService).step('implement', key);

      expect(done.exitCode).toBe(0);
      expect(agent).not.toHaveBeenCalled();
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(newTip);
      expect(git(tree, ['status', '--porcelain'])).toBe('');
      expect(existsSync(join(gitDir, 'swarmloop-rebase'))).toBe(false);
      const waiting = (await runs.findRun(key))!;
      expect(waiting.status).toBe('waiting');
      expect(storedState(waiting).reason).toMatchObject({ code: 'ASKS_PLANNER' });
      expect(await app.get(PlanChatStore).pendingQuestions(key)).toHaveLength(1);
      expect((await documents.latestBody(key, REBASE_CONFLICT))?.trim()).toBe('review');
    } finally {
      await app.close();
    }
  });
});

describe('implement with a conflict only the code host sees', () => {
  const HOST_TEXT = 'GitHub reports merge conflicts with the base branch';

  async function hostWorld(key: string, phases: string[] | null) {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-host-conflict-'));
    await writeEnv(root);
    featureTree(root, key, 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => result(rebaseReply));
    const app = await boot(root, agent);
    await seed(app, key, 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = (await runs.findRun(key))!;
    if (phases) await app.get(FlowRepository).noteFlow(key, phases, 'implement');
    await documents.putDocument(run, 'implementation', '- changed the field parser\n');
    await documents.putDocument(run, REBASE_CONFLICT, hostConflictMarker(HOST_TEXT));
    return { app, agent, runs, documents };
  }

  it.each([
    ['checks', null],
    ['code-review', ['implementation', 'code-review', 'ci']],
  ])('launches the conflict agent once and jumps to %s', async (next, phases) => {
    const key = `PROJ-71${next === 'checks' ? 1 : 2}`;
    const world = await hostWorld(key, phases);
    try {
      const done = await world.app.get(PipelineService).step('implement', key);
      expect(done.exitCode).toBe(0);
      expect(world.agent).toHaveBeenCalledTimes(1);
      const prompt = world.agent.mock.calls[0]?.[0].prompt;
      expect(prompt).toContain(HOST_TEXT);
      expect(prompt).not.toContain('The commit being replayed is');
      expect(await world.documents.latestBody(key, 'rebase_resolution_result')).toBeTruthy();
      expect((await world.runs.findRun(key))?.currentStep).toBe(next);
      expect((await world.documents.latestBody(key, REBASE_CONFLICT))?.trim()).toBe('review');
    } finally {
      await world.app.close();
    }
  });

  it('leaves a planner answer to another question pending when it settles the conflict', async () => {
    const key = 'PROJ-713';
    const world = await hostWorld(key, null);
    try {
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
      await world.app.get(PipelineService).step('implement', key);
      expect(world.agent).toHaveBeenCalledTimes(1);
      const prompt = world.agent.mock.calls[0]?.[0].prompt;
      expect(prompt).toContain(HOST_TEXT);
      expect(prompt).not.toContain('Keep the base version.');
      expect((await chat.answerFor(key, 'implement'))?.key).toBe('answer-ask-implement-attempt-1');
    } finally {
      await world.app.close();
    }
  });
});
