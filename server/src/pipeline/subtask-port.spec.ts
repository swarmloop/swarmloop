import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { RunEntity } from '../history/entities';
import { sessionFileName, sessionHome } from '../history/session-group';
import type { VisitDraft } from '../history/visit';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { renderQuestions } from '../steps/research/research-record';
import { SubtaskPort } from './subtask-port';

const answered = {
  responseText: 'use the shared helper',
  resultValue: { answer: 'use the shared helper' },
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

async function asked(env: Parameters<typeof testEnv>[0], epic: boolean, stored: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmloop-subtask-port-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(agentStateDir(dir, 'parent', sessionHome('plan')), { recursive: true });
  writeFileSync(
    join(dir, 'data', sessionFileName('parent', 'plan')),
    JSON.stringify({ runtime: 'claude', chatId: 'chat-1', usd: 0 }),
  );
  const parent = {
    key: 'parent',
    targetPath: dir,
    agentCalls: 0,
    spentUsd: 0,
    epicAt: epic ? '2026-01-01T00:00:00.000Z' : null,
  } as unknown as RunEntity;
  const launch = jest.fn().mockResolvedValue(answered);
  const submit = jest.fn().mockResolvedValue(undefined);
  const finished: VisitDraft[] = [];
  /** Plan visits of the parent that the planner did not make as answers. */
  const earlier: VisitDraft[] = [];
  const port = new SubtaskPort(
    {} as never,
    {
      latestBody: async (_key: string, kind: string) =>
        stored[kind] ?? (['research_result', 'plan_result', 'implementation_result'].includes(kind) ? null : 'app\n'),
      putDocument: async () => undefined,
    } as never,
    { submit } as never,
    { launch } as never,
    {
      finishVisit: async (_run: unknown, visit: VisitDraft) => {
        finished.push(visit);
      },
      listStats: async () => [...earlier, ...finished].map(() => ({ step: 'plan' })),
    } as never,
    new AppConfig(testEnv({ SWARMLOOP_ROOT: dir, AGENTS_PLAN: 'claude:m-plan', ...env })),
    new FakeClock(),
  );
  const opened = { run: parent, startedAt: '2026-01-01T00:00:00.000Z' } as never;
  await port.answer(opened, { key: 'child' } as RunEntity, { id: 't1' } as never, 'contract');
  const again = (): Promise<string | null> =>
    port.answer(opened, { key: 'child-2' } as RunEntity, { id: 't2' } as never, 'contract');
  return { input: launch.mock.calls[0][0], visit: finished[0], submit, launch, earlier, again };
}

describe('SubtaskPort planner answer', () => {
  it('answers at the epic effort and records it on the visit', async () => {
    const { input, visit } = await asked({ EPIC_EFFORT: 'xhigh' }, true);

    expect(input).toMatchObject({ effort: 'xhigh', effortNote: 'epic' });
    expect(visit).toMatchObject({ effort: 'xhigh', effortNote: 'epic' });
  });

  it('shows no effort for a parent whose agent has none and with the epic setting off', async () => {
    const { input, visit } = await asked({ EPIC_EFFORT: '' }, true);

    expect('effort' in input).toBe(false);
    expect('effort' in visit).toBe(false);
  });
});

describe('the result prompt of the planner answer', () => {
  const prompts = (launch: jest.Mock): string[] =>
    launch.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);

  it('asks for the result block in full once, and in one line for the next subtask of the same plan chat', async () => {
    const { launch, again } = await asked({}, false, { questions: '- one?\n' });
    await again();

    const [first, second] = prompts(launch);
    expect(first).toContain('- answer (string, required)');
    expect(second).not.toContain('- answer (string, required)');
    expect(second).toContain('End with the result block as before.');
  });

  it('asks in full again once the parent has made a new plan visit', async () => {
    const { launch, again, earlier } = await asked({}, false, { questions: '- one?\n' });
    earlier.push({} as VisitDraft);
    await again();

    expect(prompts(launch)[1]).toContain('- answer (string, required)');
  });

  it('answers with the whole answer field', async () => {
    const { submit } = await asked({}, false, { questions: '- one?\n' });

    expect(submit.mock.calls[0][2].answers[0].body).toBe('use the shared helper');
  });
});

describe("SubtaskPort answers a subtask's questions", () => {
  it('answers each question of the research result whole, with its own id', async () => {
    const questions = ['Is it ok?\n  - nested: yes\n1. first', 'second?'];
    const stored = {
      questions: renderQuestions(questions),
      research_result: ARTIFACTS.researchResult.format({ summary: [], questions, impact: [] }),
    };
    const { submit } = await asked({}, false, stored);

    const [, , { answers }] = submit.mock.calls[0];
    expect(answers.map((item: { id: string }) => item.id)).toEqual(questions);
  });

  it('answers each question of the plan result whole when the plan wrote the questions', async () => {
    const questions = ['Is it ok?\n  - nested: yes\n1. first', 'second?'];
    const stored = {
      questions: renderQuestions(questions),
      research_result: ARTIFACTS.researchResult.format({ summary: [], questions: ['from research'], impact: [] }),
      plan_result: ARTIFACTS.planResult.format({ summary: [], plan: [], questions, contract: [], tasks: [], keep: [] }),
    };
    const { submit } = await asked({}, false, stored);

    expect(submit.mock.calls[0][2].answers.map((item: { id: string }) => item.id)).toEqual(questions);
  });

  it('reads the questions of a run that has no research result', async () => {
    const { submit } = await asked({}, false, { questions: '- one?\n- two?\n' });

    expect(submit.mock.calls[0][2].answers.map((item: { id: string }) => item.id)).toEqual(['one?', 'two?']);
  });
});

describe('SubtaskPort asking', () => {
  const question = 'Is it ok?\n  - nested: yes\n1. first';
  const port = (stored: Record<string, string>) =>
    new SubtaskPort(
      {} as never,
      { latestBody: async (_key: string, kind: string) => stored[kind] ?? null } as never,
      {} as never,
      {} as never,
      {} as never,
      new AppConfig(testEnv({})),
      new FakeClock(),
    );
  const run = { key: 'child', status: 'waiting', currentStep: 'research' } as RunEntity;
  const questions = {
    questions: renderQuestions([question]),
    research_result: ARTIFACTS.researchResult.format({ summary: [], questions: [question], impact: [] }),
  };

  it('asks while a multi-line question has no answer, and stops once it is answered whole', async () => {
    expect(await port(questions).asking(run)).toBe(true);
    expect(await port({ ...questions, answers: `question: ${question}\nanswer: yes\n` }).asking(run)).toBe(false);
  });
});
