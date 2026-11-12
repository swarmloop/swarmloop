import 'reflect-metadata';
import { SwarmloopError } from '../../core/swarmloop-error';
import { EnvironmentService } from '../../environment/environment.service';
import { runGit } from '../../git/git-repo.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { goldenRun, type GoldenApp } from './implement.golden.spec-helpers';
import { reply, result } from './implement.step.spec-helpers';
import { ARTIFACTS } from '../contract/artifacts';
import { issueOf } from '../shared/handoff';

const agent = () => jest.fn().mockResolvedValue(result(reply));

describe('implement step golden traces', () => {
  it('ok', async () => {
    const done = await goldenRun({ step: 'implement', key: 'PROJ-300', scenario: 'ok', agent: agent() });
    expect(done.exitCode).toBe(0);
  });

  it('a thrown SwarmloopError', async () => {
    const done = await goldenRun({
      step: 'implement',
      key: 'PROJ-301',
      scenario: 'swarmloop-error',
      agent: agent(),
      prepare: async ({ app }) => {
        jest
          .spyOn(app.get(EnvironmentService), 'prepare')
          .mockRejectedValue(new SwarmloopError('environment setup failed'));
      },
    });
    expect(done.message).toContain('environment setup failed');
  });

  it('a plain Error from a stubbed dependency', async () => {
    const done = await goldenRun({
      step: 'implement',
      key: 'PROJ-302',
      scenario: 'plain-error',
      agent: agent(),
      prepare: async ({ app }) => {
        jest.spyOn(app.get(EnvironmentService), 'prepare').mockRejectedValue(new Error('boom'));
      },
    });
    expect(done.message).toContain('implement failed');
  });

  describe('a pipeline return that the retry leaves unchanged', () => {
    async function prepare(
      app: GoldenApp,
      key: string,
      worktree: string,
      sha: (head: string) => string | null,
    ): Promise<void> {
      runGit(worktree, ['remote', 'set-url', 'origin', 'https://gitlab.example/group/billing-api.git']);
      const head = runGit(worktree, ['rev-parse', 'HEAD']).trim();
      const documents = app.get(DocumentRepository);
      const run = (await app.get(RunRepository).findRun(key))!;
      await documents.putDocument(run, 'return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');
      const found = sha(head);
      const lines = ['project: group/billing-api', `ref: feature/${key}-ship-the-field`];
      await documents.putDocument(
        run,
        'pipeline_ref',
        `${[...lines, ...(found ? [`sha: ${found}`] : [])].join('\n')}\n`,
      );
    }

    it('on an older commit it jumps to commit with ci_rerun', async () => {
      const done = await goldenRun({
        step: 'implement',
        key: 'PROJ-303',
        scenario: 'pipeline-return-stale',
        agent: agent(),
        prepare: ({ app, worktree }) => prepare(app, 'PROJ-303', worktree, () => 'a'.repeat(40)),
      });
      expect(done.message).toContain('the failed pipeline ran on an older commit');
    });

    it('with no stale repo it jumps to commit with a CI rerun', async () => {
      const done = await goldenRun({
        step: 'implement',
        key: 'PROJ-304',
        scenario: 'pipeline-return-unfixed',
        agent: agent(),
        prepare: ({ app, worktree }) => prepare(app, 'PROJ-304', worktree, (head) => head),
      });
      expect(done.message).toContain('pipeline failure left unchanged, CI rerun: ');
    });
  });

  it('a checks return whose command is red after the turn gets one follow-up', async () => {
    const failed = { repo: 'billing-api', command: 'npm run lint', tail: '$ npm run lint\nerror: no-unused-vars' };
    const done = await goldenRun({
      step: 'implement',
      key: 'PROJ-306',
      scenario: 'checks-return',
      agent: agent(),
      prepare: async ({ app }) => {
        const run = (await app.get(RunRepository).findRun('PROJ-306'))!;
        const documents = app.get(DocumentRepository);
        const issue = issueOf(
          'checks',
          'required checks failed',
          `billing-api: required check failed:\n${failed.tail}`,
          [failed],
        );
        await documents.putDocument(run, 'return', `## checks\n${issue.body}\n`);
        await documents.putDocument(run, ARTIFACTS.issues.kind, ARTIFACTS.issues.format([issue]));
        jest
          .spyOn(app.get(EnvironmentService), 'rerun')
          .mockResolvedValueOnce([{ ...failed, tail: '$ npm run lint\nerror: no-undef' }])
          .mockResolvedValueOnce([]);
      },
    });
    expect(done.exitCode).toBe(0);
  });

  it('blocks in auto when MAX_AGENT_CALLS is reached', async () => {
    const done = await goldenRun({
      step: 'implement',
      key: 'PROJ-305',
      scenario: 'max-agent-calls-blocked',
      agent: agent(),
      options: { auto: true },
      prepare: async ({ app }) => {
        const runs = app.get(RunRepository);
        const run = (await runs.findRun('PROJ-305'))!;
        run.agentCalls = 20;
        await runs.saveRun(run);
      },
    });
    expect(done.message).toContain('implement does not fit');
  });
});
