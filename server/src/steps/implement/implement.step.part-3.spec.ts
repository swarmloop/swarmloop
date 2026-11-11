import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { buildAgentArgs } from '../../agent/agent-args';

import { PipelineService } from '../../pipeline/pipeline.service';

import { EnvironmentService } from '../../environment/environment.service';

import { ARTIFACTS } from '../contract/artifacts';
import { issueOf } from '../shared/handoff';
import { DataSource } from 'typeorm';
import { StepStatEntity } from '../../history/entities';
import type { FailedCommand } from '../../environment/environment-types';
import { reply, result, boot, seed, writeEnv, featureTree, git } from './implement.step.spec-helpers';

describe('implement step', () => {
  it('keeps the approved plan when the plan section has no checklist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-prose-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-146', 'billing-api');
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(['plan:', 'The checklist stays.', '', reply].join('\n'));
    });
    const app = await boot(root, agent);
    try {
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
      expect(await documents.latestBody('PROJ-146', 'handoff')).not.toContain('outranks the checklist');
    } finally {
      await app.close();
    }
  });

  it('sends the stored issues to the agent when no return document is stored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-issues-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-148', 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-148', 'approve');
      const documents = app.get(DocumentRepository);
      const run = await app.get(RunRepository).findRun('PROJ-148');
      const issues = [issueOf('pipeline', 'unit failed', 'Assertion failed\n')];
      await documents.putDocument(run!, 'issues', ARTIFACTS.issues.format(issues));
      await app.get(PipelineService).step('implement', 'PROJ-148');
      expect(agent.mock.calls[0]?.[0].prompt).toContain('## pipeline\nAssertion failed');
    } finally {
      await app.close();
    }
  });

  it('saves the plan object from a later reply when the files were unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-json-later-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-147', 'billing-api');
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
        return result(['implementation:', '- not yet', '', 'summary:', '- the log requires it'].join('\n'));
      }
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(
        [
          'plan:',
          JSON.stringify(plan, null, 2),
          '',
          'implementation:',
          '- fixed the test',
          '',
          'summary:',
          '- the files now match the log',
        ].join('\n'),
      );
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-147', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-147');
      await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-147');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const record = JSON.parse((await documents.latestBody('PROJ-147', 'requirements')) ?? '{}') as {
        plan?: { items?: string[] };
      };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(await documents.latestBody('PROJ-147', 'implementation')).toContain('fixed the test');
      expect(await documents.latestBody('PROJ-147', 'handoff')).toContain('added "fix the failing test"');
    } finally {
      await app.close();
    }
  });

  it.each([
    ['a fresh prompt', false],
    ['a resumed prompt', true],
  ])(
    'gives the agent the contract and the subtask summaries on a return of a split run: %s',
    async (_name, resumed) => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-split-return-'));
      await writeEnv(root);
      const worktree = featureTree(root, 'PROJ-150', 'billing-api');
      if (resumed) {
        mkdirSync(join(root, 'data', 'agent-state', 'PROJ-150', 'implement'), { recursive: true });
        writeFileSync(
          join(root, 'data', 'PROJ-150-implement-session.json'),
          JSON.stringify({ runtime: 'cursor', chatId: 'impl-chat', completed: true, usd: 0 }),
        );
      }
      const agent = jest.fn(async (_input: AgentRunInput) => {
        writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
        return result(reply);
      });
      const app = await boot(root, agent);
      try {
        await seed(app, 'PROJ-150', 'approve');
        const runs = app.get(RunRepository);
        const documents = app.get(DocumentRepository);
        const run = (await runs.findRun('PROJ-150'))!;
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
        await app.get(PipelineService).step('implement', 'PROJ-150');
        const prompt = agent.mock.calls[0]?.[0].prompt ?? '';
        expect(agent.mock.calls[0]?.[0].resumeChatId).toBe(resumed ? 'impl-chat' : null);
        expect(prompt).toContain('decisions:\n- subtask a: store UTC');
        expect(prompt).toContain('- Add the column\n  changed: Adds it.\n  files: a.ts');
      } finally {
        await app.close();
      }
    },
  );

  it('adds no contract or subtask summary to the prompt of a run that does not split', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-single-return-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-151', 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-151', 'approve');
      const run = (await app.get(RunRepository).findRun('PROJ-151'))!;
      await app.get(DocumentRepository).putDocument(run, 'return', '## requirements\nthe column is missing\n');
      await app.get(PipelineService).step('implement', 'PROJ-151');
      const prompt = agent.mock.calls[0]?.[0].prompt ?? '';
      expect(prompt).not.toContain('Contract:');
      expect(prompt).not.toContain('Subtasks:');
    } finally {
      await app.close();
    }
  });

  it('keeps project execution rules on a resumed pipeline retry without preparing twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-retry-policy-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-148', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-148', 'implement'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-148-implement-session.json'),
      JSON.stringify({ runtime: 'cursor', chatId: 'impl-chat', completed: true, usd: 0 }),
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-148', 'approve');
      const run = (await app.get(RunRepository).findRun('PROJ-148'))!;
      await app
        .get(DocumentRepository)
        .putDocument(run, 'return', '## pipeline\nresult: fail\njob: test\n\nFAIL npm test\n');
      const prepare = jest.spyOn(app.get(EnvironmentService), 'prepare').mockResolvedValue({
        launch: { image: 'test-image', cliVolume: 'test-cli', path: '/usr/bin', certFile: false, caches: [] },
        record: { repo: 'billing-api', config: { source: '.swarmloop.json', cache: [], checks: ['npm test'] } },
      });
      const done = await app.get(PipelineService).step('implement', 'PROJ-148');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('pipeline failure left unfixed');
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(agent).toHaveBeenCalledTimes(2);
      for (const call of agent.mock.calls) {
        const input = call[0] as AgentRunInput;
        expect(input.resumeChatId).toBe('impl-chat');
        expect(input.prompt).toContain('including resumed sessions');
        expect(input.prompt).toContain('- `npm test`');
        expect(input.prompt).not.toContain('Do not run tests');
        expect(input.project?.image).toBe('test-image');
      }
    } finally {
      await app.close();
    }
  });

  it('fails when a pipeline return leaves the worktree unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-unchanged-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-142', 'billing-api');
    const agent = jest.fn(async (_input: AgentRunInput) => {
      mkdirSync(join(root, 'data'), { recursive: true });
      mkdirSync(join(root, 'data', 'agent-state', 'PROJ-142', 'implement'), { recursive: true });
      writeFileSync(
        join(root, 'data', 'PROJ-142-implement-session.json'),
        `${JSON.stringify({ runtime: 'cursor', chatId: 'impl-chat', resumed: true, completed: true, killReason: null, usd: 0 })}\n`,
      );
      return result(reply);
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-142', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-142');
      await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nFAIL nest npm test\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-142');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('pipeline failure left unfixed');
      expect(agent).toHaveBeenCalledTimes(2);
      const calls = agent.mock.calls.map((call) => call[0]);
      expect(calls[1]?.prompt).toContain('The pipeline failure still stands and the files are unchanged.');
      expect(calls[1]?.prompt).toContain('FAIL nest npm test');
      expect(calls[1]?.prompt).toContain('Do not run tests on this machine.');
      expect(calls[1]?.resumeChatId).toBe('impl-chat');
      const after = await runs.findRun('PROJ-142');
      expect(after?.currentStep).toBe('implement');
      expect(after?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('keeps a repository without a project environment in the agent image with the old rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-no-environment-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-145', 'billing-web');
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-145', 'approve', 'billing-web\n');
      await app.get(PipelineService).step('implement', 'PROJ-145');
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.project).toBeUndefined();
      expect(input.tools).toBe('write');
      const args = buildAgentArgs('claude', input);
      expect(args[args.indexOf('--disallowedTools') + 1]).not.toMatch(/\b(Edit|Write)\b/);
      expect(input.prompt).not.toContain('# Project environment');
      expect(input.prompt).not.toContain('swarmloop-verify');
    } finally {
      await app.close();
    }
  });

  it('leaves the server check to implement-improve when it follows implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-gate-moved-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-147', 'billing-web');
    const app = await boot(root, jest.fn().mockResolvedValue(result(reply)));
    try {
      await seed(app, 'PROJ-147', 'approve', 'billing-web\n');
      const check = jest.spyOn(app.get(EnvironmentService), 'check').mockResolvedValue({ passed: 0, total: 0 });
      const done = await app.get(PipelineService).step('implement', 'PROJ-147');
      expect(done.exitCode).toBe(0);
      expect(check).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  describe('pipeline return on an unchanged worktree', () => {
    async function unchanged(key: string, refSha: (head: string) => string | null, earlierVisit = false) {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-stale-'));
      await writeEnv(root);
      const worktree = featureTree(root, key, 'billing-api');
      git(worktree, ['remote', 'set-url', 'origin', 'https://gitlab.example/group/billing-api.git']);
      const head = git(worktree, ['rev-parse', 'HEAD']);
      if (earlierVisit) {
        writeFileSync(join(worktree, 'fixed-earlier.ts'), 'export const fixed = true;\n');
      }
      const agent = jest.fn(async (_input: AgentRunInput) => result(reply));
      const app = await boot(root, agent);
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
      const { app, runs, documents, head, done } = await unchanged('PROJ-160', () => old);
      try {
        expect(done.exitCode).toBe(0);
        expect(done.message).toContain('no change needed: the failed pipeline ran on an older commit');
        expect(await documents.latestBody('PROJ-160', 'ci_rerun')).toBe(`billing-api ${old} -> ${head}\n`);
        expect((await runs.findRun('PROJ-160'))?.currentStep).toBe('commit');
      } finally {
        await app.close();
      }
    });

    it('still fails when the pipeline ran on the current head', async () => {
      const { app, documents, done } = await unchanged('PROJ-161', (head) => head);
      try {
        expect(done.exitCode).toBe(1);
        expect(done.message).toContain('pipeline failure left unfixed');
        expect(await documents.latestBody('PROJ-161', 'ci_rerun')).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('continues when an earlier visit left a fix on disk that differs from the pipeline commit', async () => {
      const { app, runs, done } = await unchanged('PROJ-163', (head) => head, true);
      try {
        expect(done.exitCode).toBe(0);
        expect(done.message).not.toContain('left unfixed');
        expect((await runs.findRun('PROJ-163'))?.currentStep).not.toBe('implement');
      } finally {
        await app.close();
      }
    });

    it('blocks the second unchanged answer to the same pipeline issue without a relaunch', async () => {
      const { app, agent, issue, done } = await unchanged('PROJ-164', (head) => head);
      try {
        expect(done.exitCode).toBe(1);
        expect(done.message).toContain('pipeline failure left unfixed');
        expect(agent).toHaveBeenCalledTimes(2);
        const second = await app.get(PipelineService).step('implement', 'PROJ-164');
        expect(second.message).toContain(`pipeline failure left unfixed twice: ${issue.title}`);
        expect(agent).toHaveBeenCalledTimes(3);
        expect((await app.get(RunRepository).findRun('PROJ-164'))?.status).toBe('blocked');
      } finally {
        await app.close();
      }
    });

    it('still fails when the pipeline reference has no sha', async () => {
      const { app, done } = await unchanged('PROJ-162', () => null);
      try {
        expect(done.exitCode).toBe(1);
        expect(done.message).toContain('pipeline failure left unfixed');
      } finally {
        await app.close();
      }
    });
  });

  it('keeps the corrected checklist from the first reply when the second changes the files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-second-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-143', 'billing-api');
    let calls = 0;
    const agent = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return result(
          [
            'plan:',
            '- fix the failing test',
            '',
            'implementation:',
            '- not yet',
            '',
            'summary:',
            '- the log requires it',
          ].join('\n'),
        );
      }
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(
        ['implementation:', '- fixed the test', '', 'summary:', '- the files now match the log'].join('\n'),
      );
    });
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-143', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-143');
      await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-143');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      const record = JSON.parse((await documents.latestBody('PROJ-143', 'requirements')) ?? '{}') as {
        plan?: { items?: string[] };
      };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(await documents.latestBody('PROJ-143', 'implementation')).toContain('fixed the test');
      expect(await documents.latestBody('PROJ-143', 'handoff')).toContain('dropped "add the field"');
    } finally {
      await app.close();
    }
  });

  it('stores the corrected checklist when a pipeline return stays unfixed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-plan-unfixed-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-144', 'billing-api');
    const agent = jest
      .fn()
      .mockResolvedValue(
        result(
          [
            'plan:',
            '- fix the failing test',
            '',
            'implementation:',
            '- not yet',
            '',
            'summary:',
            '- the log requires it',
          ].join('\n'),
        ),
      );
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-144', 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-144');
      await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const done = await app.get(PipelineService).step('implement', 'PROJ-144');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('pipeline failure left unfixed');
      const after = await runs.findRun('PROJ-144');
      expect(after?.currentStep).toBe('implement');
      expect(after?.status).toBe('failed');
      const record = JSON.parse((await documents.latestBody('PROJ-144', 'requirements')) ?? '{}') as {
        plan?: { items?: string[]; decision?: string };
      };
      expect(record.plan?.items).toEqual(['fix the failing test']);
      expect(record.plan?.decision).toBe('approve');
    } finally {
      await app.close();
    }
  });

  describe('a return that carries failed commands', () => {
    const red = (tail: string): FailedCommand => ({ repo: 'billing-api', command: 'npm run lint', tail });

    async function visit(key: string, issues: ReturnType<typeof issueOf>[], reruns: FailedCommand[][]) {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-reruns-'));
      await writeEnv(root);
      const worktree = featureTree(root, key, 'billing-api');
      const agent = jest.fn(async (_input: AgentRunInput) => {
        writeFileSync(join(worktree, `edit-${agent.mock.calls.length}.ts`), 'export const edit = 1;\n');
        return result(reply);
      });
      const app = await boot(root, agent);
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
      return { app, done, rerun, prompts, next: after?.currentStep, attempts: after?.attemptsChecks };
    }

    const checksIssue = (failed: FailedCommand[]) =>
      issueOf('checks', 'required checks failed', 'billing-api: required check failed', failed);

    it('sends a follow-up with the new tail while the command stays red, then ends the visit when it passes', async () => {
      const { app, done, rerun, prompts, next, attempts } = await visit(
        'PROJ-400',
        [checksIssue([red('old tail')])],
        [[red('new tail')], []],
      );
      try {
        expect(done.exitCode).toBe(0);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain('billing-api: npm run lint\nnew tail');
        expect(rerun).toHaveBeenCalledTimes(2);
        expect(rerun.mock.calls[0]?.[1]).toEqual([red('old tail')]);
        expect(next).toBe('implement-improve');
        expect(attempts).toBe(2);
      } finally {
        await app.close();
      }
    });

    it('ends the visit after two follow-ups when the command is still red', async () => {
      const { app, done, rerun, prompts, next } = await visit(
        'PROJ-401',
        [checksIssue([red('t0')])],
        [[red('t1')], [red('t2')], [red('t3')]],
      );
      try {
        expect(done.exitCode).toBe(0);
        expect(prompts).toHaveLength(3);
        expect(prompts[2]).toContain('t2');
        expect(rerun).toHaveBeenCalledTimes(3);
        expect(next).toBe('implement-improve');
      } finally {
        await app.close();
      }
    });

    it('sends no follow-up when the first rerun is green', async () => {
      const { app, prompts, rerun } = await visit('PROJ-402', [checksIssue([red('t0')])], [[]]);
      try {
        expect(prompts).toHaveLength(1);
        expect(rerun).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });

    it('reruns nothing for a return without failed commands', async () => {
      const { app, prompts, rerun } = await visit('PROJ-403', [checksIssue([])], []);
      try {
        expect(prompts).toHaveLength(1);
        expect(rerun.mock.calls.flatMap((call) => call[1])).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('takes the failed command of a pipeline issue from its trace when the project runs it as a check', async () => {
      const trace = 'FAIL\n$ npm run lint\nerror: no-undef';
      const pipeline = issueOf('pipeline', 'billing-api lint failed', trace);
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-pipeline-check-'));
      await writeEnv(root);
      const worktree = featureTree(root, 'PROJ-404', 'billing-api');
      const agent = jest.fn(async () => {
        writeFileSync(join(worktree, 'edit.ts'), 'export const edit = 1;\n');
        return result(reply);
      });
      const app = await boot(root, agent);
      try {
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
      } finally {
        await app.close();
      }
    });
  });

  it('counts the shell edits of a turn in the stats of its visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-shell-edits-'));
    await writeEnv(root);
    const worktree = featureTree(root, 'PROJ-405', 'billing-api');
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
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-405', 'approve');
      await app.get(PipelineService).step('implement', 'PROJ-405');
      const stats = await app
        .get(DataSource)
        .getRepository(StepStatEntity)
        .find({ where: { step: 'implement' } });
      expect(stats.map((stat) => stat.shellEdits)).toEqual([2]);
    } finally {
      await app.close();
    }
  });
});
