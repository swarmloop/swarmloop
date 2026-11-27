import 'reflect-metadata';

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { PipelineService } from '../../pipeline/pipeline.service';
import { FAKE_MODEL_KEY } from '../../testing/env.spec-helpers';
import { gitWorktree } from '../../testing/git-worktree.spec-helpers';
import { boot, reply, reportReply, result, seed, writeEnv } from './code-review.step.spec-helpers';

const REVIEWERS = ['requirements', 'quality', 'regressions', 'security', 'performance'].map(
  (name) => `code-review-${name}`,
);

/** The steps of one review round on Claude that were launched with a reader, with `overrides` on the shipped defaults. */
async function readingSteps(key: string, overrides: Record<string, string>): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-code-review-reader-'));
  await writeEnv(root, undefined, 3, 900000, {
    ...FAKE_MODEL_KEY,
    AGENTS_REVIEW: 'claude:m-claude:high',
    ...overrides,
  });
  gitWorktree(join(root, 'worktrees', key, 'billing-api'));
  const agent = jest.fn(async (input: AgentRunInput) =>
    result(input.step.endsWith('report') ? reportReply('The change holds.') : reply('notes', 'ok'), input.step),
  );
  const app = await boot(root, agent);
  try {
    await seed(app, key);
    expect((await app.get(PipelineService).step('code-review', key)).exitCode).toBe(0);
    const calls = agent.mock.calls.map((call) => call[0]);
    expect(calls.map((call) => call.step).sort()).toEqual([...REVIEWERS, 'code-review-report'].sort());
    return calls.filter((call) => call.helper).map((call) => call.step);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('code-review step and the reader', () => {
  it('reads by itself under the shipped READ_ROLES, which name the planners only', async () => {
    expect(await readingSteps('PROJ-911', {})).toEqual([]);
  });

  it('gives the five reviewers the reader when code-review is named, and the report not', async () => {
    expect((await readingSteps('PROJ-912', { READ_ROLES: 'plan,code-review' })).sort()).toEqual([...REVIEWERS].sort());
  });

  it('gives the report the reader when code-review-report is named, and the reviewers not', async () => {
    expect(await readingSteps('PROJ-913', { READ_ROLES: 'code-review-report' })).toEqual(['code-review-report']);
  });
});
