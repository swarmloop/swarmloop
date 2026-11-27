import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunStop } from '../../agent/run-stop';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import type { StepEvent } from '../../contract/step-events';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { runInStepScope } from '../../core/step-event-scope';
import { sessionFileName } from '../../history/session-group';
import { AgentLauncher } from './agent-launcher';
import { LimitFailover } from './limit-failover';

describe('AgentLauncher runtime of the agent', () => {
  it('starts a new chat with the full brief when the stored chat belongs to another runtime than the step agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-agent-runtime-'));
    mkdirSync(join(root, 'data', 'agent-state', 'run', 'review'), { recursive: true });
    const file = join(root, 'data', sessionFileName('run', 'review'));
    writeFileSync(file, JSON.stringify({ runtime: 'cursor', chatId: 'chat-1', usd: 0 }));
    const runner = {
      run: jest.fn().mockResolvedValue({
        responseText: 'ok',
        chatId: 'chat-2',
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        killReason: null,
        exitCode: 0,
        resumed: false,
        calls: 1,
        samples: [],
        durationMs: 0,
        startedAt: '',
        finishedAt: '',
      }),
    };
    const events: StepEvent[] = [];
    const scope = {
      runId: 1,
      attemptId: 'attempt-1',
      step: 'implement' as const,
      root,
      clock: new FakeClock(),
      sink: (event: StepEvent) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    const launcher = new AgentLauncher(runner as never, new RunStop());
    const launch = (runtime: 'cursor' | 'claude') =>
      runInStepScope(scope, 0, () =>
        launcher.launch({
          root,
          run: { runtime: 'cursor', agentCalls: 0, spentUsd: 0 } as never,
          key: 'run',
          step: 'review',
          mode: 'ask',
          tools: 'write',
          runtime,
          model: 'm',
          timeLimitMs: 1,
          prompt: 'follow up',
          freshPrompt: 'the full brief',
          workspace: root,
          mounts: [],
        }),
      );

    await launch('claude');
    expect(runner.run.mock.calls[0][0]).toMatchObject({ runtime: 'claude', resumeChatId: null });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'session.changed', runtime: 'claude', reason: 'runtime changed' }),
    );

    await launch('cursor');
    expect(runner.run.mock.calls[1][0]).toMatchObject({ runtime: 'cursor', resumeChatId: 'chat-1' });
  });
  it('mounts the CLI of the agent that took over after a limit, and never a second launch on the old one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-failover-'));
    const ran = { chatId: null, tokensIn: 0, tokensOut: 0, usd: 0, calls: 1, exitCode: 0, resumed: false, samples: [] };
    const runner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ ...ran, responseText: 'limit', limit: { window: '5-hour' } })
        .mockResolvedValueOnce({ ...ran, responseText: 'done' }),
    };
    const failover = {
      start: (request: object) => Promise.resolve(request),
      limited: (request: object) =>
        Promise.resolve({ ...request, runtime: 'codex', model: 'm-codex', resume: false, prompt: 'the full brief' }),
    };
    const projectFor = jest.fn((runtime: string) => Promise.resolve({ cliVolume: `cli-${runtime}` }));
    const launcher = new AgentLauncher(runner as never, new RunStop(), failover as never);
    const result = await launcher.launch({
      root,
      run: { agentCalls: 0, spentUsd: 0 } as never,
      key: 'run',
      step: 'implement',
      mode: 'agent',
      tools: 'write',
      runtime: 'claude',
      model: 'm-claude',
      timeLimitMs: 1,
      prompt: 'follow up',
      workspace: root,
      mounts: [],
      failover: true,
      project: { cliVolume: 'cli-claude' } as never,
      projectFor: projectFor as never,
    });

    expect(runner.run.mock.calls.map((call) => call[0].runtime)).toEqual(['claude', 'codex']);
    expect(runner.run.mock.calls[0][0]).toMatchObject({ runtime: 'claude', project: { cliVolume: 'cli-claude' } });
    expect(runner.run.mock.calls[1][0]).toMatchObject({
      runtime: 'codex',
      prompt: expect.stringContaining('the full brief'),
      project: { cliVolume: 'cli-codex' },
    });
    expect(result.agent).toEqual({ runtime: 'codex', model: 'm-codex' });
  });

  describe('with the real failover', () => {
    const ran = { chatId: null, tokensIn: 0, tokensOut: 0, usd: 0, calls: 1, exitCode: 0, resumed: false, samples: [] };

    function setup(cooling: string[], limited = cooling.length === 0) {
      const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-briefs-'));
      const runEntity = {
        agentCalls: 0,
        spentUsd: 0,
        agents: {
          main: {
            implement: [
              { runtime: 'claude', model: 'm-claude' },
              { runtime: 'codex', model: 'm-codex' },
            ],
          },
        },
      } as never;
      const run = jest.fn().mockResolvedValue({ ...ran, responseText: 'done' });
      if (limited) {
        run.mockResolvedValueOnce({ ...ran, responseText: 'limit', limit: { window: '5-hour' } });
      }
      const runner = { run };
      const failover = new LimitFailover(
        new AppConfig(testEnv()),
        new FakeClock(),
        {
          cooling: async () => new Set(cooling),
          set: async (key: { runtime: string }) => {
            cooling.push(key.runtime);
          },
          earliest: async () => ({ until: 0, resumeAt: 1 }),
        } as never,
        { finishVisit: async () => undefined } as never,
      );
      const launcher = new AgentLauncher(runner as never, new RunStop(), failover);
      const launch = (extra: object) =>
        launcher.launch({
          root,
          run: runEntity,
          key: 'run',
          step: 'implement',
          mode: 'agent',
          tools: 'write',
          runtime: 'claude',
          model: 'm-claude',
          timeLimitMs: 1,
          prompt: 'prompt for claude',
          workspace: root,
          mounts: [],
          failover: true,
          ...extra,
        });
      return { runner, launch };
    }

    it('sends the brief of the new runtime after a limit', async () => {
      const { runner, launch } = setup([]);
      await launch({ brief: 'old brief', briefFor: (runtime: string) => `brief for ${runtime}` });
      expect(runner.run.mock.calls[1][0].prompt).toContain('brief for codex');
    });

    it('sends the brief of the new runtime when a launch starts on another runtime', async () => {
      const { runner, launch } = setup(['claude']);
      await launch({ briefFor: (runtime: string) => `brief for ${runtime}` });
      expect(runner.run.mock.calls[0][0]).toMatchObject({ runtime: 'codex' });
      expect(runner.run.mock.calls[0][0].prompt).toContain('brief for codex');
    });

    it('falls back to the brief or the prompt without briefFor', async () => {
      const limited = setup([]);
      await limited.launch({ brief: 'old brief' });
      expect(limited.runner.run.mock.calls[1][0].prompt).toContain('old brief');
      const started = setup(['claude']);
      await started.launch({});
      expect(started.runner.run.mock.calls[0][0].prompt).toContain('prompt for claude');
    });
  });
});
