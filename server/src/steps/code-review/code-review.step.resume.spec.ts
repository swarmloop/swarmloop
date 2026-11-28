import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AgentRunInput } from '../../agent/agent-runner';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { gitWorktree } from '../../testing/git-worktree.spec-helpers';
import { putStamped } from '../shared/gate.spec-helpers';
import { reply, reportReply, result, boot, seed, writeEnv } from './code-review.step.spec-helpers';

describe('code-review step after an interruption', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;
  let current: jest.Mock;
  const delegate = jest.fn((...args: unknown[]) => current(...args));

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-resume-'));
    await writeEnv(root);
    app = await boot(root, delegate);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs the retried visit of a run whose behavior chat was stored as agent-launch writes it, and returns the launches. */
  async function retried(key: string, completed: boolean): Promise<AgentRunInput[]> {
    gitWorktree(join(root, 'worktrees', key, 'billing-api'));
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', `${key}-code-review-behavior-session.json`),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'behavior-chat', resumed: false, completed, killReason: completed ? null : 'time', usd: 1 })}\n`,
    );
    const agent = jest.fn(async (input: AgentRunInput) =>
      result(input.step.endsWith('report') ? reportReply('The checks are in.') : reply(input.step, 'ok'), input.step),
    );
    current = agent;
    await seed(app, key);
    const runs = app.get(RunRepository);
    const run = await runs.findRun(key);
    run!.status = 'failed';
    run!.currentStep = 'code-review';
    await storeRun(runs, run!);
    for (const name of ['requirements', 'code']) {
      await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
    }
    const done = await app.get(PipelineService).step('code-review', key);
    expect(done.exitCode).toBe(0);
    return agent.mock.calls.map((call) => call[0]);
  }

  it('sends the round prompt to a reviewer whose chat the interrupted round never reached', async () => {
    const calls = await retried('PROJ-96', true);
    const behavior = calls.find((call) => call.step === 'code-review-behavior');

    expect(behavior?.resumeChatId).toBe('behavior-chat');
    expect(behavior?.prompt).toContain('Continue this behavior review.');
    expect(behavior?.prompt).not.toContain('You were interrupted before the decision');
  });

  it('tells a reviewer whose launch reached its chat to continue, and gives the report this round prompt', async () => {
    const calls = await retried('PROJ-97', false);
    const behavior = calls.find((call) => call.step === 'code-review-behavior');
    const report = calls.find((call) => call.step === 'code-review-report');

    expect(behavior?.resumeChatId).toBe('behavior-chat');
    expect(behavior?.prompt).toContain('You were interrupted before the decision');
    expect(report?.prompt).not.toContain('You were interrupted before it was finished');
  });
});
