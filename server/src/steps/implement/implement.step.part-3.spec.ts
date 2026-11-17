import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'fs';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { buildAgentArgs } from '../../agent/agent-args';

import { PipelineService } from '../../pipeline/pipeline.service';

import { EnvironmentService } from '../../environment/environment.service';
import { RequiredCheckFailed } from '../../environment/project-environments';

import { ARTIFACTS } from '../contract/artifacts';
import { handoffText, issueOf } from '../shared/handoff';
import { DataSource } from 'typeorm';
import { StepStatEntity } from '../../history/entities';
import type { FailedCommand } from '../../environment/environment-types';
import * as delays from '../../core/delay';
import { clearGitFaults, failGit } from '../../testing/git-fault.spec-helpers';
import { implAnswer, reply, result, bootOnce, seed, git } from './implement.step.spec-helpers';

import type * as GitFault from '../../testing/git-fault.spec-helpers';

jest.mock('child_process', () =>
  jest.requireActual<typeof GitFault>('../../testing/git-fault.spec-helpers').faultyChildProcess(),
);

const once = bootOnce();

describe('implement step', () => {
  it('keeps the approved plan when the plan section has no checklist', async () => {
    const worktree = once.tree('PROJ-146', 'billing-api');
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-146', 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-146');
    await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-146');
    expect(done.exitCode).toBe(0);
    expect(done.message).not.toContain('plan is empty');
    const record = JSON.parse((await documents.latestBody('PROJ-146', 'requirements')) ?? '{}') as {
      plan?: { items?: string[] };
    };
    expect(record.plan?.items).toEqual(['add the field']);
    expect(handoffText(await documents.latestBody('PROJ-146', 'handoff'))).not.toContain('outranks the checklist');
  });

  it('waits with the needs of a subtask whose answer ends with needs:, commits nothing, and ignores the section in any other run', async () => {
    const subtaskTree = once.tree('PROJ-147-t1', 'billing-api');
    const plainTree = once.tree('PROJ-148', 'other');
    const needs = [{ id: 't0', what: 'the retry policy' }];
    const agent = jest.fn(async () => result(implAnswer([], [], { needs })));
    const app = once.app();
    once.use(agent);
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const parent = await runs.openWaiting('PROJ-147', '/target');
    await seed(app, 'PROJ-147-t1', 'approve');
    const child = await runs.findRun('PROJ-147-t1');
    await runs.saveRun({ ...child!, parentRunId: parent.id, taskId: 't1' });
    await seed(app, 'PROJ-148', 'approve', 'other\n');
    const head = git(subtaskTree, ['rev-parse', 'HEAD']);

    await app.get(PipelineService).step('implement', 'PROJ-147-t1');

    const waiting = await runs.findRun('PROJ-147-t1');
    expect(waiting?.currentStep).toBe('implement');
    expect(waiting?.status).toBe('waiting');
    expect(await documents.latestBody('PROJ-147-t1', 'needs')).toBe('needs:\n- t0: the retry policy\n');
    expect(git(subtaskTree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(subtaskTree, ['status', '--porcelain'])).toBe('');

    writeFileSync(join(plainTree, 'field.ts'), 'export const field = 1;\n');
    await app.get(PipelineService).step('implement', 'PROJ-148');
    expect(await documents.latestBody('PROJ-148', 'needs')).toBeNull();
  });

  it('sends the stored issues to the agent when no return document is stored', async () => {
    const worktree = once.tree('PROJ-1481', 'other');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-1481', 'approve', 'other\n');
    const documents = app.get(DocumentRepository);
    const run = await app.get(RunRepository).findRun('PROJ-1481');
    const issues = [issueOf('pipeline', 'unit failed', 'Assertion failed\n')];
    await documents.putDocument(run!, 'issues', ARTIFACTS.issues.format(issues));
    await app.get(PipelineService).step('implement', 'PROJ-1481');
    expect(agent.mock.calls[0]?.[0].prompt).toContain('## pipeline\nAssertion failed');
  });

  it('saves the plan object from a later reply when the files were unchanged', async () => {
    const worktree = once.tree('PROJ-1471', 'billing-api');
    const plan = {
      name: 'Field',
      overview: 'Fix the failing test.',
      items: ['fix the failing test'],
      decision: 'approve',
    };
    let calls = 0;
    const agent = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return result(implAnswer(['not yet'], ['the log requires it']));
      }
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(implAnswer(['fixed the test'], ['the files now match the log'], { plan: plan.items }));
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-1471', 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-1471');
    await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-1471');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-1471'))?.agentCalls).toBe(2);
    const record = JSON.parse((await documents.latestBody('PROJ-1471', 'requirements')) ?? '{}') as {
      plan?: { items?: string[] };
    };
    expect(record.plan?.items).toEqual(['fix the failing test']);
    expect(await documents.latestBody('PROJ-1471', 'implementation')).toContain('fixed the test');
    expect(handoffText(await documents.latestBody('PROJ-1471', 'handoff'))).toContain('added "fix the failing test"');
  });

  it.each([
    ['a fresh prompt', false],
    ['a resumed prompt', true],
  ])(
    'gives the agent the contract and the subtask summaries on a return of a split run: %s',
    async (_name, resumed) => {
      const key = resumed ? 'PROJ-1501' : 'PROJ-150';
      const root = once.root();
      const worktree = once.tree(key, 'billing-api');
      if (resumed) {
        mkdirSync(join(root, 'data', 'agent-state', key, 'implement'), { recursive: true });
        writeFileSync(
          join(root, 'data', `${key}-implement-session.json`),
          JSON.stringify({ runtime: 'cursor', chatId: 'impl-chat', completed: true, usd: 0 }),
        );
      }
      const agent = jest.fn(async (_input: AgentRunInput) => {
        writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
        return result(reply);
      });
      const app = once.app();
      once.use(agent);
      await seed(app, key, 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = (await runs.findRun(key))!;
      run.split = true;
      await runs.saveRun(run);
      await documents.putDocument(run, 'contract', 'decisions:\n- subtask a: store UTC\n');
      await documents.putDocument(
        run,
        'subtasks',
        JSON.stringify([
          {
            id: 'a',
            title: 'Add the column',
            description: 'Adds it.',
            files: ['a.ts'],
            proof: 'a',
            status: 'merged',
          },
        ]),
      );
      await documents.putDocument(run, 'return', '## requirements\nthe column is missing\n');
      await app.get(PipelineService).step('implement', key);
      const prompt = agent.mock.calls[0]?.[0].prompt ?? '';
      expect(agent.mock.calls[0]?.[0].resumeChatId).toBe(resumed ? 'impl-chat' : null);
      expect(prompt).toContain('decisions:\n- subtask a: store UTC');
      expect(prompt).toContain('- Add the column\n  changed: Adds it.\n  files: a.ts');
    },
  );

  it('adds no contract or subtask summary to the prompt of a run that does not split', async () => {
    const worktree = once.tree('PROJ-151', 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-151', 'approve');
    const run = (await app.get(RunRepository).findRun('PROJ-151'))!;
    await app.get(DocumentRepository).putDocument(run, 'return', '## requirements\nthe column is missing\n');
    await app.get(PipelineService).step('implement', 'PROJ-151');
    const prompt = agent.mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).not.toContain('Contract:');
    expect(prompt).not.toContain('Subtasks:');
  });

  it('keeps project execution rules on a resumed pipeline retry without preparing twice', async () => {
    const root = once.root();
    once.tree('PROJ-1482', 'other');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-1482', 'implement'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-1482-implement-session.json'),
      JSON.stringify({ runtime: 'cursor', chatId: 'impl-chat', completed: true, usd: 0 }),
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-1482', 'approve', 'other\n');
    const run = (await app.get(RunRepository).findRun('PROJ-1482'))!;
    await app
      .get(DocumentRepository)
      .putDocument(run, 'return', '## pipeline\nresult: fail\njob: test\n\nFAIL npm test\n');
    const prepared = (image: string) => ({
      launch: { image, cliVolume: 'test-cli', path: '/usr/bin', certFile: false, caches: [] },
      record: { repo: 'billing-api', config: { source: '.swarmloop.json', cache: [], checks: ['npm test'] } },
    });
    // A second prepare would hand the relaunch another image, which the loop below rejects.
    jest
      .spyOn(app.get(EnvironmentService), 'prepare')
      .mockResolvedValueOnce(prepared('test-image'))
      .mockResolvedValue(prepared('second-prepare-image'));
    const done = await app.get(PipelineService).step('implement', 'PROJ-1482');
    expect(done.exitCode).toBe(0);
    expect(done.message).toContain('pipeline failure left unchanged, CI rerun: ');
    expect((await app.get(RunRepository).findRun('PROJ-1482'))?.agentCalls).toBe(2);
    for (const call of agent.mock.calls) {
      const input = call[0] as AgentRunInput;
      expect(input.resumeChatId).toBe('impl-chat');
      expect(input.prompt).toContain('including resumed sessions');
      expect(input.prompt).toContain('- `npm test`');
      expect(input.prompt).not.toContain('Do not run tests');
      expect(input.project?.image).toBe('test-image');
    }
  });

  it('fails when a pipeline return leaves the worktree unchanged', async () => {
    const root = once.root();
    once.tree('PROJ-142', 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      mkdirSync(join(root, 'data'), { recursive: true });
      mkdirSync(join(root, 'data', 'agent-state', 'PROJ-142', 'implement'), { recursive: true });
      writeFileSync(
        join(root, 'data', 'PROJ-142-implement-session.json'),
        `${JSON.stringify({ runtime: 'cursor', chatId: 'impl-chat', resumed: true, completed: true, killReason: null, usd: 0 })}\n`,
      );
      return result(reply);
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-142', 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-142');
    await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nFAIL nest npm test\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-142');
    expect(done.exitCode).toBe(0);
    expect(done.message).toContain('pipeline failure left unchanged, CI rerun: ');
    expect((await app.get(RunRepository).findRun('PROJ-142'))?.agentCalls).toBe(2);
    const calls = agent.mock.calls.map((call) => call[0]);
    expect(calls[1]?.prompt).toContain('The pipeline failure still stands and the files are unchanged.');
    expect(calls[1]?.prompt).toContain('FAIL nest npm test');
    expect(calls[1]?.prompt).toContain('Do not run tests on this machine.');
    expect(calls[1]?.resumeChatId).toBe('impl-chat');
    expect((await runs.findRun('PROJ-142'))?.currentStep).toBe('commit');
  });

  it('keeps a repository without a project environment in the agent image with the old rules', async () => {
    once.tree('PROJ-145', 'billing-web');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-145', 'approve', 'billing-web\n');
    await app.get(PipelineService).step('implement', 'PROJ-145');
    const input = agent.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.project).toBeUndefined();
    expect(input.tools).toBe('write');
    const args = buildAgentArgs('claude', input);
    expect(args[args.indexOf('--disallowedTools') + 1]).not.toMatch(/\b(Edit|Write)\b/);
    expect(input.prompt).not.toContain('# Project environment');
    expect(input.prompt).not.toContain('swarmloop-verify');
  });

  it('leaves the server check to implement-improve when it follows implement', async () => {
    once.tree('PROJ-1472', 'billing-web');
    const app = once.app();
    once.use(jest.fn().mockResolvedValue(result(reply)));
    await seed(app, 'PROJ-1472', 'approve', 'billing-web\n');
    jest
      .spyOn(app.get(EnvironmentService), 'check')
      .mockRejectedValue(new RequiredCheckFailed('billing-web: required check failed'));
    const done = await app.get(PipelineService).step('implement', 'PROJ-1472');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-1472'))?.currentStep).toBe('implement-improve');
  });

  describe('pipeline return on an unchanged worktree', () => {
    async function unchanged(
      key: string,
      refSha: (head: string) => string | null,
      earlierVisit = false,
      answer = reply,
      onFirstAnswer?: () => void,
    ) {
      const worktree = once.tree(key, 'billing-api');
      git(worktree, ['remote', 'set-url', 'origin', 'https://gitlab.example/group/billing-api.git']);
      const head = git(worktree, ['rev-parse', 'HEAD']);
      if (earlierVisit) {
        writeFileSync(join(worktree, 'fixed-earlier.ts'), 'export const fixed = true;\n');
      }
      let answers = 0;
      const agent = jest.fn(async (_input: AgentRunInput) => {
        answers += 1;
        if (answers === 1) onFirstAnswer?.();
        return result(answer);
      });
      const app = once.app();
      once.use(agent);
      await seed(app, key, 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun(key);
      const body = 'Assertion failed\n';
      await documents.putDocument(run!, 'return', `## pipeline\nresult: fail\njob: test\n\n${body}`);
      const issue = issueOf('pipeline', 'billing-api test (test) failed', body);
      await documents.putDocument(run!, 'issues', JSON.stringify([issue]));
      const sha = refSha(head);
      const lines = ['project: group/billing-api', `ref: feature/${key}-ship-the-field`];
      await documents.putDocument(run!, 'pipeline_ref', `${[...lines, ...(sha ? [`sha: ${sha}`] : [])].join('\n')}\n`);
      return { app, agent, runs, documents, head, issue, done: await app.get(PipelineService).step('implement', key) };
    }

    it('asks for a new CI run when the failed pipeline ran on an older commit', async () => {
      const old = 'a'.repeat(40);
      const { runs, documents, head, done } = await unchanged('PROJ-160', () => old);
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('no change needed: the failed pipeline ran on an older commit');
      expect(await documents.latestBody('PROJ-160', 'ci_rerun')).toBe(`billing-api ${old} -> ${head}\n`);
      expect((await runs.findRun('PROJ-160'))?.currentStep).toBe('commit');
    });

    it('still fails when the pipeline ran on the current head', async () => {
      const { runs, documents, issue, done } = await unchanged('PROJ-161', (head) => head);
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('pipeline failure left unchanged, CI rerun: ');
      expect(await documents.latestBody('PROJ-161', 'ci_rerun')).toBe('billing-api\n');
      expect(await documents.latestBody('PROJ-161', 'unfixed_issue')).toBe(issue.id);
      const after = await runs.findRun('PROJ-161');
      expect(after?.currentStep).toBe('commit');
      expect(after?.status).not.toBe('failed');
    });

    it('continues when an earlier visit left a fix on disk that differs from the pipeline commit', async () => {
      const { runs, done } = await unchanged('PROJ-163', (head) => head, true);
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('left unfixed');
      expect((await runs.findRun('PROJ-163'))?.currentStep).not.toBe('implement');
    });

    it('blocks the second unchanged answer to the same pipeline issue without a relaunch', async () => {
      const { app, issue, done } = await unchanged('PROJ-164', (head) => head);
      expect(done.exitCode).toBe(0);
      expect((await app.get(RunRepository).findRun('PROJ-164'))?.agentCalls).toBe(2);
      const second = await app.get(PipelineService).step('implement', 'PROJ-164');
      expect(second.message).toContain(
        `${issue.title} failed twice on the same commit and the agent changed nothing: - changed the parser so empty fields stay`,
      );
      expect((await app.get(RunRepository).findRun('PROJ-164'))?.agentCalls).toBe(3);
      const after = await app.get(RunRepository).findRun('PROJ-164');
      expect(second.exitCode).toBe(1);
      expect(JSON.parse(after?.stateReason ?? '{}')).toMatchObject({ code: 'PIPELINE_UNFIXED' });
    });

    it('jumps with a fallback explanation when the follow-up answer has no summary section', async () => {
      const { app, done } = await unchanged('PROJ-165', (head) => head, false, implAnswer(['nothing to change'], []));
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('CI rerun: the agent gave no explanation');
      const second = await app.get(PipelineService).step('implement', 'PROJ-165');
      expect(second.message).toContain('the agent changed nothing: the agent gave no explanation');
    });

    it('tries a failed probe of the worktree again and still finds the files unchanged', async () => {
      jest.spyOn(delays, 'delay').mockResolvedValue(undefined);
      try {
        const { runs, documents, done } = await unchanged(
          'PROJ-166',
          (head) => head,
          false,
          reply,
          () =>
            failGit(['rev-parse', '--show-toplevel'], { stderr: 'fatal: detected dubious ownership in repository' }),
        );
        expect(done.exitCode).toBe(0);
        expect(await documents.latestBody('PROJ-166', 'ci_rerun')).toBe('billing-api\n');
        const after = await runs.findRun('PROJ-166');
        expect(after?.currentStep).toBe('commit');
        expect(after?.status).not.toBe('failed');
      } finally {
        clearGitFaults();
        jest.restoreAllMocks();
      }
    });

    it('still fails when the pipeline reference has no sha', async () => {
      const { documents, done } = await unchanged('PROJ-162', () => null);
      expect(done.exitCode).toBe(0);
      expect(await documents.latestBody('PROJ-162', 'ci_rerun')).toBe('billing-api\n');
    });
  });

  it('keeps the corrected checklist from the first reply when the second changes the files', async () => {
    const worktree = once.tree('PROJ-143', 'billing-api');
    let calls = 0;
    const agent = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return result(implAnswer(['not yet'], ['the log requires it'], { plan: ['fix the failing test'] }));
      }
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(implAnswer(['fixed the test'], ['the files now match the log']));
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-143', 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-143');
    await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-143');
    expect(done.exitCode).toBe(0);
    expect((await app.get(RunRepository).findRun('PROJ-143'))?.agentCalls).toBe(2);
    const record = JSON.parse((await documents.latestBody('PROJ-143', 'requirements')) ?? '{}') as {
      plan?: { items?: string[] };
    };
    expect(record.plan?.items).toEqual(['fix the failing test']);
    expect(await documents.latestBody('PROJ-143', 'implementation')).toContain('fixed the test');
    expect(handoffText(await documents.latestBody('PROJ-143', 'handoff'))).toContain('dropped "add the field"');
  });

  it('stores the corrected checklist when a pipeline return stays unfixed', async () => {
    once.tree('PROJ-144', 'billing-api');
    const agent = jest
      .fn()
      .mockResolvedValue(result(implAnswer(['not yet'], ['the log requires it'], { plan: ['fix the failing test'] })));
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-144', 'approve');
    const runs = app.get(RunRepository);
    const documents = app.get(DocumentRepository);
    const run = await runs.findRun('PROJ-144');
    await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
    const done = await app.get(PipelineService).step('implement', 'PROJ-144');
    expect(done.exitCode).toBe(0);
    expect(done.message).toContain('pipeline failure left unchanged, CI rerun: ');
    expect((await runs.findRun('PROJ-144'))?.currentStep).toBe('commit');
    const record = JSON.parse((await documents.latestBody('PROJ-144', 'requirements')) ?? '{}') as {
      plan?: { items?: string[]; decision?: string };
    };
    expect(record.plan?.items).toEqual(['fix the failing test']);
    expect(record.plan?.decision).toBe('approve');
  });

  describe('a return that carries failed commands', () => {
    const red = (tail: string): FailedCommand => ({ repo: 'billing-api', command: 'npm run lint', tail });

    async function visit(key: string, issues: ReturnType<typeof issueOf>[], reruns: FailedCommand[][]) {
      const worktree = once.tree(key, 'billing-api');
      const agent = jest.fn(async (_input: AgentRunInput) => {
        writeFileSync(join(worktree, `edit-${agent.mock.calls.length}.ts`), 'export const edit = 1;\n');
        return result(reply);
      });
      const app = once.app();
      once.use(agent);
      await seed(app, key, 'approve');
      const run = (await app.get(RunRepository).findRun(key))!;
      const documents = app.get(DocumentRepository);
      run.attemptsChecks = 2;
      await app.get(RunRepository).saveRun(run);
      await documents.putDocument(run, 'return', `## ${issues[0]?.source}\n${issues[0]?.body}\n`);
      await documents.putDocument(run, ARTIFACTS.issues.kind, ARTIFACTS.issues.format(issues));
      const rerun = jest.spyOn(app.get(EnvironmentService), 'rerun');
      for (const next of reruns) {
        rerun.mockResolvedValueOnce(next);
      }
      const done = await app.get(PipelineService).step('implement', key);
      const prompts = agent.mock.calls.map((call) => call[0].prompt);
      const after = await app.get(RunRepository).findRun(key);
      return {
        app,
        done,
        rerun,
        prompts,
        calls: after?.agentCalls,
        next: after?.currentStep,
        attempts: after?.attemptsChecks,
      };
    }

    const checksIssue = (failed: FailedCommand[]) =>
      issueOf('checks', 'required checks failed', 'billing-api: required check failed', failed);

    it('sends a follow-up with the new tail while the command stays red, then ends the visit when it passes', async () => {
      const { done, rerun, calls, prompts, next, attempts } = await visit(
        'PROJ-400',
        [checksIssue([red('old tail')])],
        [[red('new tail')], []],
      );
      expect(done.exitCode).toBe(0);
      expect(calls).toBe(2);
      expect(prompts[1]).toContain('billing-api: npm run lint\nnew tail');
      expect(rerun.mock.calls[0]?.[1]).toEqual([red('old tail')]);
      expect(next).toBe('implement-improve');
      expect(attempts).toBe(2);
    });

    it('ends the visit after two follow-ups when the command is still red', async () => {
      const { done, rerun, calls, prompts, next } = await visit(
        'PROJ-401',
        [checksIssue([red('t0')])],
        [[red('t1')], [red('t2')], [red('t3')]],
      );
      expect(done.exitCode).toBe(0);
      expect(calls).toBe(3);
      expect(prompts[2]).toContain('t2');
      expect(rerun.mock.calls[2]?.[1]).toEqual([red('t2')]);
      expect(next).toBe('implement-improve');
    });

    it('sends no follow-up when the first rerun is green', async () => {
      const { calls, rerun } = await visit('PROJ-402', [checksIssue([red('t0')])], [[]]);
      expect(calls).toBe(1);
      expect(rerun.mock.calls[0]?.[1]).toEqual([red('t0')]);
    });

    it('reruns nothing for a return without failed commands', async () => {
      const { calls, rerun } = await visit('PROJ-403', [checksIssue([])], []);
      expect(calls).toBe(1);
      expect(rerun.mock.calls.flatMap((call) => call[1])).toEqual([]);
    });

    it('takes the failed command of a pipeline issue from its trace when the project runs it as a check', async () => {
      const trace = 'FAIL\n$ npm run lint\nerror: no-undef';
      const pipeline = issueOf('pipeline', 'billing-api lint failed', trace);
      const worktree = once.tree('PROJ-404', 'billing-api');
      const agent = jest.fn(async () => {
        writeFileSync(join(worktree, 'edit.ts'), 'export const edit = 1;\n');
        return result(reply);
      });
      const app = once.app();
      once.use(agent);
      await seed(app, 'PROJ-404', 'approve');
      const run = (await app.get(RunRepository).findRun('PROJ-404'))!;
      const documents = app.get(DocumentRepository);
      await documents.putDocument(run, 'return', `## pipeline\nresult: fail\njob: lint\n\n${trace}\n`);
      await documents.putDocument(run, ARTIFACTS.issues.kind, ARTIFACTS.issues.format([pipeline]));
      const environments = app.get(EnvironmentService);
      jest.spyOn(environments, 'checkCommands').mockResolvedValue([
        { repo: 'billing-api', command: 'npm test' },
        { repo: 'billing-api', command: 'npm run lint' },
      ]);
      const rerun = jest.spyOn(environments, 'rerun').mockResolvedValue([]);
      await app.get(PipelineService).step('implement', 'PROJ-404');
      expect(rerun.mock.calls[0]?.[1]).toEqual([red(trace)]);
    });
  });

  it('counts the shell edits of a turn in the stats of its visit', async () => {
    const worktree = once.tree('PROJ-405', 'billing-api');
    const bash = (command: string): string =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
      });
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      const stream = [bash("python3 - <<'EOF'\nprint(1)\nEOF"), bash("sed -i 's/a/b/' field.ts"), bash('npm test')];
      return { ...result(reply), output: stream.join('\n') };
    });
    const app = once.app();
    once.use(agent);
    await seed(app, 'PROJ-405', 'approve');
    await app.get(PipelineService).step('implement', 'PROJ-405');
    const stats = await app
      .get(DataSource)
      .getRepository(StepStatEntity)
      .find({ where: { step: 'implement', runId: (await app.get(RunRepository).findRun('PROJ-405'))!.id } });
    expect(stats.map((stat) => stat.shellEdits)).toEqual([2]);
  });
});
