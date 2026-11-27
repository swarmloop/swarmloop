import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeRequestText } from '../../agent-result/definitions/merge-request-text';
import { HostUnavailable } from '../../core/swarmloop-error';
import type { AppConfig } from '../../config/env';
import type { RunEntity } from '../../history/entities';
import { sessionFileName, sessionHome } from '../../history/session-group';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import type { AgentDoor } from './agent-door';
import type { AgentLaunchRequest } from './agent-launch-request';
import { ImplementChat } from './implement-chat';
import { result } from '../plan/plan.step.spec-helpers';

const KEY = 'PROJ-1';
const RUN = { key: KEY, parentRunId: null, targetPath: null } as unknown as RunEntity;

describe('implement chat', () => {
  let dir: string;
  let requests: AgentLaunchRequest[];
  let answer: Record<string, unknown>;
  let failure: Error | null;

  const door = {
    outside: async (_start: unknown, request: AgentLaunchRequest) => {
      requests.push(request);
      if (failure) throw failure;
      return { ...result(''), ...answer };
    },
  } as unknown as AgentDoor;

  function chat(): ImplementChat {
    const config = {
      env: {
        SWARMLOOP_ROOT: dir,
        AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
        AGENTS_IMPLEMENT: 'cursor:grok-4.7',
        AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
        AGENTS_SUBTASK_PLAN: '',
        AGENTS_SUBTASK_IMPLEMENT: '',
        AGENTS_SUBTASK_REVIEW: '',
        AGENTS_READ: '',
        READ_ROLES: '',
        EPIC_EFFORT: '',
        IMPLEMENT_TIMEOUT_MS: 1000,
      },
    } as unknown as AppConfig;
    return new ImplementChat(door, config);
  }

  function storeImplementChat(): void {
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(agentStateDir(dir, KEY, sessionHome('implement')), { recursive: true });
    const session = { chatId: 'chat-7', resumed: true, completed: true, killReason: null, runtime: 'cursor' };
    writeFileSync(join(dir, 'data', sessionFileName(KEY, 'implement')), JSON.stringify(session));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarmloop-implement-chat-'));
    mkdirSync(join(dir, 'worktrees', KEY, 'demo'), { recursive: true });
    requests = [];
    answer = { resultValue: { text: 'filled' } };
    failure = null;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('asks in the implement chat of the run when it has one, with no file edits', async () => {
    storeImplementChat();
    expect(await chat().ask(RUN, ['demo'], 'fill it', mergeRequestText)).toEqual({ value: { text: 'filled' } });
    expect(requests[0]).toMatchObject({ step: 'implement', tools: 'none', mode: 'plan', prompt: 'fill it' });
    expect(requests[0]?.result).toBe(mergeRequestText);
  });

  it('throws HostUnavailable when the model host did not answer', async () => {
    const down = new HostUnavailable('api.anthropic.com', 'API Error: 502', '2026-11-12T15:00:00.000Z');
    failure = down;
    await expect(chat().ask(RUN, ['demo'], 'fill it', mergeRequestText)).rejects.toBe(down);
  });

  it('starts a chat of the implement agent when the run has none', async () => {
    await chat().ask(RUN, ['demo'], 'fill it', mergeRequestText);
    expect(requests[0]).toMatchObject({ step: 'merge-request', runtime: 'cursor', model: 'grok-4.7', tools: 'none' });
  });

  it('gives the reason when the agent fails or gives no result', async () => {
    answer = { exitCode: 1, output: 'usage limit' };
    const failed = await chat().ask(RUN, ['demo'], 'fill it', mergeRequestText);
    expect(failed).toEqual({ error: expect.stringContaining('implement failed') });
    answer = {};
    expect(await chat().ask(RUN, ['demo'], 'fill it', mergeRequestText)).toEqual({
      error: 'the implement agent gave no merge_request_text',
    });
  });
});
