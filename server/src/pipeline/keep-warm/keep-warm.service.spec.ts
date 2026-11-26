import { mkdirSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { emptyResult } from '../../agent/agent-result';
import type { AgentRunResult } from '../../agent/agent-result';
import type { AgentProcessRunner, AgentRunInput } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { AgentCallQueries } from '../../history/agent-call-queries';
import { AgentExchangeEntity } from '../../history/entities';
import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { BacklogRepository } from '../../history/backlog.repository';
import { DocumentRepository } from '../../history/document.repository';
import { VisitRepository } from '../../history/visit.repository';
import { VisitStartRepository } from '../../history/visit-start.repository';
import type { ContainerGate } from '../../sandbox/container-gate';
import { ARTIFACTS } from '../../steps/contract/artifacts';
import { AgentCallRecorder } from '../../steps/shared/agent-call-recorder';
import { AgentDoor } from '../../steps/shared/agent-door';
import type { AgentLaunchRequest } from '../../steps/shared/agent-launch-request';
import { AgentLauncher } from '../../steps/shared/agent-launcher';
import { CallContexts } from '../../steps/shared/call-context';
import { SpendLimit } from '../../steps/shared/spend-limit';
import { KeepWarm } from './keep-warm.service';
import { PingCandidates } from './ping-candidates';
import { keepWarmDatabase } from './ping-candidates.spec-helpers';

const MINUTE_MS = 60_000;
const PRICE = { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.2, cacheWritePerMillion: 8 };
const AT = '2026-01-01T00:00:00.000Z';

/** What the fake runtime does for one launch: it streams a request, then ends as `end` says. */
type Script = (input: AgentRunInput) => Promise<AgentRunResult>;

async function world(limits: Parameters<typeof testEnv>[0] = {}) {
  const h = await keepWarmDatabase();
  const inputs: AgentRunInput[] = [];
  let script: Script = async () => ({ ...emptyResult('time', 0, 1, AT), killReason: null, chatId: 'fork', usd: 0.01 });
  const agent = {
    run: async (input: AgentRunInput) => {
      inputs.push(input);
      input.onRequest?.({
        messageId: `m-${inputs.length}`,
        model: 'claude-opus-5-5',
        parentToolUseId: null,
        input: 5,
        cacheRead: 1_000_000,
        cacheWrite: 0,
        output: 4,
        usd: 0.01,
        price: PRICE,
      });
      return script(input);
    },
  } as unknown as AgentProcessRunner;
  const app = h.app;
  const runStop = new RunStop();
  const recorder = new AgentCallRecorder(
    h.calls,
    new CallContexts(h.runs, app.get(BacklogRepository), app.get(BacklogChatRepository), app.get(VisitStartRepository)),
    h.clock,
  );
  const launcher = new AgentLauncher(
    agent,
    app.get(VisitRepository),
    runStop,
    undefined,
    undefined,
    undefined,
    recorder,
  );
  const documents = app.get(DocumentRepository);
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: h.root, ...limits }));
  const door = new AgentDoor(
    launcher,
    h.runs,
    app.get(VisitRepository),
    app.get(VisitStartRepository),
    documents,
    new SpendLimit(h.runs, documents, h.calls, config),
    config,
    runStop,
    h.clock,
  );
  const gate = { paused: () => false } as ContainerGate;
  /** A server process: its service over the shared database. */
  const server = (): KeepWarm =>
    new KeepWarm(door, new PingCandidates(h.runs, h.calls, gate, h.clock, h.config), documents, h.config);
  /** A run with a worktree to mount, as a run that has been researched has. */
  const open = async (key: string, ...args: Parameters<typeof h.run> extends [string, ...infer R] ? R : never) => {
    const run = await h.run(key, ...args);
    mkdirSync(join(h.root, 'worktrees', key, 'demo'), { recursive: true });
    await documents.putDocument(run, ARTIFACTS.repos.kind, 'demo\n');
    return run;
  };
  const exchanges = () =>
    app
      .get(DataSource)
      .getRepository(AgentExchangeEntity)
      .find({ order: { id: 'ASC' } });
  const pings = async () => (await exchanges()).filter((row) => row.kind === 'ping');
  /** A launch of a visit in the chat of its session file, as the launcher writes its row. */
  const visit = (key: string, over: Partial<AgentLaunchRequest> = {}) =>
    launcher.launch({
      root: h.root,
      run: { id: 1, agentCalls: 0, spentUsd: 0, activeAttempt: 'attempt-1' },
      key,
      step: 'implement',
      mode: 'agent',
      tools: 'write',
      runtime: 'claude',
      model: 'claude-opus-5-5',
      timeLimitMs: 1000,
      prompt: 'go',
      workspace: h.root,
      mounts: [],
      ...over,
    });
  return {
    ...h,
    inputs,
    open,
    server,
    pings,
    exchanges,
    visit,
    onLaunch: (next: Script) => void (script = next),
    queries: () => new AgentCallQueries(app.get(DataSource)),
    /** One timer tick of the service, and the end of the pass it starts. */
    tick: async (service: KeepWarm) => {
      await service.schedule();
      jest.advanceTimersByTime(MINUTE_MS);
      await service.onModuleDestroy();
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function inWorld(test: (w: World) => Promise<void>, limits: Parameters<typeof testEnv>[0] = {}): Promise<void> {
  const w = await world(limits);
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  try {
    await test(w);
  } finally {
    jest.useRealTimers();
    await w.close();
  }
}

describe('KeepWarm', () => {
  it('pings a chat idle 50 minutes once, on a fork with the last row model and effort, as one row', () =>
    inWorld(async (w) => {
      await w.open('run-a');
      const { chatId, callId } = await w.chat('run-a', { idleMin: 50 });
      const service = w.server();
      await w.tick(service);
      await w.tick(service);

      expect(w.inputs).toHaveLength(1);
      expect(w.inputs[0]).toMatchObject({
        fork: true,
        tools: 'none',
        resumeChatId: chatId,
        runtime: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
      });
      const [row, ...others] = await w.pings();
      expect(others).toEqual([]);
      expect(row).toMatchObject({
        kind: 'ping',
        chatId,
        previousId: callId,
        dueAt: w.ago(0),
        endKind: 'done',
        model: 'claude-opus-5-5',
        effort: 'high',
        runKey: 'run-a',
        step: 'implement',
      });
      expect(row.ownUsd).toBeGreaterThan(0);
    }));

  it('does not ping a chat idle 30 minutes', () =>
    inWorld(async (w) => {
      await w.open('run-a');
      await w.chat('run-a', { idleMin: 30 });
      await w.tick(w.server());
      expect(w.inputs).toEqual([]);
      expect(await w.pings()).toEqual([]);
    }));

  it("pings an epic's parent chat until the epic merges", () =>
    inWorld(async (w) => {
      const epicAt = { epicAt: AT };
      await w.open('epic-1', { status: 'done' }, epicAt);
      const { chatId } = await w.chat('epic-1', { home: 'plan', idleMin: 50 });
      const service = w.server();
      await w.tick(service);
      expect(w.inputs).toHaveLength(1);

      w.clock.advance(50 * MINUTE_MS);
      await w.tick(service);
      expect(w.inputs).toHaveLength(2);

      await w.open('epic-1', { status: 'done', merge: { merged: {} } }, epicAt);
      w.clock.advance(50 * MINUTE_MS);
      await w.tick(service);
      expect(w.inputs).toHaveLength(2);
      expect((await w.exchanges()).at(-1)).toMatchObject({ kind: 'ping-stop', stopReason: 'epic-merged', chatId });
    }));

  it('stops pinging after write price divided by read price pings without a call, with a cap-reached row', () =>
    inWorld(async (w) => {
      await w.open('run-a');
      const { chatId, callId } = await w.chat('run-a', { idleMin: 2400 });
      for (let nth = 1; nth < 40; nth += 1) await w.ping('run-a', chatId, callId, nth, { idleMin: 50 });
      const service = w.server();
      await w.tick(service);
      expect(w.inputs).toHaveLength(1);
      expect(await w.pings()).toHaveLength(40);

      w.clock.advance(50 * MINUTE_MS);
      await w.tick(service);
      expect(w.inputs).toHaveLength(1);
      expect((await w.exchanges()).at(-1)).toMatchObject({ kind: 'ping-stop', stopReason: 'cap-reached', chatId });
    }));

  it.each([
    ['MAX_RUN_USD', { MAX_RUN_USD: 1 }, { usd: 2, tokens: 0 }],
    ['MAX_RUN_TOKENS', { MAX_RUN_TOKENS: 100 }, { usd: 0, tokens: 500 }],
  ])('does not ping a run over %s', (_name, limits, spent) =>
    inWorld(async (w) => {
      await w.open('run-a');
      const { callId } = await w.chat('run-a', { idleMin: 50 });
      await w.calls.addRequest(callId, {
        model: 'claude-opus-5-5',
        input: spent.tokens,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        usd: spent.usd,
        price: PRICE,
      });
      await w.tick(w.server());
      expect(w.inputs).toEqual([]);
      expect(await w.pings()).toEqual([]);
    }, limits),
  );

  it('closes the pings a dead process left open when it is scheduled, and writes no second row for their due time', () =>
    inWorld(async (w) => {
      await w.open('run-a');
      const { chatId, callId } = await w.chat('run-a', { idleMin: 50 });
      const dueAt = w.ago(0);
      await w.calls.insertPing({
        startedAt: dueAt,
        dueAt,
        chatId,
        previousId: callId,
        runKey: 'run-a',
        runtime: 'claude',
        model: 'claude-opus-5-5',
        requestText: 'one word',
      });
      const service = w.server();
      await w.tick(service);

      expect(w.inputs).toEqual([]);
      const [dead, ...others] = await w.pings();
      expect(others).toEqual([]);
      expect(dead).toMatchObject({ endKind: 'failed', errorText: 'process died', dueAt });
      expect((await w.exchanges()).at(-1)).toMatchObject({ kind: 'ping-stop', stopReason: 'ping-failed' });
    }));

  it('does not ping a due time twice across a restart', () =>
    inWorld(async (w) => {
      await w.open('run-a');
      await w.chat('run-a', { idleMin: 50 });
      await w.tick(w.server());
      await w.tick(w.server());
      expect(w.inputs).toHaveLength(1);
      expect(await w.pings()).toHaveLength(1);
    }));

  it("records a failed ping with its end and ends the chat's pings until its next call", () =>
    inWorld(async (w) => {
      await w.open('run-a');
      const { chatId } = await w.chat('run-a', { idleMin: 50 });
      w.onLaunch(async () => ({ ...emptyResult('time', 0, 1, AT), killReason: null, exitCode: 2, chatId: 'fork' }));
      const service = w.server();
      await w.tick(service);
      expect(await w.pings()).toMatchObject([{ endKind: 'failed', errorClass: 'exit', exitCode: 2, chatId }]);

      w.clock.advance(50 * MINUTE_MS);
      await w.tick(service);
      w.clock.advance(50 * MINUTE_MS);
      await w.tick(service);
      expect(w.inputs).toHaveLength(1);
      expect((await w.exchanges()).filter((row) => row.kind === 'ping-stop')).toMatchObject([
        { stopReason: 'ping-failed' },
      ]);

      w.onLaunch(async () => ({ ...emptyResult('time', 0, 1, AT), killReason: null, chatId }));
      await w.visit('run-a');
      w.clock.advance(50 * MINUTE_MS);
      await w.tick(service);
      expect(w.inputs).toHaveLength(3);
      expect(await w.pings()).toHaveLength(2);
    }));

  it('is read by the keep-warm figures as pings, with the saving of the call that resumed after them and none for a chat that closed without a call', () =>
    inWorld(async (w) => {
      await w.open('run-a');
      const kept = await w.chat('run-a', { idleMin: 50 });
      await w.open('run-b');
      const closed = await w.chat('run-b', { idleMin: 50 });
      const service = w.server();
      await w.tick(service);
      w.clock.advance(50 * MINUTE_MS);
      await w.tick(service);
      expect(await w.pings()).toHaveLength(4);

      w.onLaunch(async () => ({ ...emptyResult('time', 0, 1, AT), killReason: null, chatId: kept.chatId }));
      w.clock.advance(50 * MINUTE_MS);
      await w.visit('run-a');
      await w.run('run-b', { status: 'done', merge: { merged: {} } });
      w.clock.advance(MINUTE_MS);
      await w.tick(service);

      const figures = await w.queries().keepWarm(60);
      const of = (chatId: string) => figures.chats.find((chat) => chat.chatId === chatId);
      expect(of(kept.chatId)).toMatchObject({ pings: 2, hits: 2, misses: 0 });
      expect(of(kept.chatId)?.saving).toBeCloseTo((1_000_000 * (8 - 0.2)) / 1_000_000 - 0.02, 6);
      expect(of(closed.chatId)).toMatchObject({ pings: 2, saving: 0 });
      expect(of(closed.chatId)?.cost).toBeCloseTo(0.02, 9);
    }));

  it('stops its timer on close', () =>
    inWorld(async (w) => {
      await w.open('run-a');
      await w.chat('run-a', { idleMin: 50 });
      const service = w.server();
      await service.schedule();
      await service.onModuleDestroy();
      jest.advanceTimersByTime(10 * MINUTE_MS);
      await service.onModuleDestroy();
      expect(w.inputs).toEqual([]);
    }));
});
