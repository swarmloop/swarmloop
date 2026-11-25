import { handoffText } from '../shared/handoff';
import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { DocumentEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { AgentRunInput } from '../../agent/agent-runner';
import { PipelineService } from '../../pipeline/pipeline.service';
import { EnvironmentService } from '../../environment/environment.service';
import { RequiredCheckFailed, RequiredCheckRepeated } from '../../environment/project-environments';
import { resultAnswer } from '../../testing/result-answer';
import { implementImproveFollowUp } from './implement.prompts';
import { REBASE_CONFLICT } from '../../git/rebase';
import { type boot, bootOnce, git, result } from './implement.step.spec-helpers';

const improvedAnswer = (implementation: string[], summary: string[], extra: Record<string, unknown> = {}): string =>
  resultAnswer('Done.', { implementation, summary, ...extra });

const once = bootOnce();

const reply = improvedAnswer(['fixed the empty case'], ['fixed the empty case because the return was right']);

describe('implement-improve step', () => {
  it('retries an answer with no result block in the same chat', async () => {
    once.tree('PROJ-69', 'billing-api');
    const agent = jest
      .fn()
      .mockResolvedValueOnce(result('All done, nothing to report.'))
      .mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-69');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-69');

    expect(done.exitCode).toBe(0);
    expect(await agentCalls(app, 'PROJ-69')).toBe(2);
    expect((agent.mock.calls[1]?.[0] as AgentRunInput).prompt).toContain('End with the result block as before.');
  });

  it('stores a second implementation note and waits for code review', async () => {
    const worktree = once.tree('PROJ-70', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-70');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-70');
    expect(done.exitCode).toBe(0);
    expect(done.message).toContain('billing-api');
    expect(done.message).toContain('clean');
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.tools).toBe('write');
    expect(input.mode).toBe('agent');
    expect(input.model).toBe('grok-4.7');
    expect(input.timeLimitMs).toBe(30 * 60 * 1000);
    expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/billing-api']);
    expect(input.allowHosts).toContain('registry.npmjs.org');
    expect(input.prompt).toContain('"decision": "approve"');
    expect(input.prompt).toContain('changed the field parser');
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const notes = await documents.find({
      where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-70'))!.id },
      order: { id: 'ASC' },
    });
    expect(notes).toHaveLength(2);
    expect(notes[1]?.body).toBe('- fixed the empty case\n');
    const run = await app.get(RunRepository).findRun('PROJ-70');
    expect(run?.currentStep).toBe('checks');
    expect(run?.status).toBe('waiting');
    expect(await agentCalls(app, 'PROJ-70')).toBe(1);
    expect(git(worktree, ['status', '--porcelain'])).toBe('');
    await app.get(PipelineService).step('implement-improve', 'PROJ-70');
    expect(
      await documents.find({
        where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-70'))!.id },
      }),
    ).toHaveLength(2);
    expect((await app.get(RunRepository).findRun('PROJ-70'))?.currentStep).toBe('checks');
  });

  it('puts why it returned into the agent prompt', async () => {
    once.tree('PROJ-74', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-74');
    const run = await app.get(RunRepository).findRun('PROJ-74');
    await app.get(DocumentRepository).putDocument(run!, 'return', '## quality\nuse theme.alpha\n');
    await app
      .get(DocumentRepository)
      .putDocument(run!, 'handoff', '## implement\n- changed the parser so empty fields stay\n');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-74');
    expect(done.exitCode).toBe(0);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('Why this returned:');
    expect(input.prompt).toContain('use theme.alpha');
    expect(input.prompt).toContain('What previous steps did:');
    expect(input.prompt).toContain('## implement');
    const handoff = handoffText(await app.get(DocumentRepository).latestBody('PROJ-74', 'handoff'));
    expect(handoff).toContain('## implement');
    expect(handoff).toContain('empty fields stay');
    expect(handoff).toContain('## implement-improve');
    expect(handoff).toContain('return was right');
  });

  it('runs one review agent for every worktree', async () => {
    once.tree('PROJ-73', 'api');
    once.tree('PROJ-73', 'web');
    const agent = jest.fn().mockResolvedValue(result(improvedAnswer(['api fix', 'web fix'], ['both match the plan'])));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-73', 'api\nweb\n');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-73');
    expect(done.exitCode).toBe(0);
    expect(await agentCalls(app, 'PROJ-73')).toBe(1);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/api', '/work/web']);
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const notes = await documents.find({
      where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-73'))!.id },
      order: { id: 'ASC' },
    });
    expect(notes.at(-1)?.body).toContain('- api fix');
    expect(notes.at(-1)?.body).toContain('- web fix');
  });

  it('keeps the first pass notes when the review sends no implementation', async () => {
    once.tree('PROJ-76', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(improvedAnswer([], ['the files already match the plan'])));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-76');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-76');
    expect(done.exitCode).toBe(0);
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const notes = await documents.find({
      where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-76'))!.id },
      order: { id: 'DESC' },
    });
    expect(notes[0]?.body).toBe('- changed the field parser\n');
    expect((await app.get(RunRepository).findRun('PROJ-76'))?.currentStep).toBe('checks');
  });

  it('keeps an unchanged failed commit on the way to code review', async () => {
    const worktree = once.tree('PROJ-77', 'billing-api');
    const agent = jest
      .fn()
      .mockResolvedValue(result(resultAnswer('Done.', { summary: ['the files already match the plan'] })));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-77');
    await failedCommit(app, 'PROJ-77', git(worktree, ['rev-parse', 'HEAD']));
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-77');
    expect(done.exitCode).toBe(0);
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-77');
    expect(run?.currentStep).toBe('checks');
    expect(run?.status).toBe('waiting');
    expect(await agentCalls(app, 'PROJ-77')).toBe(1);
    const returned = await documents.latestBody('PROJ-77', 'return');
    expect(returned).toContain('FAIL api/runs.service.spec.ts expected running');
    expect(returned).not.toContain('The files were not changed. Change the code or the failing test.');
    expect(await documents.latestBody('PROJ-77', 'implementation')).toBe('- changed the field parser\n');
  });

  it('reviews a dirty tree after a pipeline failure', async () => {
    const worktree = once.tree('PROJ-78', 'billing-api');
    const agent = jest.fn().mockImplementation(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 1;\n');
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-78');
    await failedCommit(app, 'PROJ-78', git(worktree, ['rev-parse', 'HEAD']));
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-78');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-78'))?.currentStep).toBe('checks');
  });

  it('reviews when the commit is not the one CI failed', async () => {
    once.tree('PROJ-79', 'billing-api');
    const agent = jest
      .fn()
      .mockResolvedValue(result(resultAnswer('Done.', { summary: ['the files already match the plan'] })));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-79');
    await failedCommit(app, 'PROJ-79', 'abc');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-79');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-79'))?.currentStep).toBe('checks');
  });

  it('keeps the first pass notes and advances when the review writes nothing', async () => {
    once.tree('PROJ-71', 'billing-api');
    const agent = jest
      .fn()
      .mockResolvedValue(
        result(
          resultAnswer('The first pass already matches the plan.', { summary: ['the first pass matches the plan'] }),
        ),
      );
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-71');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-71');
    expect(done.exitCode).toBe(0);
    expect(done.message).toContain('implement-improve done');
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const notes = await documents.find({
      where: { kind: 'implementation', runId: (await app.get(RunRepository).findRun('PROJ-71'))!.id },
      order: { id: 'DESC' },
    });
    expect(notes[0]?.body).toBe('- changed the field parser\n');
    const run = await app.get(RunRepository).findRun('PROJ-71');
    expect(run?.currentStep).toBe('checks');
    expect(run?.status).toBe('waiting');
  });

  it('fails when the second pass commits', async () => {
    const worktree = once.tree('PROJ-72', 'billing-api');
    const agent = jest.fn().mockImplementation(async () => {
      git(worktree, [
        '-c',
        'user.email=dev@example.com',
        '-c',
        'user.name=Dev',
        'commit',
        '--allow-empty',
        '-m',
        'nope',
      ]);
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-72');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-72');
    expect(done.exitCode).toBe(1);
    expect(done.message).toContain('billing-api was committed');
    expect((await app.get(RunRepository).findRun('PROJ-72'))?.status).toBe('failed');
  });

  it('starts a fresh chat with the full prompt when the agent state of the implement chat is gone', async () => {
    const root = once.root();
    once.tree('PROJ-731', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-731-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'implement-chat', resumed: true, completed: true, killReason: null, usd: 1 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-731');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-731');
    expect(done.exitCode).toBe(0);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.resumeChatId).toBeNull();
    expect(input.prompt).toContain('# Implement improve');
    expect(input.prompt).toContain('Ship the field');
  });

  it('continues the implement chat with the follow-up', async () => {
    const root = once.root();
    once.tree('PROJ-732', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-732', 'implement'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-732-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'implement-chat', resumed: true, completed: true, killReason: null, usd: 1 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-732');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-732');
    expect(done.exitCode).toBe(0);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.resumeChatId).toBe('implement-chat');
    expect(input.prompt).toContain('Check the change for logical and technical gaps and fix only those');
    expect(input.prompt).not.toContain('# Implement improve');
    expect(input.prompt).not.toContain('Ship the field');
    expect(input.prompt).not.toContain('add the field');
    expect(input.prompt).not.toContain('changed the field parser');
    expect(input.prompt).not.toContain('What previous steps did');
  });

  describe('a failed server check', () => {
    const FIX_LINE = 'The server check below failed on your files. Run it, fix the cause, run it again.';
    const checksBody = 'billing-api: required check failed (exit 1):\n$ npm run lint\nerror: no-unused-vars';

    async function chat(root: string, key: string): Promise<void> {
      mkdirSync(join(root, 'data'), { recursive: true });
      mkdirSync(join(root, 'data', 'agent-state', key, 'implement'), { recursive: true });
      writeFileSync(
        join(root, 'data', `${key}-implement-session.json`),
        `${JSON.stringify({ runtime: 'cursor', chatId: 'implement-chat', resumed: true, completed: true, killReason: null, usd: 1 })}\n`,
      );
    }

    async function returnedByChecks(app: Awaited<ReturnType<typeof boot>>, key: string): Promise<void> {
      const run = await app.get(RunRepository).findRun(key);
      await app.get(DocumentRepository).putDocument(run!, 'return', `## checks\n${checksBody}\n`);
    }

    it('reaches the relaunched pass, also when the chat is continued', async () => {
      const root = once.root();
      once.tree('PROJ-90', 'billing-api');
      await chat(root, 'PROJ-90');
      const agent = jest.fn().mockResolvedValue(result(reply));
      const app = once.app();
      once.use(agent);
      await seed(app, 'PROJ-90');
      await returnedByChecks(app, 'PROJ-90');
      const done = await app.get(PipelineService).step('implement-improve', 'PROJ-90');
      expect(done.exitCode).toBe(0);
      const prompt = (agent.mock.calls[0]?.[0] as AgentRunInput).prompt;
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).resumeChatId).toBe('implement-chat');
      expect(prompt).toContain('Why this returned:');
      expect(prompt).toContain(`${FIX_LINE}\n## checks\n${checksBody}`);
      expect(prompt).toContain(implementImproveFollowUp(`## checks\n${checksBody}\n`, null));
    });

    it("sends today's follow-up text byte for byte when nothing failed", async () => {
      const root = once.root();
      once.tree('PROJ-91', 'billing-api');
      await chat(root, 'PROJ-91');
      const agent = jest.fn().mockResolvedValue(result(reply));
      const app = once.app();
      once.use(agent);
      await seed(app, 'PROJ-91');
      await app.get(PipelineService).step('implement-improve', 'PROJ-91');
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).prompt).toContain(implementImproveFollowUp(null, null));
    });

    it('reaches code review after the agent fixes the file, with no manual step', async () => {
      const tree = once.tree('PROJ-93', 'billing-api');
      const prompts: string[] = [];
      const agent = jest.fn((input: AgentRunInput) => {
        prompts.push(input.prompt);
        if (prompts.length === 2) writeFileSync(join(tree, 'fixed.ts'), 'export const fixed = true;\n');
        return Promise.resolve(result(reply));
      });
      const app = once.app();
      once.use(agent);
      await seed(app, 'PROJ-93');
      let fingerprint: string | null = null;
      jest.spyOn(app.get(EnvironmentService), 'check').mockImplementation(async (input) => {
        const files = git(tree, ['status', '--porcelain']);
        if (files.includes('fixed.ts')) return { passed: 0, total: 0 };
        if (fingerprint === files) throw new RequiredCheckRepeated('repeated');
        fingerprint = files;
        await app.get(DocumentRepository).putDocument(input.run, 'return', `## checks\n${checksBody}\n`);
        throw new RequiredCheckFailed(checksBody);
      });
      await app.get(PipelineService).runThrough('PROJ-93', { auto: true });
      expect(prompts[1]).toContain(checksBody);
      const run = await app.get(RunRepository).findRun('PROJ-93');
      expect(run?.currentStep).not.toBe('implement-improve');
      expect(run?.status).not.toBe('blocked');
    });
  });

  it('reviews while a rebase marker is pending and leaves that marker', async () => {
    once.tree('PROJ-741', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-741');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-741');
    await documents.putDocument(run!, REBASE_CONFLICT, 'pending\n');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-741');
    expect(done.exitCode).toBe(0);
    expect(await agentCalls(app, 'PROJ-741')).toBe(1);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('logical and technical gaps');
    expect(input.prompt).not.toContain('A rebase is in progress');
    expect((await documents.latestBody('PROJ-741', REBASE_CONFLICT))?.trim()).toBe('pending');
    expect((await runs.findRun('PROJ-741'))?.currentStep).toBe('checks');
  });

  it('reviews a diverged repo without starting a rebase', async () => {
    const worktree = once.tree('PROJ-75', 'billing-api');
    const clone = once.clone('PROJ-75', 'billing-api');
    git(clone, ['config', 'user.email', 'dev@example.com']);
    git(clone, ['config', 'user.name', 'Dev']);
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(worktree, ['add', 'src/field.ts']);
    git(worktree, ['commit', '-m', 'field']);
    mkdirSync(join(clone, 'src'), { recursive: true });
    writeFileSync(join(clone, 'src', 'field.ts'), 'export const field = 2;\n');
    git(clone, ['add', 'src/field.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-75');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-75');
    await documents.putDocument(run!, REBASE_CONFLICT, 'pending\n');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-75');
    expect(done.exitCode).toBe(0);
    expect(await agentCalls(app, 'PROJ-75')).toBe(1);
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('logical and technical gaps');
    expect(input.prompt).not.toContain('finish the checklist in this visit');
    const fresh = await runs.findRun('PROJ-75');
    expect(fresh?.currentStep).toBe('checks');
    expect(fresh?.status).toBe('waiting');
    expect((await documents.latestBody('PROJ-75', REBASE_CONFLICT))?.trim()).toBe('pending');
    expect(git(worktree, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
  });

  it('replaces the approved checklist when a pipeline return answers with a plan', async () => {
    const worktree = once.tree('PROJ-180', 'billing-api');
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(
        improvedAnswer(['fixed the test'], ['the pipeline log required it'], { plan: ['fix the failing test'] }),
      );
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-180');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-180');
    await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-180');
    expect(done.exitCode).toBe(0);
    const record = JSON.parse((await documents.latestBody('PROJ-180', 'requirements')) ?? '{}') as {
      prompt?: string;
      plan?: { items?: string[]; decision?: string };
    };
    expect(record.plan?.items).toEqual(['fix the failing test']);
    expect(record.plan?.decision).toBe('approve');
    expect(record.prompt).toContain('Ship the field');
    const handoff = handoffText(await documents.latestBody('PROJ-180', 'handoff'));
    expect(handoff).toContain('dropped "add the field"');
    expect(handoff).toContain('added "fix the failing test"');
    expect(handoff).toContain('outranks the checklist');
  });

  it('leaves the approved plan when the answer has no plan section', async () => {
    once.tree('PROJ-181', 'billing-api');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-181');
    const done = await app.get(PipelineService).step('implement-improve', 'PROJ-181');
    expect(done.exitCode).toBe(0);
    const documents = app.get(DocumentRepository);
    const record = JSON.parse((await documents.latestBody('PROJ-181', 'requirements')) ?? '{}') as {
      plan?: { items?: string[] };
    };
    expect(record.plan?.items).toEqual(['add the field']);
    expect(handoffText(await documents.latestBody('PROJ-181', 'handoff'))).not.toContain('outranks the checklist');
  });

  it('keeps a repository without a project environment in the agent image', async () => {
    once.tree('PROJ-182', 'billing-api');
    once.tree('PROJ-183', 'billing-web');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-183', 'billing-web\n');
    await app.get(PipelineService).step('implement-improve', 'PROJ-183');
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.project).toBeUndefined();
    expect(input.prompt).not.toContain('# Project environment');
    expect(input.prompt).not.toContain('swarmloop-verify');
  });
});

async function failedCommit(app: Awaited<ReturnType<typeof boot>>, key: string, sha: string): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const run = await runs.findRun(key);
  await documents.putDocument(
    run!,
    'pipeline_ref',
    `project: acme/billing-api\nref: feature/${key}-ship-the-field\nsha: ${sha}\n`,
  );
  await documents.putDocument(
    run!,
    'return',
    '## pipeline\nresult: fail\njob: test\n\nFAIL api/runs.service.spec.ts expected running\n',
  );
}

async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, repos = 'billing-api\n'): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'implement-improve');
  seeded.status = 'waiting';
  seeded.currentStep = 'implement-improve';
  await storeRun(runs, seeded);
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key, summary: 'Ship the field' }], plan: { name: '', overview: '', items: ['add the field'], decision: 'approve' } }, null, 2)}\n`,
  );
  await documents.putDocument(seeded, 'repos', repos);
  await documents.putDocument(seeded, 'implementation', '- changed the field parser\n');
}

async function agentCalls(app: Awaited<ReturnType<typeof boot>>, key: string): Promise<number | undefined> {
  return (await app.get(RunRepository).findRun(key))?.agentCalls;
}
