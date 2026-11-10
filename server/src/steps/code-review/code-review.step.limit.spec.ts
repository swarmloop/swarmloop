import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { mkdirSync } from 'fs';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput, AgentRunResult } from '../../agent/agent-runner';
import { AGENT_RUNNER } from '../../agent/agent-runner';
import { SwarmloopConfigModule } from '../../config/config.module';
import { Clock } from '../../core/clock';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { deriveState } from '../../history/run-state';
import { RunRepository } from '../../history/run.repository';
import { RuntimeCooldownRepository } from '../../history/runtime-cooldown.repository';
import { VisitRepository } from '../../history/visit.repository';
import { CommandService } from '../../pipeline/command.service';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { Reconciler } from '../../pipeline/reconciler';
import { SandboxService } from '../../sandbox/sandbox.service';
import { reply, result, seed, writeEnv } from './code-review.step.spec-helpers';

const START = Date.parse('2026-11-08T18:42:00Z');
const RESETS_AT = '2026-11-08T21:50:00.000Z';
/** The recorded text of run-mw85iykj: what the answer of a limited reviewer says. */
const LIMIT_TEXT = "You've hit your 5-hour limit · resets 9:50pm (UTC)";

function limited(step: string): AgentRunResult {
  return { ...result(LIMIT_TEXT, step), limit: { window: '5-hour', resetsAt: RESETS_AT } };
}

/** The agents of the review role, in the order a limit moves a launch along. */
async function envWith(root: string, agents: string): Promise<void> {
  await writeEnv(root);
  const env = (await readFile(join(root, '.env'), 'utf8')).replace('ANTHROPIC_API_KEY=', 'ANTHROPIC_API_KEY=key');
  await writeFile(join(root, '.env'), `${env}CODEX_API_KEY=key\nAGENTS_REVIEW=${agents}\n`);
}

async function boot(root: string, agent: jest.Mock, clock: FakeClock) {
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
}

function answers(limitedOn: (input: AgentRunInput) => boolean) {
  return jest.fn(async (input: AgentRunInput) => {
    if (limitedOn(input)) {
      return limited(input.step);
    }
    return result(input.step.endsWith('report') ? 'The checks are in.\n' : reply(input.step, 'ok'), input.step);
  });
}

describe('code-review step and a provider limit', () => {
  it('relaunches the limited reviewers on the next agent at once, keeps the other answers and counts no attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-review-limit-switch-'));
    await envWith(root, 'claude:m-claude,codex:m-codex');
    mkdirSync(join(root, 'worktrees', 'PROJ-301', 'billing-api'), { recursive: true });
    const agent = answers(
      (input) => input.runtime === 'claude' && /quality|regressions/.test(input.step) && !input.step.endsWith('report'),
    );
    const app = await boot(root, agent, new FakeClock(START));
    try {
      await seed(app, 'PROJ-301');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-301');
      const calls = agent.mock.calls.map((call) => call[0]);
      const of = (name: string) => calls.filter((call) => call.step === `code-review-${name}`);

      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('review_quality ok');
      expect(done.message).toContain('review_regressions ok');
      expect(of('quality').map((call) => `${call.runtime}:${call.model}`)).toEqual([
        'claude:m-claude',
        'codex:m-codex',
      ]);
      expect(of('regressions').map((call) => call.runtime)).toEqual(['claude', 'codex']);
      // The reviewers that answered ran once. The one that moved starts a new chat with the full brief.
      expect(of('security')).toHaveLength(1);
      expect(of('requirements')).toHaveLength(1);
      expect(of('quality')[1]?.resumeChatId ?? null).toBeNull();
      expect(of('quality')[1]?.prompt).toContain('/work/brief/diff.md');
      const run = (await app.get(RunRepository).findRun('PROJ-301'))!;
      const quality = (await app.get(VisitRepository).listStats(run.id)).filter(
        (stat) => stat.step === 'code-review-quality',
      );
      expect(quality.map((stat) => [stat.status, stat.runtime, stat.model, stat.attempt])).toEqual([
        ['interrupted', 'claude', 'm-claude', 1],
        ['done', 'codex', 'm-codex', 1],
      ]);
      expect(quality[0]?.killReason).toBe('RUNTIME_LIMIT');
      expect([...(await app.get(RuntimeCooldownRepository).cooling(START))]).toEqual(['claude']);
    } finally {
      await app.close();
    }
  });

  it('waits with RUNTIME_LIMIT when no other agent is left and goes on once, by itself, after the reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-review-limit-wait-'));
    await envWith(root, 'claude:m-claude');
    mkdirSync(join(root, 'worktrees', 'PROJ-302', 'billing-api'), { recursive: true });
    const clock = new FakeClock(START);
    const agent = answers((input) => /quality|regressions/.test(input.step) && !input.step.endsWith('report'));
    const app = await boot(root, agent, clock);
    try {
      await seed(app, 'PROJ-302');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-302');
      const run = (await app.get(RunRepository).findRun('PROJ-302'))!;
      const state = deriveState(run);

      expect(done.message).not.toContain('decision is missing');
      expect(run.status).toBe('waiting');
      expect(run.currentStep).toBe('code-review');
      expect(state.reason?.code).toBe('RUNTIME_LIMIT');
      expect(state.reason?.limit).toMatchObject({ runtime: 'claude', resetsAt: RESETS_AT });
      // A minute after the reset the provider named.
      expect(state.reason?.limit?.resumesAt).toBe('2026-11-08T21:51:00.000Z');

      const accept = jest.spyOn(app.get(CommandService), 'accept').mockResolvedValue({} as never);
      const reconciler = app.get(Reconciler);
      await reconciler.resumeLimited();
      expect(accept).not.toHaveBeenCalled();
      clock.advance(Date.parse('2026-11-08T21:51:00Z') - START);
      await reconciler.resumeLimited();
      expect(accept).toHaveBeenCalledTimes(1);
      expect(accept).toHaveBeenCalledWith('resume', 'PROJ-302', {}, expect.anything());
    } finally {
      await app.close();
    }
  });

  it('ignores a reset far in the future and uses the default cooldown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-review-limit-far-'));
    await envWith(root, 'claude:m-claude');
    mkdirSync(join(root, 'worktrees', 'PROJ-306', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) => ({
      ...result(LIMIT_TEXT, input.step),
      limit: { window: '5-hour', resetsAt: '2099-01-01T09:00:00.000Z' },
    }));
    const app = await boot(root, agent, new FakeClock(START));
    try {
      await seed(app, 'PROJ-306');
      await app.get(PipelineService).step('code-review', 'PROJ-306');
      const run = (await app.get(RunRepository).findRun('PROJ-306'))!;
      const limit = deriveState(run).reason?.limit;

      expect(limit?.resetsAt).toBe(new Date(START + 60 * 60_000).toISOString());
      expect(limit?.resumesAt).toBe(new Date(START + 60 * 60_000).toISOString());
      expect((await app.get(RuntimeCooldownRepository).cooling(START + 61 * 60_000)).size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('keeps the answers of the reviewers that finished when the run goes on after the wait', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-review-limit-resume-'));
    await envWith(root, 'claude:m-claude');
    mkdirSync(join(root, 'worktrees', 'PROJ-303', 'billing-api'), { recursive: true });
    const clock = new FakeClock(START);
    let limit = true;
    const agent = answers((input) => limit && input.step === 'code-review-quality');
    const app = await boot(root, agent, clock);
    try {
      await seed(app, 'PROJ-303');
      await app.get(PipelineService).step('code-review', 'PROJ-303');
      const first = agent.mock.calls.length;
      limit = false;
      clock.advance(4 * 3_600_000);
      const done = await app.get(PipelineService).step('code-review', 'PROJ-303');
      const again = agent.mock.calls.slice(first).map((call) => call[0].step);

      expect(done.exitCode).toBe(0);
      expect(again.filter((step) => step === 'code-review-quality')).toHaveLength(1);
      expect(again.filter((step) => step === 'code-review-security')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('starts a new reviewer on the next agent while a runtime cools down, and on the first again after it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-review-limit-cooldown-'));
    await envWith(root, 'claude:m-claude,codex:m-codex');
    mkdirSync(join(root, 'worktrees', 'PROJ-304', 'billing-api'), { recursive: true });
    const clock = new FakeClock(START);
    const agent = answers(() => false);
    const app = await boot(root, agent, clock);
    try {
      await app.get(RuntimeCooldownRepository).set('claude', Date.parse(RESETS_AT), true);
      await seed(app, 'PROJ-304');
      await app.get(PipelineService).step('code-review', 'PROJ-304');
      expect(new Set(agent.mock.calls.map((call) => call[0].runtime))).toEqual(new Set(['codex']));

      agent.mockClear();
      clock.advance(Date.parse(RESETS_AT) - START + 1);
      await app.get(PipelineService).step('code-review', 'PROJ-304');
      expect(new Set(agent.mock.calls.map((call) => call[0].runtime))).toEqual(new Set(['claude']));
    } finally {
      await app.close();
    }
  });

  it('does not take an auth error for a limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-review-limit-auth-'));
    await envWith(root, 'claude:m-claude,codex:m-codex');
    mkdirSync(join(root, 'worktrees', 'PROJ-305', 'billing-api'), { recursive: true });
    const agent = jest.fn(async (input: AgentRunInput) =>
      input.step === 'code-review-quality'
        ? { ...result('Invalid API key · Please run /login', input.step), exitCode: 1 }
        : result(input.step.endsWith('report') ? 'ok\n' : reply(input.step, 'ok'), input.step),
    );
    const app = await boot(root, agent, new FakeClock(START));
    try {
      await seed(app, 'PROJ-305');
      const done = await app.get(PipelineService).step('code-review', 'PROJ-305');
      const run = (await app.get(RunRepository).findRun('PROJ-305'))!;

      expect(done.exitCode).toBe(1);
      expect(deriveState(run).reason?.code).not.toBe('RUNTIME_LIMIT');
      expect(agent.mock.calls.filter((call) => call[0].step === 'code-review-quality')).toHaveLength(1);
      expect((await app.get(RuntimeCooldownRepository).cooling(START)).size).toBe(0);
    } finally {
      await app.close();
    }
  });
});
