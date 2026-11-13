import 'reflect-metadata';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { boot, result, seed, writeEnv } from './code-review.step.spec-helpers';

/** The code review of an epic's parent, with `EPIC_EFFORT=xhigh` and the review agent as given. */
async function parentReview(key: string, reviewAgent: string) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-epic-'));
  await writeEnv(root);
  const envFile = join(root, '.env');
  const env = readFileSync(envFile, 'utf8')
    .replace(/AGENTS_REVIEW=.*/, `AGENTS_REVIEW=${reviewAgent}`)
    .concat('EPIC_EFFORT=xhigh\n');
  writeFileSync(envFile, env);
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  const agent = jest.fn(async (input: AgentRunInput) =>
    result(input.step.endsWith('report') ? 'It holds.\n' : 'notes\n\ndecision: ok\n', input.step),
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
  it('launches every reviewer and the report at the epic effort', async () => {
    const { done, calls } = await parentReview('PROJ-80', 'claude:claude-opus-5-5');
    expect(done.exitCode).toBe(0);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.some((call) => call.step === 'code-review-report')).toBe(true);
    expect(calls.map((call) => call.effort)).toEqual(calls.map(() => 'xhigh'));
  });

  it('keeps an agent that is above the epic effort', async () => {
    const { done, calls } = await parentReview('PROJ-81', 'claude:claude-opus-5-5:max');
    expect(done.exitCode).toBe(0);
    expect(calls.map((call) => call.effort)).toEqual(calls.map(() => 'max'));
  });
});
