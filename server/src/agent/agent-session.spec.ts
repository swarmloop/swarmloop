import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunResult } from './agent-result';
import { chatMissingAnswer, loopHint, relaunchPlan, resumableChat } from './agent-session';
import { RESULT_AS_BEFORE } from '../agent-result/result-prompt';

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

describe('relaunch after a loop kill', () => {
  const looped = { ...crashed('', true), killReason: 'loop' as const };
  const base = { attempt: looped, chatId: 'c1', continuePrompt: null, endedEarlyUsed: false, budget };

  it('goes on in the same chat with the hint', () => {
    const prompt = loopHint('npm test', 'Cannot find module x');

    expect(prompt).toContain('npm test');
    expect(prompt).toContain('Cannot find module x');
    expect(prompt).toContain('Try a different approach or explain why it cannot pass');
    expect(relaunchPlan({ ...base, loopPrompt: prompt })).toEqual({ chatId: 'c1', resumed: true, prompt });
  });

  it('does not relaunch when the loop ends the step, or when the budget is used', () => {
    expect(relaunchPlan({ ...base, loopPrompt: null })).toBeNull();
    expect(relaunchPlan({ ...base, loopPrompt: 'hint', budget: { ...budget, attempts: 3 } })).toBeNull();
  });
});

describe('result endings of runner continuations', () => {
  it.each(['time', 'idle', null] as const)('uses the supplied result ending after a %s stop', (killReason) => {
    const attempt = {
      ...crashed('', true),
      exitCode: killReason === null ? 0 : 1,
      killReason,
      backgroundKilled: killReason === null,
    };
    const next = relaunchPlan({
      attempt,
      chatId: 'c1',
      continuePrompt: undefined,
      endedEarlyUsed: false,
      budget,
      ending: RESULT_AS_BEFORE,
    });
    expect(next?.prompt?.endsWith(RESULT_AS_BEFORE)).toBe(true);
    expect(next?.prompt).not.toContain('sections');
  });

  it('ends a loop hint with the same result reminder', () => {
    expect(loopHint('npm test', 'error', RESULT_AS_BEFORE).endsWith(RESULT_AS_BEFORE)).toBe(true);
  });
});
