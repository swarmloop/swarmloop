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
  const port = new SubtaskPort(
    {} as never,
    {
      latestBody: async (_key: string, kind: string) => stored[kind] ?? (kind === 'research_result' ? null : 'app\n'),
    } as never,
    { submit } as never,
    { launch } as never,
    {
      finishVisit: async (_run: unknown, visit: VisitDraft) => {
        finished.push(visit);
      },
    } as never,
    new AppConfig(testEnv({ SWARMLOOP_ROOT: dir, AGENTS_PLAN: 'claude:m-plan', ...env })),
    new FakeClock(),
  );
  const opened = { run: parent, startedAt: '2026-01-01T00:00:00.000Z' } as never;
  await port.answer(opened, { key: 'child' } as RunEntity, { id: 't1' } as never, 'contract');
  return { input: launch.mock.calls[0][0], visit: finished[0], submit };
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
