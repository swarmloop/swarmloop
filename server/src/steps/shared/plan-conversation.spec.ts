import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { PlanChatLog } from '../../contract/plan-chat';
import type { RunEntity } from '../../history/entities';
import { sessionFileName, sessionHome } from '../../history/session-group';
import type { VisitDraft } from '../../history/visit';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { subtaskAnswer } from '../../agent-result/definitions/subtask-answer';
import { ARTIFACTS } from '../contract/artifacts';
import type { ModelStepContext } from '../model-step-context';
import { withPlan } from '../plan/plan-record';
import { PlanConversation } from './plan-conversation';

const answered = {
  responseText: '',
  resultValue: { answer: 'use the helper' },
  chatId: 'chat-1',
  tokensIn: 0,
  tokensOut: 0,
  usd: 0,
  killReason: null,
  exitCode: 0,
  resumed: true,
  calls: 1,
  samples: [],
  durationMs: 0,
  startedAt: '',
  finishedAt: '',
};
const OLD = ['old item - files: a.ts - proof: a.spec.ts'];
const NEW = ['new item - files: a.ts - proof: a.spec.ts'];

function setup(options: { chat?: boolean; split?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmloop-plan-conversation-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(agentStateDir(dir, 'run-1', sessionHome('plan')), { recursive: true });
  if (options.chat !== false) {
    writeFileSync(
      join(dir, 'data', sessionFileName('run-1', 'plan')),
      JSON.stringify({ runtime: 'claude', chatId: 'chat-1', usd: 0, resultName: 'plan' }),
    );
  }
  const run = {
    key: 'run-1',
    targetPath: dir,
    split: options.split ?? false,
    agentCalls: 0,
    spentUsd: 0,
  } as unknown as RunEntity;
  const launch = jest.fn().mockResolvedValue(answered);
  const finished: VisitDraft[] = [];
  const log: PlanChatLog = { entries: [], revisions: [] };
  const store = {
    read: async () => log,
    appendEntry: async (_key: string, entry: PlanChatLog['entries'][number]) => void log.entries.push(entry),
    appendRevision: async (_key: string, revision: PlanChatLog['revisions'][number]) =>
      void log.revisions.push(revision),
  };
  const stored: Record<string, unknown> = {
    [ARTIFACTS.requirements.kind]: withPlan('{"prompt":"x"}\n', {
      name: '',
      overview: '',
      items: OLD,
      decision: 'approve',
    }),
    [ARTIFACTS.repos.kind]: ['billing-api'],
    [ARTIFACTS.requirementList.kind]: [{ id: 'R1', text: 'one' }],
    [ARTIFACTS.requirementCoverage.kind]: [{ id: 'R1', text: 'one', items: OLD }],
  };
  const documents = {
    latestBody: async (_key: string, kind: string) => (kind === 'repos' ? 'billing-api\n' : (stored[kind] as string)),
    latestDocument: async () => null,
  };
  const conversation = new PlanConversation(
    { launch } as never,
    {
      finishVisit: async (_run: unknown, visit: VisitDraft) => void finished.push(visit),
      hasAgentVisit: async () => false,
    } as never,
    documents as never,
    new AppConfig(testEnv({ SWARMLOOP_ROOT: dir, AGENTS_PLAN: 'claude:m-plan', PLAN_TIMEOUT_MS: 1234 })),
    new FakeClock(),
    store as never,
  );
  const relaunch = jest.fn();
  const ctx = {
    opened: { run, startedAt: '2026-11-17T10:00:00.000Z' },
    reread: async (artifact: { kind: string }) => stored[artifact.kind] ?? null,
    launch: relaunch,
  } as unknown as ModelStepContext;
  return { conversation, launch, finished, log, ctx, relaunch, run, stored };
}

describe('PlanConversation.visit', () => {
  it('launches a follow-up visit of the plan step in plan mode with the read-only plan tools and its mounts', async () => {
    const { conversation, launch, finished, run } = setup();
    const opened = { run, startedAt: '2026-11-17T10:00:00.000Z' } as never;

    const visit = await conversation.visit(opened, (received) => `asked after ${received}`, subtaskAnswer);

    expect(visit).toEqual({ value: { answer: 'use the helper' } });
    const request = launch.mock.calls[0][0];
    expect(request).toMatchObject({
      step: 'plan',
      mode: 'plan',
      tools: 'plan',
      key: 'run-1',
      timeLimitMs: 1234,
      prompt: 'asked after plan',
    });
    expect(request.result.name).toBe('subtask_answer');
    expect(request.mounts).toEqual([{ hostPath: run.targetPath, containerPath: '/work' }]);
    expect(finished).toMatchObject([{ step: 'plan', mode: 'plan', status: 'done', exitCode: 0 }]);
  });

  it('launches nothing and records no visit when the run has no plan chat', async () => {
    const { conversation, launch, finished, run } = setup({ chat: false });

    expect(await conversation.visit({ run, startedAt: '' } as never, () => 'x', subtaskAnswer)).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(finished).toEqual([]);
  });

  it('records a failed visit and gives nothing when the launch fails', async () => {
    const { conversation, launch, finished, run } = setup();
    launch.mockRejectedValue(new Error('boom'));

    await expect(conversation.visit({ run, startedAt: '' } as never, () => 'x', subtaskAnswer)).resolves.toBeNull();
    expect(finished).toMatchObject([{ step: 'plan', exitCode: 1 }]);
  });
});

describe('PlanConversation.applyReply', () => {
  it('checks the plan of a reply as a first plan: a run that may not split refuses tasks', async () => {
    const { conversation, ctx, relaunch } = setup();
    relaunch.mockResolvedValue({ resultValue: { reply: 'ok', plan: NEW, covers: [['R1', 'R2']], requirements: [] } });
    const task = {
      id: 'a',
      title: 't',
      depends: [],
      files: ['a.ts'],
      proof: 'p',
      description: 'd',
      covers: ['R1', 'R2'],
    };

    await conversation.applyReply(
      ctx,
      { reply: 'ok', requirements: ['two'], summary: [], plan: NEW, covers: [['R1']] },
      'why',
    );

    const request = relaunch.mock.calls[0][0] as {
      prompt: string;
      check: (value: unknown) => string[];
      result: unknown;
    };
    expect(
      request.check({ reply: 'x', tasks: [task], contract: [{ id: 'item-1', text: 'c', owner: 'a' }] }),
    ).not.toEqual([]);
    expect(request.check({ reply: 'x', plan: NEW })).toEqual([]);
  });

  it('gives an added requirement the next id, and asks once for a plan that does not cover it', async () => {
    const { conversation, ctx, relaunch, log } = setup();
    relaunch.mockResolvedValue({
      resultValue: {
        reply: 'Covered.',
        summary: ['s'],
        plan: [...NEW, 'two - files: b.ts - proof: b.spec.ts'],
        covers: [['R1'], ['R2']],
      },
    });

    const applied = await conversation.applyReply(
      ctx,
      { reply: 'Added.', requirements: ['two'], summary: ['s'], plan: NEW, covers: [['R1']] },
      'also two',
    );

    expect((relaunch.mock.calls[0][0] as { prompt: string }).prompt).toContain('R2 is not covered: two');
    const written = Object.fromEntries(applied.outputs.map((output) => [output.artifact.kind, output.value]));
    expect(written[ARTIFACTS.requirementList.kind]).toEqual([
      { id: 'R1', text: 'one' },
      { id: 'R2', text: 'two' },
    ]);
    expect(log.entries).toMatchObject([{ role: 'planner', text: 'Added.', version: 2 }]);
    expect(log.revisions).toMatchObject([{ version: 2, reason: 'also two', added: expect.any(Array) }]);
  });

  it('keeps the stored plan for a reply without a plan or requirements, and records the reply once', async () => {
    const { conversation, ctx, log, relaunch } = setup();

    expect(await conversation.applyReply(ctx, { reply: 'It does.' }, 'a question')).toEqual({ outputs: [] });
    await conversation.applyReply(ctx, { reply: 'It does.' }, 'a question');

    expect(relaunch).not.toHaveBeenCalled();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ role: 'planner', text: 'It does.', state: 'taken' });
    expect(log.entries[0].version).toBeUndefined();
    expect(log.revisions).toEqual([]);
  });

  it('writes the plan outputs of a changed plan, with the requirements record holding the new items', async () => {
    const { conversation, ctx } = setup();

    const applied = await conversation.applyReply(
      ctx,
      { reply: 'Changed.', summary: ['why'], plan: NEW, covers: [['R1']] },
      'change it',
    );

    const written = Object.fromEntries(applied.outputs.map((output) => [output.artifact.kind, output.value]));
    expect(JSON.parse(written[ARTIFACTS.requirements.kind] as string).plan).toMatchObject({
      items: NEW,
      decision: null,
    });
    expect(written[ARTIFACTS.planResult.kind]).toMatchObject({ plan: NEW });
    expect(applied.handoff).toContain('why');
  });
});

describe('PlanConversation.applyReply for a split run whose tasks started', () => {
  const task = (id: string, status: string, depends: string[] = []) => ({
    id,
    title: `Task ${id}`,
    description: `Do ${id}.`,
    depends,
    files: [`${id}.ts`],
    proof: `${id}.spec.ts`,
    covers: ['R1'],
    status,
  });
  const reply = {
    reply: 'Added.',
    summary: ['d'],
    contract: [{ id: '', text: 'd uses c', owner: '' }],
    tasks: [{ ...task('d', 'pending', ['c']), covers: ['R1'] }],
    keep: [],
  };

  function started() {
    const made = setup({ split: true });
    made.stored[ARTIFACTS.subtasks.kind] = [task('a', 'merged'), task('c', 'running', ['a'])];
    made.stored[ARTIFACTS.contract.kind] = '- store UTC';
    made.stored[ARTIFACTS.keep.kind] = [];
    made.stored[ARTIFACTS.requirements.kind] = withPlan('{"prompt":"x"}\n', {
      name: '',
      overview: '',
      items: ['Task a - files: a.ts - proof: a.spec.ts', 'Task c - files: c.ts - proof: c.spec.ts'],
      decision: 'approve',
    });
    return made;
  }

  it('appends the added tasks to the stored ones, and the revision lists only the added item', async () => {
    const { conversation, ctx, log } = started();

    const applied = await conversation.applyReply(ctx, reply, 'also d');

    const written = Object.fromEntries(applied.outputs.map((output) => [output.artifact.kind, output.value]));
    const tasks = written[ARTIFACTS.subtasks.kind] as { id: string; status: string }[];
    expect(tasks.map((item) => [item.id, item.status])).toEqual([
      ['a', 'merged'],
      ['c', 'running'],
      ['d', 'pending'],
    ]);
    expect(written[ARTIFACTS.contract.kind]).toBe('- store UTC\n\n- d uses c');
    expect((written[ARTIFACTS.planResult.kind] as { tasks: unknown[] }).tasks).toHaveLength(3);
    expect(log.revisions).toMatchObject([{ added: ['Task d - files: d.ts - proof: d.spec.ts'] }]);
  });

  it('changes nothing for a reply without tasks', async () => {
    const { conversation, ctx } = started();

    expect(await conversation.applyReply(ctx, { reply: 'It does.' }, 'a question')).toEqual({ outputs: [] });
  });
});
