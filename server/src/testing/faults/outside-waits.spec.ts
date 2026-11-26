import 'reflect-metadata';
import type { AgentRunResult } from '../../agent/agent-result';
import { ERROR_CODES } from '../../contract/error-codes';
import { HostUnavailable } from '../../core/swarmloop-error';
import { storedState } from '../../history/run-state';
import { HOST_RETRY_MS } from '../../integrations/http';
import { ModelHostUnavailable } from '../../steps/shared/model-host-unavailable';
import { CommandService } from '../../pipeline/command.service';
import { StartGate } from '../../pipeline/start-gate';
import { Reconciler } from '../../pipeline/reconciler';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from '../result-answer';
import { loopingTask, MACHINE, reconcilerWorld } from './outside-waits.spec-helpers';

const MINUTE = 60_000;

describe('every outside wait ends once, when the table says it is over', () => {
  type World = Awaited<ReturnType<typeof reconcilerWorld>>;
  const iso = (world: World, after: number) => new Date(world.db.clock.now() + after).toISOString();
  const outage = (world: World) => new HostUnavailable('gitlab.example', 'HTTP 503', iso(world, 5 * MINUTE));
  const modelOutage = (world: World) =>
    new ModelHostUnavailable({ host: 'api.anthropic.com', detail: 'API Error: 502' }, {
      finishedAt: new Date(world.db.clock.now()).toISOString(),
    } as never);

  interface Case {
    name: string;
    /** The run as the step that met the wait leaves it, and how long the wait lasts on the fake clock. */
    wait(world: World): Promise<{ run: Awaited<ReturnType<World['waiting']>>; lasts: number; reason: object }>;
    /** What the key of the one resume is. */
    key(run: { revision: number }, retryAt: string | undefined): string;
    /** The outside answers again; only the checks of a wait that ends so need it. */
    answers?(world: World): void;
  }

  const timed =
    (code: string, error: (world: World) => { message: string; retryAt: string }): Case['wait'] =>
    async (world) => {
      const { message, retryAt } = error(world);
      const reason = { code, message, retryAt };
      return { run: await world.waiting(`T-${code}`, { status: 'waiting', reason }), lasts: 5 * MINUTE, reason };
    };

  const CASES: Case[] = [
    {
      name: 'RUNTIME_LIMIT when the cooldown ends',
      wait: async (world) => {
        const now = world.db.clock.now();
        await world.cooldowns.set({ runtime: 'claude', credential: 'ann' }, now + 60 * MINUTE, false);
        await world.cooldowns.set({ runtime: 'codex', credential: 'env' }, now + 60 * MINUTE, false);
        const reason = { code: ERROR_CODES.RUNTIME_LIMIT, message: 'limited' };
        return { run: await world.waiting('L-1', { status: 'waiting', reason }, 'ann'), lasts: 60 * MINUTE, reason };
      },
      key: (run) => `limit-${run.revision}`,
    },
    {
      name: 'HOST_UNAVAILABLE of a code host at its retryAt',
      wait: timed(ERROR_CODES.HOST_UNAVAILABLE, outage),
      key: (_run, retryAt) => `host-none-${retryAt}`,
    },
    {
      name: 'HOST_UNAVAILABLE of the model host at its retryAt',
      wait: async (world) => {
        const error = modelOutage(world);
        expect(error.retryAt).toBe(iso(world, HOST_RETRY_MS));
        return timed(ERROR_CODES.HOST_UNAVAILABLE, () => error)(world);
      },
      key: (_run, retryAt) => `host-none-${retryAt}`,
    },
    {
      name: 'CI_NOT_STARTED at its retryAt',
      wait: timed(ERROR_CODES.CI_NOT_STARTED, (world) => ({
        message: 'CI did not start',
        retryAt: iso(world, 5 * MINUTE),
      })),
      key: (_run, retryAt) => `ci-none-${retryAt}`,
    },
    {
      name: 'DOCKER_UNAVAILABLE when the sandbox answers',
      wait: async (world) => {
        const reason = { code: ERROR_CODES.DOCKER_UNAVAILABLE, message: 'docker is silent', retryAt: iso(world, 1) };
        return { run: await world.waiting('D-1', { status: 'waiting', reason }), lasts: 0, reason };
      },
      key: (_run, retryAt) => `docker-none-${retryAt}`,
      answers: (world) => (world.outside.docker = true),
    },
    {
      name: 'DISK_LOW when the disk has free space',
      wait: async (world) => {
        const reason = { code: ERROR_CODES.DISK_LOW, message: 'The disk is low' };
        return { run: await world.waiting('K-1', { status: 'blocked', reason }), lasts: 0, reason };
      },
      key: () => 'disk-none-The disk is low',
      answers: (world) => (world.outside.disk = true),
    },
    {
      name: 'GIT_AUTH when the connection is healthy',
      wait: async (world) => {
        const reason = { code: ERROR_CODES.GIT_AUTH, message: 'Reconnect GitLab' };
        return { run: await world.waiting('G-1', { status: 'waiting', reason }, 'ann'), lasts: 0, reason };
      },
      key: (run) => `git-auth-${run.revision}`,
      answers: (world) => (world.outside.connection = true),
    },
  ];

  it.each(CASES)('$name: the run waits with its words, goes on once, and a second pass sends nothing', async (item) => {
    const world = await reconcilerWorld();
    try {
      const { run, lasts, reason } = await item.wait(world);
      expect(storedState((await world.runs.findRun(run.key))!).reason).toMatchObject(reason);

      await world.reconciler.resumeOutsideWaits();
      if (lasts > 1) world.db.clock.advance(lasts - 1);
      await world.reconciler.resumeOutsideWaits();
      expect(world.accepted).toEqual([]);

      item.answers?.(world);
      world.db.clock.advance(1);
      // A silent docker moves its next try forward on each pass, so the key names the try the run has when it goes on.
      const asked = storedState((await world.runs.findRun(run.key))!).reason;
      const key = item.key(run, asked?.retryAt);
      await world.reconciler.resumeOutsideWaits();
      expect(world.accepted).toEqual([['resume', run.key, MACHINE, expect.objectContaining({ idempotencyKey: key })]]);

      world.db.clock.advance(MINUTE);
      await world.reconciler.resumeOutsideWaits();
      expect(world.accepted).toHaveLength(1);
      expect(storedState((await world.runs.findRun(run.key))!).reason).toEqual(asked);
    } finally {
      await world.db.close();
    }
  });
});

const KEY = 'PROJ-870';
const DOWN: ScriptedAnswer = { outage: { host: 'api.anthropic.com', detail: 'API Error: 502' } };

/** An outage ends at the fake clock's now, so its next try is on the fake clock. */
class ClockedRunner extends BlockAgentRunner {
  now: () => number = () => 0;

  override async run(input: Parameters<BlockAgentRunner['run']>[0]): Promise<AgentRunResult> {
    const result = await super.run(input);
    return result.outage ? { ...result, finishedAt: new Date(this.now()).toISOString() } : result;
  }
}

describe('a model host outage met twice while the chain is asked after a same-input refusal', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('waits for the host each time and asks the chain again by itself, once, with the refused visit not run again', async () => {
    const blocks = new ClockedRunner({ plan: [DOWN, DOWN, DOWN] });
    flow = await createFlowHarness(KEY, { blocks });
    blocks.now = () => flow.app.clock.now();
    const looping = await loopingTask(flow, KEY);
    const resumes = jest.spyOn(flow.app.app.get(CommandService), 'accept');
    const resumeKeys = () =>
      resumes.mock.calls.filter(([action]) => action === 'resume').map(([, , , options]) => options?.idempotencyKey);
    const asks = () => blocks.steps.filter((step) => step === 'plan').length;
    const waitOf = async () => storedState((await looping.task())!).reason;
    const pass = async () => {
      const reconciler = flow.app.app.get(Reconciler);
      await reconciler.resumeOutsideWaits();
      await reconciler.reconcileCommands();
      await looping.settle();
    };
    const visited = looping.visits();
    expect(visited).toBe(1);

    await flow.app.app.get(StartGate).resume((await looping.task())!, { by: 'machine', event: 'wake' });
    await looping.settle();

    const retryAts: string[] = [];
    for (const asked of [1, 2]) {
      expect((await looping.task())!.status).toBe('waiting');
      const reason = await waitOf();
      expect(reason).toMatchObject({
        code: ERROR_CODES.HOST_UNAVAILABLE,
        message: expect.stringContaining('api.anthropic.com'),
        retryAt: new Date(flow.app.clock.now() + HOST_RETRY_MS).toISOString(),
      });
      retryAts.push(reason!.retryAt!);
      expect(asks()).toBe(asked);
      const before = resumeKeys().length;

      flow.app.clock.advance(HOST_RETRY_MS - 1);
      await pass();
      expect(resumeKeys()).toHaveLength(before);
      expect(asks()).toBe(asked);

      flow.app.clock.advance(1);
      await pass();
      expect(resumeKeys()).toHaveLength(before + 1);
      expect(asks()).toBe(asked + 1);
      await pass();
      expect(resumeKeys()).toHaveLength(before + 1);
      expect(asks()).toBe(asked + 1);
      expect(looping.visits()).toBe(visited);
    }
    const keys = resumeKeys().filter((key) => retryAts.some((retryAt) => key?.endsWith(retryAt)));
    expect(new Set(keys).size).toBe(2);
  });
});
