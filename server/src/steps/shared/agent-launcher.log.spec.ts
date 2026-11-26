import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Joi from 'joi';
import { DataSource } from 'typeorm';
import { defineResult } from '../../agent-result/result-definition';
import { emptyResult } from '../../agent/agent-result';
import type { AgentRunResult } from '../../agent/agent-result';
import type { AgentProcessRunner, AgentRunInput } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import type { PricedRequest } from '../../agent/request-usage';
import { REASON } from '../../contract/reason-words';
import { AgentCallRepository } from '../../history/agent-call.repository';
import { AgentExchangeEntity } from '../../history/entities';
import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { BacklogRepository } from '../../history/backlog.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { sessionHome } from '../../history/session-group';
import { VisitRepository } from '../../history/visit.repository';
import { VisitStartRepository } from '../../history/visit-start.repository';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { resultAnswer } from '../../testing/result-answer';
import { AgentCallRecorder } from './agent-call-recorder';
import type { AgentLaunchRequest } from './agent-launch-request';
import { AgentLauncher } from './agent-launcher';
import { CallContexts } from './call-context';

const definition = defineResult('sample', Joi.object({ items: Joi.array().items(Joi.string()).required() }));
const PRICE = { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 };
const AT = '2026-01-01T00:00:00.000Z';

/** One model request as the stream reports it. */
function modelRequest(messageId: string, over: Partial<PricedRequest> = {}): PricedRequest {
  return {
    messageId,
    model: 'opus',
    parentToolUseId: null,
    input: 10,
    cacheRead: 100,
    cacheWrite: 0,
    output: 5,
    usd: 0.01,
    price: PRICE,
    ...over,
  };
}

/** What the agent process returns: a clean exit in chat `chat-1`, unless the spec says otherwise. */
function ended(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ...emptyResult('time', 0, 1, AT),
    killReason: null,
    chatId: 'chat-1',
    usd: 0.01,
    responseText: 'done',
    ...over,
  };
}

/** What a fake agent does for one launch: it streams its requests, then returns its result or throws. */
type Behavior = (input: AgentRunInput) => AgentRunResult | Promise<AgentRunResult>;

const streams =
  (requests: PricedRequest[], result: AgentRunResult = ended()): Behavior =>
  (input) => {
    requests.forEach((request) => input.onRequest?.(request));
    return result;
  };

async function harness(script: Behavior[], failover?: unknown) {
  const db = await repositoryDatabase();
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-call-log-'));
  const calls = db.app.get(AgentCallRepository);
  const contexts = new CallContexts(
    db.app.get(RunRepository),
    db.app.get(BacklogRepository),
    db.app.get(BacklogChatRepository),
    db.app.get(VisitStartRepository),
  );
  const recorder = new AgentCallRecorder(calls, contexts, db.clock);
  const runStop = new RunStop();
  const inputs: AgentRunInput[] = [];
  const agent = {
    run: async (input: AgentRunInput) => {
      inputs.push(input);
      const result = await (script.shift() ?? streams([]))(input);
      if (result.chatId && !input.fork) {
        // What the runner leaves after a launch that is a visit: the chat the next launch of the step resumes.
        mkdirSync(agentStateDir(root, input.runKey, sessionHome(input.step)), { recursive: true });
        writeFileSync(
          input.sessionFile,
          JSON.stringify({ runtime: input.runtime, chatId: result.chatId, resumed: true, completed: true, usd: 0 }),
        );
      }
      return result;
    },
  } as unknown as AgentProcessRunner;
  const launcher = new AgentLauncher(
    agent,
    db.app.get(VisitRepository),
    runStop,
    failover as never,
    undefined,
    undefined,
    recorder,
  );
  const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
  const request = (over: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest => ({
    root,
    run: { id: run.id, agentCalls: 0, spentUsd: 0, activeAttempt: 'attempt-1' },
    key: 'run-1',
    step: 'implement',
    mode: 'agent',
    tools: 'write',
    runtime: 'claude',
    model: 'opus',
    effort: 'high',
    timeLimitMs: 1000,
    prompt: 'go',
    workspace: root,
    mounts: [],
    ...over,
  });
  const rows = (): Promise<AgentExchangeEntity[]> =>
    db.app
      .get(DataSource)
      .getRepository(AgentExchangeEntity)
      .find({ order: { id: 'ASC' } });
  return { db, launcher, request, rows, inputs, calls, recorder, run, runStop };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function withHarness(script: Behavior[], test: (h: Harness) => Promise<void>, failover?: unknown): Promise<void> {
  const h = await harness(script, failover);
  try {
    await test(h);
  } finally {
    await h.db.close();
  }
}

describe('the log the launcher writes', () => {
  describe('one row for each kind of call', () => {
    const kinds: [string, Partial<AgentLaunchRequest>, Record<string, unknown>][] = [
      ['a step visit', { step: 'implement' }, { step: 'implement', startReason: 'first', purpose: null }],
      ['a reviewer', { step: 'code-review-quality' }, { step: 'code-review-quality', startReason: 'first' }],
      ['the review report', { step: 'code-review-report', resume: false }, { step: 'code-review-report' }],
      [
        'a planner answer',
        { step: 'plan', call: { purpose: 'answer-part' } },
        { step: 'plan', purpose: 'answer-part', plannerLevel: 'run', startReason: 'message' },
      ],
      [
        'a merge look',
        { step: 'plan', call: { purpose: 'merge-look' } },
        { step: 'plan', purpose: 'merge-look', plannerLevel: 'run', startReason: 'merge' },
      ],
    ];

    it.each(kinds)('%s leaves one row with its facts', async (_name, extra, expected) => {
      await withHarness([streams([modelRequest('m1')])], async ({ launcher, request, rows }) => {
        const launched = await launcher.launch(request(extra));
        const [row, ...others] = await rows();
        expect(others).toEqual([]);
        expect(row).toMatchObject({
          kind: 'call',
          runKey: 'run-1',
          runtime: 'claude',
          model: 'opus',
          effort: 'high',
          attemptId: 'attempt-1',
          endKind: 'done',
          chatId: 'chat-1',
          resumed: 0,
          requestText: 'go',
          responseText: 'done',
          inputTokens: 10,
          cacheReadTokens: 100,
          outputTokens: 5,
          ownUsd: 0.01,
          ...expected,
        });
        expect(JSON.parse(row.usage ?? '[]')).toEqual([
          { model: 'opus', input: 10, cacheRead: 100, cacheWrite: 0, output: 5, usd: 0.01 },
        ]);
        expect(launched.callIds).toEqual([row.id]);
      });
    });

    it('a return from a step starts as a return', async () => {
      await withHarness([streams([modelRequest('m1')])], async ({ db, launcher, request, rows, run }) => {
        await db.app.get(VisitStartRepository).note({
          runId: run.id,
          step: 'implement',
          attemptId: 'attempt-1',
          startedBy: 'machine',
          level: null,
          inputDigest: null,
          startReason: REASON.returned,
          rerunUnfinished: false,
          createdAt: AT,
        });
        await launcher.launch(request());
        expect((await rows())[0].startReason).toBe('return:implement');
      });
    });

    it("a backlog planner's turn leaves one row under its turn key, with the backlog planner's level", async () => {
      await withHarness([streams([modelRequest('m1')])], async ({ launcher, request, rows }) => {
        await launcher.launch(
          request({
            key: 'turn-1',
            step: 'backlog-plan',
            run: { id: 9, agentCalls: 0, spentUsd: 0, activeAttempt: null },
          }),
        );
        const [row, ...others] = await rows();
        expect(others).toEqual([]);
        expect(row).toMatchObject({
          turnKey: 'turn-1',
          runKey: null,
          step: 'backlog-plan',
          plannerLevel: 'backlog',
          purpose: 'backlog-turn',
          startReason: 'message',
          ownUsd: 0.01,
        });
      });
    });
  });

  it('writes a follow-up as its own row of the same chat, linked to the call it follows', async () => {
    const wrong = streams([modelRequest('m1')], ended({ responseText: 'no block' }));
    const fixed = streams(
      [modelRequest('m2', { usd: 0.02 })],
      ended({ responseText: resultAnswer('ok', { items: ['a'] }) }),
    );
    await withHarness([wrong, fixed], async ({ launcher, request, rows }) => {
      const launched = await launcher.launch(request({ result: definition }));
      const [first, second] = await rows();
      expect(second).toMatchObject({ startReason: 'follow-up', previousId: first.id, chatId: 'chat-1', resumed: 1 });
      expect(first.startReason).toBe('first');
      expect(launched.callIds).toEqual([first.id, second.id]);
    });
  });

  it('writes a helper as its own row linked to its parent, and keeps its cost out of the parent', async () => {
    const requests = [
      modelRequest('m1'),
      modelRequest('h1', { model: 'sonnet', parentToolUseId: 'tool-1', usd: 0.4, input: 1, cacheRead: 0, output: 2 }),
      modelRequest('m2', { usd: 0.03 }),
    ];
    await withHarness([streams(requests)], async ({ launcher, request, rows }) => {
      const launched = await launcher.launch(request());
      const [parent, helper] = await rows();
      expect(helper).toMatchObject({
        kind: 'helper',
        parentId: parent.id,
        model: 'sonnet',
        ownUsd: 0.4,
        endKind: 'done',
      });
      expect(parent.ownUsd).toBeCloseTo(0.04, 9);
      expect(JSON.parse(parent.usage ?? '[]')).toHaveLength(1);
      expect(launched.callIds).toEqual([parent.id, helper.id]);
    });
  });

  it('counts a message id that onRequest reports twice once, with its latest usage', async () => {
    const requests = [
      modelRequest('m1', { output: 5, usd: 0.01 }),
      modelRequest('m1', { output: 50, usd: 0.05 }),
      modelRequest('m2', { usd: 0.02 }),
    ];
    await withHarness([streams(requests)], async ({ launcher, request, rows }) => {
      await launcher.launch(request());
      const [row] = await rows();
      expect(row.ownUsd).toBeCloseTo(0.07, 9);
      expect(row.outputTokens).toBe(55);
      expect(JSON.parse(row.usage ?? '[]')).toEqual([
        expect.objectContaining({ model: 'opus', output: 55, input: 20 }),
      ]);
    });
  });

  it("records a resumed call's own cost, not the running total the runtime reports", async () => {
    const total = (usd: number, reported: number) =>
      ended({ usd, reported: { usd: reported, tokensIn: 1, tokensOut: 1 } });
    const first = streams([modelRequest('m1', { usd: 1 })], total(1, 1));
    const second = streams([modelRequest('m2', { usd: 0.3 })], total(0.3, 1.3));
    await withHarness([first, second], async ({ launcher, request, rows, inputs }) => {
      await launcher.launch(request());
      await launcher.launch(request());
      const [one, two] = await rows();
      expect(two).toMatchObject({ resumed: 1, previousId: one.id, ownUsd: 0.3, reportedUsd: 1.3 });
      expect(two.chatIdleMin).toBe(0);
      // The launch is told what the chat holds: its cost so far and what its last call reported.
      expect(inputs[1]).toMatchObject({ chatSpentUsd: 1, prior: { usd: 1, tokensIn: 1, tokensOut: 1 }, spentUsd: 1 });
    });
  });

  it("links the call after a stop of the chat's pings to the chat's last call, not to the stop", async () => {
    await withHarness([streams([modelRequest('m1')]), streams([modelRequest('m2')])], async (h) => {
      await h.launcher.launch(h.request());
      const [first] = await h.rows();
      h.db.clock.advance(30 * 60_000);
      await h.calls.addStop('chat-1', 'cap-reached', h.db.clock.iso());
      await h.launcher.launch(h.request());
      const second = (await h.rows()).find((row) => row.kind === 'call' && row.id !== first.id);
      expect(second).toMatchObject({ previousId: first.id, resumed: 1 });
      expect(second?.chatIdleMin).toBeCloseTo(30);
    });
  });

  it('keeps what the result charges beyond the requests that carry a price', async () => {
    const unpriced = streams([modelRequest('m1', { usd: 0, price: null })], ended({ usd: 0.5 }));
    await withHarness([unpriced], async ({ launcher, request, rows }) => {
      await launcher.launch(request());
      expect((await rows())[0].ownUsd).toBeCloseTo(0.5, 9);
    });
  });

  it("holds the owner's spend at the log's sum when two launches of one owner overlap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => (started = resolve));
    const first: Behavior = async (input) => {
      input.onRequest?.(modelRequest('a1', { usd: 1 }));
      started();
      await gate;
      return ended({ usd: 1 });
    };
    const second = streams([modelRequest('b1', { usd: 2 })], ended({ usd: 2, chatId: 'chat-2' }));
    await withHarness([first, second], async ({ launcher, request, run }) => {
      const owner = { id: run.id, agentCalls: 0, spentUsd: 0, activeAttempt: 'attempt-1' };
      const one = launcher.launch(request({ run: owner, step: 'code-review-quality' }));
      await streaming;
      await launcher.launch(request({ run: owner, step: 'code-review-security' }));
      release();
      await one;
      expect(owner.spentUsd).toBeCloseTo(3, 9);
    });
  });

  it('keeps the streamed requests of a call that dies before the final line, and ends it failed', async () => {
    const dying: Behavior = (input) => {
      input.onRequest?.(modelRequest('m1', { usd: 0.2 }));
      return Promise.reject(new RangeError('the process vanished'));
    };
    await withHarness([dying], async ({ launcher, request, rows }) => {
      await expect(launcher.launch(request())).rejects.toThrow('the process vanished');
      const [row] = await rows();
      expect(row).toMatchObject({
        endKind: 'failed',
        errorClass: 'RangeError',
        errorText: 'the process vanished',
        ownUsd: 0.2,
      });
    });
  });

  it('records the error class and text of a call that exited badly, with its exit code and kill reason', async () => {
    await withHarness([streams([], ended({ exitCode: 2 })), streams([], ended({ killReason: 'idle' }))], async (h) => {
      await h.launcher.launch(h.request());
      await h.launcher.launch(h.request({ resume: false }));
      const [exit, idle] = await h.rows();
      expect(exit).toMatchObject({ endKind: 'failed', errorClass: 'exit', exitCode: 2 });
      expect(exit.errorText).toContain('code 2');
      expect(idle).toMatchObject({ endKind: 'timed-out', killReason: 'idle', errorClass: 'killed' });
    });
  });

  it('ends the first row on its limit and links the failover row of the next runtime to it', async () => {
    const limit = { window: 'five-hour', resetsAt: '2026-01-01T05:00:00.000Z' };
    const limited = streams([modelRequest('m1', { usd: 0.1 })], ended({ limit, chatId: null, exitCode: 1 }));
    const next = streams([modelRequest('m2', { model: 'codex-model' })], ended({ chatId: 'chat-2' }));
    const failover = {
      start: async (request: AgentLaunchRequest) => request,
      limited: async (request: AgentLaunchRequest) => ({
        ...request,
        runtime: 'codex',
        model: 'codex-model',
        resume: false,
      }),
    };
    await withHarness(
      [limited, next],
      async ({ launcher, request, rows }) => {
        const launched = await launcher.launch(request({ failover: true }));
        const [first, second] = await rows();
        expect(first).toMatchObject({
          runtime: 'claude',
          endKind: 'limit',
          limitWindow: 'five-hour',
          limitResetsAt: '2026-01-01T05:00:00.000Z',
          ownUsd: 0.1,
        });
        expect(second).toMatchObject({
          runtime: 'codex',
          model: 'codex-model',
          startReason: 'failover',
          replacesId: first.id,
          chatId: 'chat-2',
          resumed: 0,
          endKind: 'done',
        });
        expect(launched.callIds).toEqual([first.id, second.id]);
      },
      failover,
    );
  });

  it('ends a call on the model host outage and a call a person stopped', async () => {
    const outage = ended({ outage: { host: 'api.example', detail: 'unreachable' } });
    await withHarness([streams([], outage)], async ({ launcher, request, rows }) => {
      await expect(launcher.launch(request())).rejects.toThrow();
      expect((await rows())[0]).toMatchObject({ endKind: 'outage', errorText: 'api.example: unreachable' });
    });
    const halting: Behavior = (input) => {
      stopper.halt(input.runKey);
      return ended();
    };
    let stopper!: RunStop;
    await withHarness([halting], async ({ launcher, request, rows, runStop }) => {
      stopper = runStop;
      await launcher.launch(request());
      expect((await rows())[0]).toMatchObject({ endKind: 'stopped', stopReason: 'person-stopped' });
    });
  });

  it('writes a refused row with the reason the door gave', async () => {
    await withHarness([], async ({ launcher, request, rows }) => {
      await launcher.refused(request(), 'run-1 is over the spend limit. plan was not started');
      const [row] = await rows();
      expect(row).toMatchObject({
        endKind: 'refused',
        refusedReason: 'run-1 is over the spend limit. plan was not started',
        runKey: 'run-1',
        ownUsd: 0,
        runtime: 'claude',
      });
    });
  });

  it('ends the open rows of a scope with their cost, and leaves other scopes alone', async () => {
    await withHarness([], async ({ launcher, request, calls, rows, recorder }) => {
      const open = await recorder.begin(request(), { chatId: null });
      open.onRequest(modelRequest('m1', { usd: 0.25 }));
      await calls.open({
        kind: 'call',
        startedAt: AT,
        attemptId: 'other',
        resumed: false,
        runtime: 'claude',
        model: 'opus',
        requestText: '',
      });
      await launcher.closeLeftOpen({ attemptId: 'attempt-1' });
      const [dead, other] = await rows();
      expect(dead).toMatchObject({ endKind: 'failed', errorText: 'process died', ownUsd: 0.25 });
      expect(other.endKind).toBe('running');
    });
  });

  describe('the ties of a call', () => {
    const general = [{ task: 'first', general: true }];
    /** The ties of a turn: the general tie before its result, the task its first item names after. */
    const ties = async (value: unknown) =>
      value === undefined ? general : [{ task: (value as { items: string[] }).items[0], general: false }];
    const tiesOf = async (rows: () => Promise<AgentExchangeEntity[]>) =>
      (await rows()).map((row) => JSON.parse(row.ties ?? '[]') as unknown);

    it('are on the row from its open, before the call has run', async () => {
      let seen: unknown;
      const watching: Behavior = async () => {
        seen = await tiesOf(rows);
        return ended();
      };
      let rows!: () => Promise<AgentExchangeEntity[]>;
      await withHarness([watching], async (h) => {
        rows = h.rows;
        await h.launcher.launch(h.request({ call: { ties } }));
      });
      expect(seen).toEqual([general]);
    });

    it.each([
      ['dies', () => Promise.reject(new RangeError('the process vanished'))],
      ['hits a limit', () => ended({ limit: { window: 'five-hour' }, chatId: null, exitCode: 1 })],
      ['fails', () => ended({ exitCode: 2 })],
      ['times out', () => ended({ killReason: 'idle' })],
    ])('stay on the row of a call that %s', async (_name, behavior) => {
      await withHarness([behavior], async ({ launcher, request, rows }) => {
        await launcher.launch(request({ call: { ties } })).catch(() => undefined);
        expect(await tiesOf(rows)).toEqual([general]);
      });
    });

    it('are replaced by the tasks a valid result names, on the call and on each follow-up', async () => {
      const wrong = streams([modelRequest('m1')], ended({ responseText: 'no block' }));
      const fixed = streams([modelRequest('m2')], ended({ responseText: resultAnswer('ok', { items: ['a'] }) }));
      await withHarness([wrong, fixed], async ({ launcher, request, rows }) => {
        await launcher.launch(request({ result: definition, call: { ties } }));
        expect(await tiesOf(rows)).toEqual([[{ task: 'a', general: false }], [{ task: 'a', general: false }]]);
      });
    });

    it('stay general when the result is refused for good', async () => {
      const wrong = streams([], ended({ responseText: 'no block' }));
      await withHarness([wrong, wrong, wrong], async ({ launcher, request, rows }) => {
        await launcher.launch(request({ result: definition, call: { ties } })).catch(() => undefined);
        expect(new Set((await tiesOf(rows)).map((row) => JSON.stringify(row)))).toEqual(
          new Set([JSON.stringify(general)]),
        );
      });
    });
  });

  describe('a keep-warm ping', () => {
    const DUE = '2026-01-01T00:50:00.000Z';
    /** A first call in chat-1, then the ping request for it. */
    async function chatWithPing(h: Harness, over: Partial<AgentLaunchRequest> = {}) {
      await h.launcher.launch(h.request());
      const [first] = await h.rows();
      const ping = h.request({
        tools: 'none',
        prompt: 'one word',
        run: { id: h.run.id, agentCalls: 0, spentUsd: 0, activeAttempt: null },
        call: { ping: { chatId: 'chat-1', dueAt: DUE, previousId: first.id } },
        ...over,
      });
      return { first, ping };
    }

    it('is one row of kind ping, keeps the chat id the fork reported another for, and runs on a fork with no tools', async () => {
      const ping = streams([modelRequest('p1', { usd: 0.02 })], ended({ chatId: 'fork-9', responseText: 'ok' }));
      await withHarness([streams([modelRequest('m1')]), ping], async (h) => {
        const { first, ping: request } = await chatWithPing(h);
        await h.launcher.ping(request);
        const [, row, ...others] = await h.rows();
        expect(others).toEqual([]);
        expect(row).toMatchObject({
          kind: 'ping',
          startReason: 'ping',
          chatId: 'chat-1',
          previousId: first.id,
          dueAt: DUE,
          runKey: 'run-1',
          step: 'implement',
          attemptId: null,
          runtime: 'claude',
          model: 'opus',
          effort: 'high',
          endKind: 'done',
          ownUsd: 0.02,
          requestText: 'one word',
        });
        expect(h.inputs[1]).toMatchObject({ fork: true, tools: 'none', resumeChatId: 'chat-1', prompt: 'one word' });
        expect(existsSync(h.inputs[1].outputFile)).toBe(false);
        expect(h.inputs[1].outputFile).not.toBe(h.inputs[0].outputFile);
      });
    });

    it('records no visit start and leaves no spend on the run it was given', async () => {
      await withHarness([streams([modelRequest('m1')]), streams([modelRequest('p1')])], async (h) => {
        const { ping } = await chatWithPing(h);
        await h.launcher.ping(ping);
        expect(await h.db.app.get(VisitStartRepository).forRun(h.run.id)).toEqual([]);
        expect(ping.run.spentUsd).toBe(0);
      });
    });

    it('is one row for a due time, however often it is asked', async () => {
      await withHarness([streams([modelRequest('m1')]), streams([]), streams([])], async (h) => {
        const { ping } = await chatWithPing(h);
        await h.launcher.ping(ping);
        await h.launcher.ping(ping);
        expect((await h.rows()).filter((row) => row.kind === 'ping')).toHaveLength(1);
        expect(h.inputs).toHaveLength(2);
      });
    });

    it.each([
      ['a limit', () => ended({ limit: { window: 'five-hour', resetsAt: AT }, chatId: null }), 'limit'],
      ['an outage', () => ended({ outage: { host: 'api.example', detail: 'down' } }), 'outage'],
      ['an error', () => ended({ exitCode: 2 }), 'failed'],
      ['a thrown error', () => Promise.reject(new RangeError('gone')), 'failed'],
    ])('ends its row on %s with the cost it streamed, and does not throw', async (_name, end, endKind) => {
      const failing: Behavior = (input) => {
        input.onRequest?.(modelRequest('p1', { usd: 0.03 }));
        return (end as () => AgentRunResult | Promise<AgentRunResult>)();
      };
      await withHarness([streams([modelRequest('m1')]), failing], async (h) => {
        const { ping } = await chatWithPing(h);
        await expect(h.launcher.ping(ping)).resolves.toBeUndefined();
        const row = (await h.rows()).find((found) => found.kind === 'ping');
        expect(row).toMatchObject({ endKind, chatId: 'chat-1', ownUsd: 0.03 });
      });
    });
  });
});
