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

async function asked(env: Parameters<typeof testEnv>[0], epic: boolean) {
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
  const finished: VisitDraft[] = [];
  const port = new SubtaskPort(
    {} as never,
    { latestBody: async () => 'app\n' } as never,
    { submit: async () => undefined } as never,
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
  return { input: launch.mock.calls[0][0], visit: finished[0] };
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
