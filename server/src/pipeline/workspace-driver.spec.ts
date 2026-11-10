import 'reflect-metadata';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentRunInput } from '../agent/agent-runner';
import type { AgentRunResult } from '../agent/agent-result';
import type { StepEvent } from '../contract/step-events';
import { runInStepScope } from '../core/step-event-scope';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { RunStop } from '../agent/run-stop';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { SandboxService } from '../sandbox/sandbox.service';
import { DiskGuard } from './disk-guard';
import { RunDriver } from './run-driver';
import { WorkspaceGuard } from './workspace-guard';
import { clean, freshRun, makeWorld, type World } from './workspace.spec-helpers';

describe('RunDriver before a step', () => {
  let world: World;

  afterEach(async () => {
    await world.app.close();
  });

  function driver(execute: jest.Mock): RunDriver {
    const app = world.app;
    return new RunDriver(
      app.get(RunRepository),
      app.get(DocumentRepository),
      { get: () => ({ execute }) } as never,
      app.get(AppConfig),
      app.get(VisitRepository),
      new RunStop(),
      app.get(Clock),
      { flush: async () => undefined } as never,
      app.get(WorkspaceGuard),
      app.get(DiskGuard),
    );
  }

  it('brings a cleaned worktree back before the step runs', async () => {
    world = await makeWorld('PROJ-1');
    await clean(world);
    const seen: boolean[] = [];
    const execute = jest.fn(async () => {
      seen.push(existsSync(world.worktree));
      return { exitCode: 0, message: 'ok' };
    });

    await driver(execute).drive('implement', 'PROJ-1', {});

    expect(seen[0]).toBe(true);
    expect((await freshRun(world)).workspace).toBeNull();
  });

  it('replays a cleaned run: worktree back, setup to run again, one fresh chat with the full prompt', async () => {
    world = await makeWorld('PROJ-4');
    const app = world.app;
    const documents = app.get(DocumentRepository);
    const setup = { repo: 'demo', ref: 'abc', config: {}, setup: { command: 'npm ci', exitCode: 0 } };
    await documents.putDocument(await freshRun(world), 'environment:demo', JSON.stringify(setup));
    mkdirSync(join(world.swarm, 'data'), { recursive: true });
    writeFileSync(
      join(world.swarm, 'data', 'PROJ-4-implement-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'old-chat', resumed: false, completed: true, killReason: null })}\n`,
    );
    await clean(world);
    const resumed: (string | null)[] = [];
    const runner = {
      run: jest.fn(async (input: AgentRunInput) => {
        resumed.push(input.resumeChatId);
        return { chatId: 'new-chat', exitCode: 0, resumed: false, calls: 1 } as unknown as AgentRunResult;
      }),
    };
    const launcher = new AgentLauncher(runner as never, app.get(VisitRepository), new RunStop());
    const events: StepEvent[] = [];
    const seen: { worktree: boolean; setup: unknown }[] = [];
    const execute = jest.fn(async () => {
      const run = await freshRun(world);
      const record = JSON.parse((await documents.latestBody('PROJ-4', 'environment:demo')) ?? '{}');
      seen.push({ worktree: existsSync(world.worktree), setup: record.setup });
      const scope = {
        runId: run.id,
        attemptId: 'a1',
        step: 'implement' as const,
        root: world.swarm,
        clock: app.get(Clock),
        sink: async (event: StepEvent) => void events.push(event),
      };
      await runInStepScope(scope, 0, () =>
        launcher.launch({
          root: world.swarm,
          run,
          key: 'PROJ-4',
          step: 'implement',
          mode: 'agent',
          runtime: 'cursor',
          model: 'm',
          timeLimitMs: 1000,
          prompt: 'the follow-up',
          freshPrompt: 'the full prompt',
          workspace: world.worktree,
          mounts: [],
        }),
      );
      return { exitCode: 0, message: 'ok' };
    });

    await driver(execute).drive('implement', 'PROJ-4', {});

    expect(seen[0]).toEqual({ worktree: true, setup: undefined });
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((chat) => chat === null)).toBe(true);
    const change = events.find((event) => event.kind === 'session.changed');
    expect(change).toMatchObject({ session: 'new chat', reason: 'chat state removed' });
  });

  it('blocks the run with the code and does not start the step when the workspace is lost', async () => {
    world = await makeWorld('PROJ-2', 'github');
    await clean(world);
    const { git } = await import('../steps/prepare/prepare.step.spec-helpers');
    git(world.clone, ['branch', '-D', world.branch]);
    await world.app
      .get(DocumentRepository)
      .putDocument(await freshRun(world), 'pipeline_ref', 'project: acme/demo\nref: x\nsha: deadbeef\n');
    const execute = jest.fn();

    const result = await driver(execute).drive('implement', 'PROJ-2', {});

    expect(execute).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    const run = await freshRun(world);
    expect(run).toMatchObject({ status: 'blocked', currentStep: 'implement' });
    expect(JSON.parse(run.stateReason ?? '{}').code).toBe('WORKSPACE_LOST');
  });

  it('blocks the run with DISK_LOW and does not start the step', async () => {
    world = await makeWorld('PROJ-3');
    world.app.get(AppConfig).env.MIN_FREE_GB = 10;
    world.app.get(SandboxService).useDocker(async () => '');
    world.app.get(DiskGuard).useFreeBytes(async () => 1024 ** 3);
    const execute = jest.fn();

    await driver(execute).drive('implement', 'PROJ-3', {});

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse((await freshRun(world)).stateReason ?? '{}').code).toBe('DISK_LOW');
  });
});
