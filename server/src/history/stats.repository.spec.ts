import { DataSource } from 'typeorm';
import { AgentCallRepository } from './agent-call.repository';
import { seedCall, seedPingCall } from './agent-call.spec-helpers';
import { BacklogMessageEntity } from './backlog-planner.entities';
import { CommandEntity, DocumentEntity, LoopEventEntity, RunEntity, StepStatEntity } from './entities';
import { ServerStallEntity } from './server-stall.entities';
import { repositoryDatabase } from './repository.spec-helpers';
import { StatsRepository } from './stats.repository';

function run(key: string, createdAt: string): Partial<RunEntity> {
  return {
    key,
    status: 'done',
    currentStep: 'done',
    runtime: 'claude',
    codeHost: '',
    createdAt,
    updatedAt: createdAt,
  };
}

describe('StatsRepository', () => {
  it('reads the runs from a time on, with their steps and returns, and when the first run started', async () => {
    const db = await repositoryDatabase();
    try {
      const data = db.app.get(DataSource);
      const [old, recent] = await data
        .getRepository(RunEntity)
        .save([run('old', '2026-10-01T00:00:00.000Z'), run('recent', '2026-11-05T00:00:00.000Z')]);
      const stat = (runId: number): Partial<StepStatEntity> => ({
        runId,
        step: 'implement',
        attempt: 1,
        model: 'm',
        startedAt: '2026-11-05T00:00:00.000Z',
        finishedAt: '2026-11-05T00:01:00.000Z',
        durationMs: 60_000,
        status: 'done',
      });
      const stored = await data.getRepository(StepStatEntity).save([stat(old.id), stat(recent.id)]);
      const calls = db.app.get(AgentCallRepository);
      await seedCall(calls, { runKey: 'old', statId: stored[0]?.id, usd: 1 });
      await seedCall(calls, { runKey: 'recent', statId: stored[1]?.id, usd: 2 });
      await data.getRepository(LoopEventEntity).save([
        {
          runId: old.id,
          counter: 'review',
          attempt: 1,
          reason: 'review_quality',
          createdAt: '2026-10-01T01:00:00.000Z',
        },
        { runId: recent.id, counter: 'pipeline', attempt: 1, reason: 'ci', createdAt: '2026-11-05T01:00:00.000Z' },
      ]);
      const stats = db.app.get(StatsRepository);

      const since = await stats.rows('2026-11-01T00:00:00.000Z');
      expect(since.firstRunAt).toBe('2026-10-01T00:00:00.000Z');
      expect(since.runs.map((row) => row.key)).toEqual(['recent']);
      expect(since.steps.map((row) => row.usd)).toEqual([2]);
      expect(since.loops.map((row) => row.counter)).toEqual(['pipeline']);

      const all = await stats.rows(null);
      expect(all.runs.map((row) => row.key)).toEqual(['old', 'recent']);
      expect(all.steps).toHaveLength(2);
      expect(all.loops).toHaveLength(2);
      expect(await stats.rows('2027-01-01T00:00:00.000Z')).toEqual({
        firstRunAt: '2026-10-01T00:00:00.000Z',
        runs: [],
        steps: [],
        loops: [],
        stalls: [],
        person: { answers: [], planChats: [], backlogMessages: [] },
      });
    } finally {
      await db.close();
    }
  });

  it('takes the cost and tokens of a visit from the log rows linked to it, and the pings of a run as rows of their own', async () => {
    const db = await repositoryDatabase();
    try {
      const data = db.app.get(DataSource);
      const calls = db.app.get(AgentCallRepository);
      const [one] = await data.getRepository(RunEntity).save([run('one', '2026-11-05T00:00:00.000Z')]);
      const visit = await data.getRepository(StepStatEntity).save({
        runId: one?.id,
        step: 'implement',
        attempt: 1,
        model: 'm',
        startedAt: '2026-11-05T00:00:00.000Z',
        finishedAt: '2026-11-05T00:01:00.000Z',
        durationMs: 60_000,
        status: 'done',
        usd: 99,
        tokensIn: 99,
        tokensOut: 99,
      });
      await seedCall(calls, {
        runKey: 'one',
        statId: visit.id,
        usd: 0.5,
        input: 10,
        cacheRead: 100,
        cacheWrite: 20,
        output: 5,
      });
      await seedCall(calls, { runKey: 'one', statId: visit.id, usd: 0.25, input: 1, output: 4 });
      // Left out: an unlinked row, a ping of a run nobody stored, and a turn of the backlog planner.
      await seedCall(calls, { runKey: 'one', usd: 7, output: 1000 });
      await seedPingCall(data, calls, { runKey: 'gone', usd: 3 });
      const turn = await calls.open({
        kind: 'call',
        startedAt: '2026-11-05T00:00:00.000Z',
        resumed: false,
        runtime: 'claude',
        model: 'm',
        requestText: 'turn',
        turnKey: 'turn-1',
      });
      await calls.addRequest(turn, { model: 'm', input: 1, cacheRead: 0, cacheWrite: 0, output: 1, usd: 5, price: {} });
      await seedPingCall(data, calls, { runKey: 'one', step: 'implement', usd: 0.125, cacheRead: 300, output: 2 });

      const { steps } = await db.app.get(StatsRepository).rows(null);

      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ step: 'implement', usd: 0.75, tokensIn: 131, tokensOut: 9, durationMs: 60_000 });
      expect(steps[0]?.ping).toBeUndefined();
      expect(steps[1]).toMatchObject({
        runId: one?.id,
        step: 'implement',
        usd: 0.125,
        tokensIn: 300,
        tokensOut: 2,
        ping: true,
      });
    } finally {
      await db.close();
    }
  });

  it('reads what people wrote from a time on: answers with a person, the latest plan chats and backlog messages', async () => {
    const db = await repositoryDatabase();
    try {
      const data = db.app.get(DataSource);
      const [one, two] = await data
        .getRepository(RunEntity)
        .save([run('one', '2026-11-05T00:00:00.000Z'), run('two', '2026-10-01T00:00:00.000Z')]);
      const command = (id: string, type: string, actor: string | null, createdAt: string): Partial<CommandEntity> => ({
        id,
        runId: one.id,
        type,
        payload: '{}',
        actor,
        state: 'done',
        createdAt,
        updatedAt: createdAt,
      });
      await data
        .getRepository(CommandEntity)
        .save([
          command('new', 'answer', 'ada', '2026-11-05T00:00:00.000Z'),
          command('old', 'answer', 'ada', '2026-10-01T00:00:00.000Z'),
          command('anonymous', 'answer', null, '2026-11-05T00:00:00.000Z'),
          command('other', 'resume', 'ada', '2026-11-05T00:00:00.000Z'),
        ]);
      const chat = (runId: number, body: string, createdAt: string): Partial<DocumentEntity> => ({
        runId,
        stepStatId: 0,
        kind: 'plan_chat',
        attempt: 1,
        body,
        path: 'p',
        createdAt,
      });
      await data
        .getRepository(DocumentEntity)
        .save([
          chat(one.id, 'first', '2026-11-04T00:00:00.000Z'),
          chat(one.id, 'second', '2026-11-05T00:00:00.000Z'),
          chat(two.id, 'stale', '2026-10-01T00:00:00.000Z'),
        ]);
      const message = (
        key: string,
        author: string,
        kind: string,
        createdAt: string,
      ): Partial<BacklogMessageEntity> => ({
        backlogId: 1,
        messageKey: key,
        author,
        kind,
        text: 't',
        createdAt,
      });
      await data
        .getRepository(BacklogMessageEntity)
        .save([
          message('a', 'person', 'message', '2026-11-05T00:00:00.000Z'),
          message('b', 'planner', 'message', '2026-11-05T00:00:00.000Z'),
          message('c', 'person', 'message', '2026-10-01T00:00:00.000Z'),
          message('d', 'person', 'reply', '2026-11-05T00:00:00.000Z'),
        ]);

      const { person } = await db.app.get(StatsRepository).rows('2026-11-01T00:00:00.000Z');

      expect(person).toEqual({
        answers: [{ id: 'new', createdAt: '2026-11-05T00:00:00.000Z' }],
        planChats: ['second'],
        backlogMessages: [{ createdAt: '2026-11-05T00:00:00.000Z' }],
      });
    } finally {
      await db.close();
    }
  });

  it('reads the latest plan chat of a run created before the range that got a message inside it', async () => {
    const db = await repositoryDatabase();
    try {
      const data = db.app.get(DataSource);
      const [old] = await data.getRepository(RunEntity).save([run('old', '2026-10-01T00:00:00.000Z')]);
      await data.getRepository(CommandEntity).save({
        id: 'chat',
        runId: old.id,
        type: 'plan-chat',
        payload: '{}',
        actor: 'ada',
        state: 'done',
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:00:00.000Z',
      });
      await data.getRepository(DocumentEntity).save({
        runId: old.id,
        stepStatId: 0,
        kind: 'plan_chat',
        attempt: 1,
        body: 'latest',
        path: 'p',
        createdAt: '2026-11-05T00:00:00.000Z',
      });

      const { person } = await db.app.get(StatsRepository).rows('2026-11-01T00:00:00.000Z');

      expect(person.planChats).toEqual(['latest']);
    } finally {
      await db.close();
    }
  });

  it('reads no document of a run that did not change inside the range', async () => {
    const db = await repositoryDatabase();
    try {
      const data = db.app.get(DataSource);
      const [old] = await data.getRepository(RunEntity).save([run('old', '2026-10-01T00:00:00.000Z')]);
      await data.getRepository(DocumentEntity).save({
        runId: old.id,
        stepStatId: 0,
        kind: 'plan_chat',
        attempt: 1,
        body: 'unread',
        path: 'p',
        createdAt: '2026-11-05T00:00:00.000Z',
      });

      const { person } = await db.app.get(StatsRepository).rows('2026-11-01T00:00:00.000Z');

      expect(person.planChats).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('reads the server stalls from the start of the range, all when there is none, also without runs', async () => {
    const db = await repositoryDatabase();
    try {
      const stall = (startedAt: string): Partial<ServerStallEntity> => ({
        startedAt,
        durationMs: 20_000,
        kind: 'host-paused',
        runningAgents: 0,
        runningChecks: 0,
        runningSetups: 0,
        cpuPercent: 0,
        memoryBytes: 0,
      });
      await db.app
        .get(DataSource)
        .getRepository(ServerStallEntity)
        .save([stall('2026-10-01T00:00:00.000Z'), stall('2026-11-05T00:00:00.000Z')]);
      const stats = db.app.get(StatsRepository);

      expect((await stats.rows('2026-11-01T00:00:00.000Z')).stalls).toEqual([
        { startedAt: '2026-11-05T00:00:00.000Z', durationMs: 20_000, kind: 'host-paused' },
      ]);
      expect((await stats.rows(null)).stalls).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it('gives a run the prompt a name and a title need: a prefix when it holds the first text line, else the whole text', async () => {
    const db = await repositoryDatabase();
    try {
      const long = 'x'.repeat(5000);
      const marks = `${'-'.repeat(4500)}\nreal title\nmore`;
      const prompts = [`first line\n${long}`, long, marks, 'short'];
      await db.app
        .get(DataSource)
        .getRepository(RunEntity)
        .save(prompts.map((prompt, index) => ({ ...run(`prompt-${index}`, '2026-11-05T00:00:00.000Z'), prompt })));

      const rows = await db.app.get(StatsRepository).rows(null);

      const [prefixed, oneLine, markOnly, small] = rows.runs.map((row) => row.prompt ?? '');
      expect(prefixed.split('\n')[0]).toBe('first line');
      expect(oneLine).toBe(long);
      expect(markOnly).toBe(marks);
      expect(small).toBe('short');
    } finally {
      await db.close();
    }
  });
});
