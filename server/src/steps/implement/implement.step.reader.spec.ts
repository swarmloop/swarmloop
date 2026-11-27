import 'reflect-metadata';

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { FAKE_MODEL_KEY } from '../../testing/env.spec-helpers';
import { PipelineService } from '../../pipeline/pipeline.service';
import { readerPrompt } from '../shared/skill-prompt';
import { boot, featureTree, reply, result, seed, writeEnv } from './implement.step.spec-helpers';

/** The agent input of one implement run on Claude, with the reader list and roles the shipped defaults say plus `overrides`. */
async function implementInput(key: string, overrides: Record<string, string>): Promise<AgentRunInput> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-reader-'));
  await writeEnv(root, 1800000, { ...FAKE_MODEL_KEY, AGENTS_IMPLEMENT: 'claude:m-claude:high', ...overrides });
  featureTree(root, key, 'billing-api');
  const agent = jest.fn().mockResolvedValue(result(reply));
  const app = await boot(root, agent);
  try {
    await seed(app, key, 'approve');
    expect((await app.get(PipelineService).step('implement', key)).exitCode).toBe(0);
    return agent.mock.calls[0][0] as AgentRunInput;
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('implement step and the reader', () => {
  it('reads by itself under the shipped READ_ROLES, which name the planners only', async () => {
    const input = await implementInput('PROJ-901', {});
    expect(input.runtime).toBe('claude');
    expect(input.helper).toBeUndefined();
  });

  it('launches with the reader and its skill once READ_ROLES names implement', async () => {
    const input = await implementInput('PROJ-902', { READ_ROLES: 'plan,implement' });
    expect(input.helper).toEqual({ model: 'claude-haiku-5-5', effort: 'medium', prompt: readerPrompt() });
  });
});
