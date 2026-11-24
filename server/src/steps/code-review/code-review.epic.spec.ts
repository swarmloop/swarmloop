import 'reflect-metadata';
import { gitWorktree } from '../../testing/git-worktree.spec-helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { sessionFileName, sessionHome } from '../../history/session-group';
import { PipelineService } from '../../pipeline/pipeline.service';
import { EpicRound } from '../shared/epic-round';
import type { Subtask } from '../../contract/subtask';
import { answerFor, boot, reply, reportReply, result, seed, writeEnv } from './code-review.step.spec-helpers';

/** The code review of an epic's parent, with the shipped `EPIC_EFFORT` and the review agent as given. */
async function parentReview(key: string, reviewAgent: string) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-epic-'));
  await writeEnv(root, undefined, undefined, undefined, { AGENTS_REVIEW: reviewAgent });
  gitWorktree(join(root, 'worktrees', key, 'billing-api'));
  const agent = jest.fn(async (input: AgentRunInput) =>
    result(input.step.endsWith('report') ? reportReply('It holds.') : reply('notes', 'ok'), input.step),
  );
  const app = await boot(root, agent);
  try {
    await seed(app, key);
    const runs = app.get(RunRepository);
    const run = (await runs.findRun(key))!;
    run.epicAt = '2026-11-13T10:00:00.000Z';
    await runs.saveRun(run);
    const done = await app.get(PipelineService).step('code-review', key);
    return { done, calls: agent.mock.calls.map((call) => call[0]) };
  } finally {
    await app.close();
  }
}

describe('code review of an epic parent', () => {
  it("launches every reviewer and the report at the review list's effort, not the epic effort", async () => {
    const { done, calls } = await parentReview('PROJ-80', 'claude:claude-opus-5-5:high');
    expect(done.exitCode).toBe(0);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.some((call) => call.step === 'code-review-report')).toBe(true);
    expect(calls.map((call) => call.effort)).toEqual(calls.map(() => 'high'));
  });

  it('keeps an agent that is above the epic effort', async () => {
    const { done, calls } = await parentReview('PROJ-81', 'claude:claude-opus-5-5:max');
    expect(done.exitCode).toBe(0);
    expect(calls.map((call) => call.effort)).toEqual(calls.map(() => 'max'));
  });
});

describe('code review of a subtask', () => {
  const TASKS = JSON.stringify([
    { id: 'a', title: 'Use the tool', description: '', depends: [], files: ['a.ts'], proof: 'a', status: 'running' },
    { id: 'b', title: 'Make the tool', description: '', depends: [], files: ['b.ts'], proof: 'b', status: 'running' },
  ]);

  async function subtaskReview(key: string, parentContract: string | null) {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-subtask-'));
    await writeEnv(root);
    gitWorktree(join(root, 'worktrees', key, 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? reportReply('It holds.') : reply('notes', 'ok'), input.step),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, key);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await runs.openWaiting(`${key}-parent`, '/target');
      await documents.putDocument(parent, 'subtasks', TASKS);
      if (parentContract !== null) await documents.putDocument(parent, 'contract', parentContract);
      const run = (await runs.findRun(key))!;
      run.parentRunId = parent.id;
      run.taskId = 'a';
      await runs.saveRun(run);
      await app.get(PipelineService).step('code-review', key);
      return agent.mock.calls.map((call) => call[0]).filter((call) => !call.step.endsWith('report'));
    } finally {
      await app.close();
    }
  }

  it('gives every reviewer the contract as it is now, with a decision added after the plan', async () => {
    const calls = await subtaskReview(
      'PROJ-82',
      '- tool (owner b): the tool takes a path\n\ndecisions:\n- subtask b at 2026-11-20T09:00:00.000Z: paths are absolute\n',
    );

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.prompt).toContain('Contract:\n- tool (owner b): the tool takes a path');
      expect(call.prompt).toContain('- subtask b at 2026-11-20T09:00:00.000Z: paths are absolute');
      expect(call.prompt).toContain('- b (waiting): Make the tool - files: b.ts - owns: tool (pending)');
    }
  });

  it('adds no parent state to the reviewers of a run that is not a subtask', async () => {
    const { calls } = await parentReview('PROJ-83', 'claude:claude-opus-5-5:high');

    expect(calls.some((call) => call.prompt.includes('Task map'))).toBe(false);
  });
});

describe('a resumed reviewer chat of a subtask', () => {
  const TASKS = JSON.stringify([
    { id: 'a', title: 'Use the tool', description: '', depends: [], files: ['a.ts'], proof: 'a', status: 'running' },
    { id: 'b', title: 'Make the tool', description: '', depends: [], files: ['b.ts'], proof: 'b', status: 'running' },
  ]);
  const CONTRACT =
    '- tool (owner b): the tool takes a path\n\ndecisions:\n- subtask b at 2026-11-20T09:00:00.000Z: paths are absolute\n';
  const CHAT = 'quality-chat';

  /** The quality reviewer's chat resumes; `seen` is what its chat was told before, null for a chat never told. */
  async function resumed(key: string, seen: object | null) {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-resumed-'));
    await writeEnv(root);
    gitWorktree(join(root, 'worktrees', key, 'billing-api'));
    mkdirSync(agentStateDir(root, key, sessionHome('code-review-quality')), { recursive: true });
    writeFileSync(
      join(root, 'data', sessionFileName(key, 'code-review-quality')),
      `${JSON.stringify({ runtime: 'claude', chatId: CHAT, resumed: true, completed: true, killReason: null, usd: 3 })}\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) => ({
      ...result(input.step.endsWith('report') ? reportReply('It holds.') : reply('notes', 'ok'), input.step),
      chatId: `${input.step}-chat`,
    }));
    const app = await boot(root, agent);
    try {
      await seed(app, key);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await runs.openWaiting(`${key}-parent`, '/target');
      await documents.putDocument(parent, 'subtasks', TASKS);
      await documents.putDocument(parent, 'contract', CONTRACT);
      const run = (await runs.findRun(key))!;
      run.parentRunId = parent.id;
      run.taskId = 'a';
      await runs.saveRun(run);
      if (seen) await documents.putDocument(run, 'starter_briefing', JSON.stringify({ [CHAT]: seen }));
      await app.get(PipelineService).step('code-review', key);
      const quality = agent.mock.calls.map((call) => call[0]).find((call) => call.step === 'code-review-quality');
      const record = JSON.parse((await documents.latestBody(key, 'starter_briefing')) ?? '{}') as Record<
        string,
        unknown
      >;
      return { quality, record };
    } finally {
      await app.close();
    }
  }

  it('is told a decision a sibling made since its last prompt, and the next round does not repeat it', async () => {
    const first = await resumed('PROJ-84', { decisions: [], merged: [], items: {} });
    expect(first.quality?.resumeChatId).toBe(CHAT);
    expect(first.quality?.prompt).toContain('New decisions since your last prompt');
    expect(first.quality?.prompt).toContain('paths are absolute');

    const seen = first.record['code-review-quality-chat'];
    const second = await resumed('PROJ-85', seen as object);
    expect(second.quality?.prompt).not.toContain('New decisions since your last prompt');
    expect(second.quality?.prompt).not.toContain('paths are absolute');
  });
});

describe('code review of an epic whose resolution round is open', () => {
  const task = (id: string, status: Subtask['status']): Subtask => ({
    id,
    title: `Task ${id}`,
    description: '',
    depends: [],
    files: [`${id}.ts`],
    proof: id,
    status,
  });

  /** A split run with two open tasks and a merged one; `round` is the body of its epic_round document. */
  async function epicReview(key: string, round: string | null, returning: string | null, tasks: Subtask[]) {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-round-'));
    await writeEnv(root);
    gitWorktree(join(root, 'worktrees', key, 'billing-api'));
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(
        input.step.endsWith('report')
          ? reportReply('It holds.')
          : answerFor(input.step, input.step.endsWith(returning ?? '-') ? 'return' : 'ok'),
        input.step,
      ),
    );
    const app = await boot(root, agent);
    try {
      await seed(app, key);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = (await runs.findRun(key))!;
      run.split = true;
      await runs.saveRun(run);
      await documents.putDocument(run, 'subtasks', JSON.stringify(tasks));
      if (round !== null) await documents.putDocument(run, 'epic_round', round);
      const ended: Subtask[][] = [];
      jest.spyOn(app.get(EpicRound), 'finish').mockImplementation((_parent, moved) => {
        ended.push(moved);
        return Promise.resolve({ conflict: null });
      });
      const done = await app.get(PipelineService).step('code-review', key);
      const after = (await runs.findRun(key))!;
      const body = (kind: string) => documents.latestBody(key, kind);
      return {
        done,
        after,
        ended,
        prompts: agent.mock.calls.map((call) => call[0]).filter((call) => !call.step.endsWith('report')),
        round: await body('epic_round'),
        notes: await body('return'),
        issues: await body('issues'),
      };
    } finally {
      await app.close();
    }
  }

  const OPEN = [task('a', 'merged'), task('b', 'running'), task('c', 'blocked')];

  it('ends the round when every reviewer passes: the tasks move once and the run goes back to implement', async () => {
    const { done, after, ended, round, notes, issues } = await epicReview('PROJ-90', 'open\n', null, OPEN);

    expect(done.exitCode).toBe(0);
    expect(after.currentStep).toBe('implement');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(round?.trim()).toBe('');
    expect(notes?.trim()).toBe('');
    expect(JSON.parse(issues ?? '[]')).toEqual([]);
  });

  it('keeps the round open and moves no task when a reviewer returns', async () => {
    const { after, ended, round, notes } = await epicReview('PROJ-91', 'open\n', 'quality', OPEN);

    expect(after.currentStep).toBe('implement');
    expect(after.attemptsReview).toBe(1);
    expect(ended).toEqual([]);
    expect(round?.trim()).toBe('open');
    expect(notes).toContain('## quality');
  });

  it('tells every reviewer of the resolution and lists the open tasks', async () => {
    const { prompts } = await epicReview('PROJ-92', 'open\n', null, OPEN);

    expect(prompts.length).toBeGreaterThan(1);
    for (const call of prompts) {
      expect(call.prompt).toContain('Conflict resolution');
      expect(call.prompt).toContain('- b: Task b (running)');
      expect(call.prompt).toContain('- c: Task c (blocked)');
      expect(call.prompt).not.toContain('- a: Task a');
    }
  });

  it('keeps the final review of an epic with every task settled and no open round', async () => {
    const { after, ended, prompts } = await epicReview('PROJ-93', null, null, [task('a', 'merged')]);

    expect(after.currentStep).not.toBe('implement');
    expect(ended).toEqual([]);
    expect(prompts.every((call) => !call.prompt.includes('Conflict resolution'))).toBe(true);
  });
});
