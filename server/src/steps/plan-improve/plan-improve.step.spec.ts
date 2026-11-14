import 'reflect-metadata';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { DocumentEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { AgentRunInput } from '../../agent/agent-runner';
import { resultAnswer } from '../../testing/result-answer';
import { boot, result, seed, storedTasks, writeEnv } from './plan-improve.step.spec-helpers';
import { PipelineService } from '../../pipeline/pipeline.service';

const improved = (items: string[], extra: Record<string, unknown> = {}): string =>
  resultAnswer('Done.', { summary: ['why'], plan: items, ...extra });
const reply = improved(['add the field']);

describe('plan-improve step', () => {
  it('stores a second plan and waits before implementation when approved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-50', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-50');
      const done = await app.get(PipelineService).step('plan-improve', 'PROJ-50');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('plan-improve done');
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mode).toBe('plan');
      expect(input.prompt).toContain('Do not copy these stage-local limits into the implementation checklist');
      expect(input.prompt).not.toContain('Tests run only in the GitLab or GitHub pipeline');
      expect(input.model).toBe('opus-5.5-extra-high');
      expect(input.timeLimitMs).toBe(20 * 60 * 1000);
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/billing-api']);
      expect(input.prompt).toContain('add the field');
      expect(input.prompt).toContain('logical gaps');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan.decision).toBe('approve');
      const run = await app.get(RunRepository).findRun('PROJ-50');
      expect(run?.currentStep).toBe('branch');
      expect(run?.status).toBe('waiting');
      await app.get(PipelineService).step('plan-improve', 'PROJ-50');
      expect(await documents.find({ where: { kind: 'requirements' } })).toHaveLength(stored.length);
      expect((await app.get(RunRepository).findRun('PROJ-50'))?.currentStep).toBe('branch');
    } finally {
      await app.close();
    }
  });

  it('asks a runtime without a plan tool for a plan section, and names no plan tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-'));
    await writeEnv(root);
    writeFileSync(join(root, '.env'), readFileSync(join(root, '.env'), 'utf8').replaceAll('=cursor:', '=claude:'));
    mkdirSync(join(root, 'worktrees', 'PROJ-58', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-58');
      await app.get(PipelineService).step('plan-improve', 'PROJ-58');
      const prompt = (agent.mock.calls[0]?.[0] as AgentRunInput).prompt;
      expect(prompt).toContain('End your final message with exactly one result block');
      expect(prompt).toContain('- plan (array of string, optional)');
      expect(prompt).not.toContain('plan tool');
    } finally {
      await app.close();
    }
  });

  it('puts the Impact section in the prompt and leaves it out without a list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-impact-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-58', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-59', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-58');
      await seed(app, 'PROJ-59');
      const run = await app.get(RunRepository).findRun('PROJ-59');
      await app.get(DocumentRepository).putDocument(run!, 'impact', '- live agent log | step-documents.tsx | kept\n');
      await app.get(PipelineService).step('plan-improve', 'PROJ-58');
      await app.get(PipelineService).step('plan-improve', 'PROJ-59');
      const [plain, withList] = agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt);
      expect(plain).not.toContain('\nImpact:\n');
      expect(withList).toContain('\nImpact:\n- live agent log | step-documents.tsx | kept');
    } finally {
      await app.close();
    }
  });

  it('stores a corrected checklist and advances to implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-fix-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-51', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(improved(['add the field', 'cover the empty case'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-51');
      const done = await app.get(PipelineService).step('plan-improve', 'PROJ-51');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('plan-improve done');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan).toEqual({
        name: '',
        overview: '',
        items: ['add the field', 'cover the empty case'],
        decision: 'approve',
      });
      const run = await app.get(RunRepository).findRun('PROJ-51');
      expect(run?.currentStep).toBe('branch');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('keeps the given plan when the review returns no checklist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-keep-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-52', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(improved([])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-52');
      const done = await app.get(PipelineService).step('plan-improve', 'PROJ-52');
      expect(done.exitCode).toBe(0);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan.items).toEqual(['add the field']);
      const run = await app.get(RunRepository).findRun('PROJ-52');
      expect(run?.currentStep).toBe('branch');
    } finally {
      await app.close();
    }
  });

  it('resumes the plan chat with the follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-resume-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-53', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-53', 'plan'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-53-plan-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'chat-1', resumed: true, completed: true, killReason: null, usd: 1 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-53');
      const done = await app.get(PipelineService).step('plan-improve', 'PROJ-53');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId).toBe('chat-1');
      expect(input.prompt).toContain('Do not copy these stage-local limits into the implementation checklist');
      expect(input.prompt).not.toContain('Tests run only in the GitLab or GitHub pipeline');
      expect(input.prompt).toContain('logical gaps');
      expect(input.prompt).not.toContain('# Plan improve');
      expect(input.prompt).not.toContain('ship the field');
      expect(input.prompt).not.toContain('add the field');
      expect(input.prompt).not.toContain('What previous steps did');
    } finally {
      await app.close();
    }
  });
});

const correctedTasks = [
  { id: 'column', title: 'Add the column', depends: [], files: ['a.ts'], proof: 'a.spec.ts', description: 'Adds it.' },
  {
    id: 'api',
    title: 'Send it, and read it',
    depends: ['column'],
    files: ['b.ts'],
    proof: 'b.spec.ts',
    description: 'Sends it.',
  },
];

const splitAnswer = (extra: Record<string, unknown> = {}, tasks = correctedTasks): string =>
  resultAnswer('Done.', {
    summary: ['fixed the contract'],
    contract: ['the column is called `split_on`'],
    tasks,
    ...extra,
  });

const correctedReply = splitAnswer();

describe('plan-improve step with split', () => {
  async function improveSplit(
    key: string,
    answer: string,
    options: { split?: boolean; tasks?: boolean; stored?: typeof storedTasks; keep?: string } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-split-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(answer));
    const app = await boot(root, agent);
    try {
      await seed(app, key);
      const runs = app.get(RunRepository);
      const run = (await runs.findRun(key))!;
      await runs.saveRun({ ...run, split: options.split ?? true });
      if (options.tasks ?? true) {
        const documents = app.get(DocumentRepository);
        await documents.putDocument(run, 'subtasks', `${JSON.stringify(options.stored ?? storedTasks)}\n`);
        await documents.putDocument(run, 'contract', '- the column is called `split`\n');
        if (options.keep) await documents.putDocument(run, 'keep', options.keep);
      }
      const done = await app.get(PipelineService).step('plan-improve', key);
      const documents = app.get(DocumentRepository);
      return {
        done,
        agent,
        run: await runs.findRun(key),
        subtasks: await documents.latestBody(key, 'subtasks'),
        contract: await documents.latestBody(key, 'contract'),
        keep: await documents.latestBody(key, 'keep'),
        requirements: await documents.latestBody(key, 'requirements'),
      };
    } finally {
      await app.close();
    }
  }

  it('writes corrected subtasks and contract', async () => {
    const out = await improveSplit('PROJ-90', correctedReply);
    expect(out.done.exitCode).toBe(0);
    const prompt = (out.agent.mock.calls[0]?.[0] as AgentRunInput).prompt;
    expect(prompt).toContain('Tasks:');
    expect(prompt).toContain('the column is called `split`');
    expect(out.run?.currentStep).toBe('branch');
    expect(out.contract).toContain('split_on');
    expect(JSON.parse(out.subtasks ?? '[]')[1].title).toBe('Send it, and read it');
    expect(JSON.parse(out.requirements ?? '{}').plan).toMatchObject({
      decision: 'approve',
      items: [
        'Add the column - files: a.ts - proof: a.spec.ts',
        'Send it, and read it - files: b.ts - proof: b.spec.ts',
      ],
    });
  });

  it('a split turned back into one plan writes an empty subtasks', async () => {
    const out = await improveSplit('PROJ-91', improved(['add the field']));
    expect(out.done.exitCode).toBe(0);
    expect(JSON.parse(out.subtasks ?? 'null')).toEqual([]);
    expect(JSON.parse(out.requirements ?? '{}').plan.items).toEqual(['add the field']);
  });

  it('an invalid graph is a plan error and never reaches implement', async () => {
    const out = await improveSplit(
      'PROJ-92',
      splitAnswer({}, [{ ...correctedTasks[0], depends: ['nope'] }, correctedTasks[1]]),
    );
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('task column depends on unknown task nope');
    expect(out.run?.currentStep).toBe('plan-improve');
    expect(JSON.parse(out.subtasks ?? '[]')).toEqual(storedTasks);
  });

  describe('the keep: section', () => {
    const keepLine = { capability: 'login works', proof: 'login.spec.ts', tasks: ['column'] };
    const withKeep = (line: typeof keepLine): string => splitAnswer({ keep: [line] });
    const prompts = (agent: jest.Mock) => agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt);

    it('stores a valid section as the keep document', async () => {
      const out = await improveSplit('PROJ-97', withKeep(keepLine));
      expect(out.done.exitCode).toBe(0);
      expect(JSON.parse(out.keep ?? '[]')).toEqual([
        { capability: 'login works', proof: 'login.spec.ts', tasks: ['column'] },
      ]);
    });

    it('shows the stored lines in the next prompt, and not when there are none', async () => {
      const stored = JSON.stringify([{ capability: 'login works', proof: 'login.spec.ts', tasks: ['column'] }]);
      const shown = await improveSplit('PROJ-98', correctedReply, { keep: stored });
      expect(prompts(shown.agent)[0]).toContain('- login works (proof: login.spec.ts)');
      const plain = await improveSplit('PROJ-99', correctedReply);
      expect(prompts(plain.agent)[0]).not.toContain('Keep:\n');
      expect(JSON.parse(plain.keep ?? 'null')).toEqual([]);
    });

    it('asks once in the same chat when a line names an unknown task', async () => {
      const out = await improveSplit('PROJ-100', withKeep({ ...keepLine, tasks: ['ghost'] }));
      expect(out.done.exitCode).toBe(1);
      expect(prompts(out.agent)).toHaveLength(3);
      expect(prompts(out.agent)[1]).toContain('unknown task ghost');
    });

    it('clears the lines when the split turns back into one plan', async () => {
      const stored = JSON.stringify([{ capability: 'login works', proof: 'login.spec.ts', tasks: ['column'] }]);
      const out = await improveSplit('PROJ-101', improved(['add the field']), {
        keep: stored,
      });
      expect(JSON.parse(out.keep ?? 'null')).toEqual([]);
    });
  });

  describe('at the default task limit', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, n) => ({ ...storedTasks[0], id: `t${n}`, title: `Task ${n}` }));
    const answerOf = (count: number) =>
      resultAnswer('Done.', {
        summary: ['merged'],
        contract: ['one field'],
        tasks: Array.from({ length: count }, (_, n) => ({
          id: `t${n}`,
          title: `Task ${n}`,
          depends: [],
          files: ['a.ts'],
          proof: 'a.spec.ts',
          description: 'Adds it.',
        })),
      });
    const prompts = (agent: jest.Mock) => agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt);

    it('does not ask for a merge when the plan is at the limit', async () => {
      const out = await improveSplit('PROJ-94', answerOf(48), { stored: many(48) });
      expect(out.done.exitCode).toBe(0);
      expect(prompts(out.agent)[0]).not.toContain('Merge');
      expect(JSON.parse(out.subtasks ?? '[]')).toHaveLength(48);
    });

    it('asks once to merge a plan over the limit and writes the merged plan', async () => {
      const out = await improveSplit('PROJ-95', answerOf(48), { stored: many(49) });
      expect(out.done.exitCode).toBe(0);
      expect(prompts(out.agent)).toHaveLength(1);
      expect(prompts(out.agent)[0]).toContain('The plan has 49 tasks and the limit is 48.');
      expect(JSON.parse(out.subtasks ?? '[]')).toHaveLength(48);
    });

    it('ends in a plan error when the merged plan is still over the limit', async () => {
      const out = await improveSplit('PROJ-96', answerOf(49), { stored: many(49) });
      expect(out.done.exitCode).toBe(1);
      expect(out.done.message).toContain('too many tasks: 49, the limit is 48');
      expect(prompts(out.agent)).toHaveLength(3);
      expect(prompts(out.agent)[1]).toContain('too many tasks: 49, the limit is 48');
      expect(out.run?.currentStep).toBe('plan-improve');
    });
  });

  it('a run that does not split is unchanged', async () => {
    const out = await improveSplit('PROJ-93', reply, { split: false, tasks: false });
    expect(out.done.exitCode).toBe(0);
    expect(out.subtasks).toBeFalsy();
    expect((out.agent.mock.calls[0]?.[0] as AgentRunInput).prompt).not.toContain('## Split');
  });
});
