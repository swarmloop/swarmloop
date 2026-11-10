import 'reflect-metadata';

import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { deriveState } from '../../history/run-state';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { boot, featureTree, reply, result, seed, writeEnv } from './implement.step.spec-helpers';

const LIMIT_TEXT = "You've hit your 5-hour limit · resets 9:50pm (UTC)";
const RESETS_AT = new Date(Date.now() + 3_600_000).toISOString();

async function envWith(root: string, agents: string): Promise<void> {
  await writeEnv(root);
  const env = (await readFile(join(root, '.env'), 'utf8')).replace('ANTHROPIC_API_KEY=', 'ANTHROPIC_API_KEY=key');
  await writeFile(join(root, '.env'), `${env}CODEX_API_KEY=key\nAGENTS_IMPLEMENT=${agents}\n`);
}

const limited = () => ({ ...result(LIMIT_TEXT), limit: { window: '5-hour', resetsAt: RESETS_AT } });

describe('implement step and a provider limit', () => {
  it('waits for the limit and never reports the missing implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-limit-wait-'));
    await envWith(root, 'claude:m-claude');
    featureTree(root, 'PROJ-310', 'billing-api');
    const agent = jest.fn().mockResolvedValue(limited());
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-310', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-310');
      const run = (await app.get(RunRepository).findRun('PROJ-310'))!;

      expect(done.message).not.toContain('implementation is missing');
      expect(run.status).toBe('waiting');
      expect(run.currentStep).toBe('implement');
      expect(deriveState(run).reason?.code).toBe('RUNTIME_LIMIT');
      expect(agent).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('continues on the next agent in a new chat, and records the work under the agent that did it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-limit-switch-'));
    await envWith(root, 'claude:m-claude,codex:m-codex');
    featureTree(root, 'PROJ-311', 'billing-api');
    const agent = jest.fn(async (input: AgentRunInput) => (input.runtime === 'claude' ? limited() : result(reply)));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-311', 'approve');
      const done = await app.get(PipelineService).step('implement', 'PROJ-311');
      const calls = agent.mock.calls.map((call) => call[0]);
      const run = (await app.get(RunRepository).findRun('PROJ-311'))!;
      const visits = await app.get(VisitRepository).listStats(run.id);

      expect(done.exitCode).toBe(0);
      expect(calls.map((call) => `${call.runtime}:${call.model}`)).toEqual(['claude:m-claude', 'codex:m-codex']);
      expect(calls[1]?.resumeChatId ?? null).toBeNull();
      expect(
        visits
          .filter((visit) => visit.step === 'implement')
          .map((visit) => [visit.status, visit.runtime, visit.attempt]),
      ).toEqual([
        ['interrupted', 'claude', 1],
        ['done', 'codex', 1],
      ]);
    } finally {
      await app.close();
    }
  });
});
