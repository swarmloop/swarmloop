import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunResult } from './agent-result';
import { chatMissingAnswer, relaunchPlan, resumableChat } from './agent-session';

const budget = { halted: false, callsSoFar: 1, maxCalls: 50, attempts: 1, maxLaunches: 3 };

function crashed(output: string, resumed: boolean): AgentRunResult {
  return {
    responseText: '',
    chatId: 'c1',
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    killReason: null,
    exitCode: 1,
    output,
    resumed,
    calls: 1,
    samples: [],
    durationMs: 1,
    startedAt: '',
    finishedAt: '',
  };
}

describe('chats whose state was removed', () => {
  it('resumes a stored chat only while the agent state of its step exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chat-'));
    mkdirSync(join(root, 'data'));
    writeFileSync(
      join(root, 'data', 'PROJ-1-implement-session.json'),
      '{"chatId":"c1","resumed":false,"completed":true,"killReason":null,"runtime":"cursor"}\n',
    );

    expect(await resumableChat(root, 'PROJ-1', 'implement-improve', 'cursor')).toBeNull();
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-1', 'implement'), { recursive: true });
    expect((await resumableChat(root, 'PROJ-1', 'implement-improve', 'cursor'))?.chatId).toBe('c1');
  });

  it('does not retry a crash on a chat id the CLI says does not exist', () => {
    const attempt = crashed('Error: chat c1 not found', true);

    expect(chatMissingAnswer(attempt)).toBe(true);
    expect(relaunchPlan({ attempt, chatId: 'c1', continuePrompt: null, endedEarlyUsed: false, budget })).toBeNull();
  });

  it('still retries an ordinary crash of a resumed chat', () => {
    const attempt = crashed('segfault', true);

    expect(relaunchPlan({ attempt, chatId: 'c1', continuePrompt: null, endedEarlyUsed: false, budget })).toMatchObject({
      chatId: 'c1',
      resumed: true,
    });
  });
});
