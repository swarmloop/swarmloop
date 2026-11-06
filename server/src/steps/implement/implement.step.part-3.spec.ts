import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import type { AgentRunInput } from '../../agent/agent-runner';

import { PipelineService } from '../../pipeline/pipeline.service';

import { EnvironmentService } from '../../environment/environment.service';

import { SwarmloopError } from '../../core/swarmloop-error';

import { ARTIFACTS } from '../contract/artifacts';
import { issueOf } from '../shared/handoff';
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

  it('keeps project execution rules on a resumed pipeline retry without preparing twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-retry-policy-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-148', 'billing-api');
    mkdirSync(join(root, 'data'), { recursive: true });
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
      expect(input.prompt).not.toContain('# Project environment');
      expect(input.prompt).not.toContain('swarmloop-verify');
    } finally {
      await app.close();
    }
  });

  it('does not finish implementation when the server check fails despite a successful agent answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-check-failure-'));
    await writeEnv(root);
    featureTree(root, 'PROJ-146', 'billing-web');
    const app = await boot(root, jest.fn().mockResolvedValue(result(reply)));
    try {
      await seed(app, 'PROJ-146', 'approve', 'billing-web\n');
      jest.spyOn(app.get(FlowRepository), 'activePhases').mockResolvedValue(['code-review']);
      jest
        .spyOn(app.get(EnvironmentService), 'check')
        .mockRejectedValue(new SwarmloopError('required check failed: phpunit'));
      const done = await app.get(PipelineService).step('implement', 'PROJ-146');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('required check failed: phpunit');
      const run = await app.get(RunRepository).findRun('PROJ-146');
      expect(run?.status).toBe('failed');
      expect(run?.currentStep).toBe('implement');
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
      const check = jest.spyOn(app.get(EnvironmentService), 'check').mockResolvedValue(undefined);
      const done = await app.get(PipelineService).step('implement', 'PROJ-147');
      expect(done.exitCode).toBe(0);
      expect(check).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  describe('pipeline return on an unchanged worktree', () => {
    async function unchanged(key: string, refSha: (head: string) => string | null) {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-stale-'));
      await writeEnv(root);
      const worktree = featureTree(root, key, 'billing-api');
      git(worktree, ['remote', 'set-url', 'origin', 'https://gitlab.example/group/billing-api.git']);
      const head = git(worktree, ['rev-parse', 'HEAD']);
      const agent = jest.fn(async (_input: AgentRunInput) => result(reply));
      const app = await boot(root, agent);
      await seed(app, key, 'approve');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun(key);
      await documents.putDocument(run!, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const sha = refSha(head);
      const lines = ['project: group/billing-api', `ref: feature/${key}-ship-the-field`];
      await documents.putDocument(run!, 'pipeline_ref', `${[...lines, ...(sha ? [`sha: ${sha}`] : [])].join('\n')}\n`);
      return { app, runs, documents, head, done: await app.get(PipelineService).step('implement', key) };
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
});
