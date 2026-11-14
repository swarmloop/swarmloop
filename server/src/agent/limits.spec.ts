import type { DecisionWatch, LimitSnapshot } from './limits';
import {
  callsExceeded,
  hasModelDecision,
  judgeLimits,
  noteDecision,
  overSpend,
  priceTokens,
  retryCrash,
  shouldResume,
  turnUsd,
} from './limits';
import { withRetries } from '../integrations/http';
import { readStreamLine } from './stream';
import { reviewDefinition } from '../agent-result/definitions/review';
import { readResult } from '../agent-result/read-result';
import { resultAnswer } from '../testing/result-answer';

const quality = reviewDefinition('quality');
const accepted = (text: string): boolean => readResult(quality, text).ok;
const BLOCK = resultAnswer('notes', { decision: 'return', review: 'notes', summary: ['notes'] });

function watched(output: string, answered: ((text: string) => boolean) | undefined = accepted): boolean {
  let state: DecisionWatch = { text: '', locked: false };
  for (const line of output.split(/\r?\n/)) {
    state = noteDecision(state, readStreamLine(line));
  }
  return hasModelDecision(state, answered);
}

function snapshot(patch: Partial<LimitSnapshot> = {}): LimitSnapshot {
  return {
    elapsedMs: 0,
    idleMs: 0,
    timeLimitMs: 1000,
    idleLimitMs: 300,
    spentUsd: 0,
    stepUsd: 0,
    maxRunUsd: 25,
    stepUsdMax: null,
    tokensInRun: 0,
    stepTokens: 0,
    maxRunTokens: null,
    stepTokenMax: null,
    warned: false,
    ...patch,
  };
}

describe('limits', () => {
  it('warns once at 80% of the time limit and kills at the limit', () => {
    expect(judgeLimits(snapshot({ elapsedMs: 800 })).warn).toBe(true);
    expect(judgeLimits(snapshot({ elapsedMs: 800, warned: true })).warn).toBe(false);
    expect(judgeLimits(snapshot({ elapsedMs: 1000 })).kill).toBe('time');
  });

  it('kills on idle and tokens, and lets a step finish past the spend limit', () => {
    expect(judgeLimits(snapshot({ idleMs: 300 })).kill).toBe('idle');
    expect(judgeLimits(snapshot({ stepUsd: 25 })).kill).toBeNull();
    expect(judgeLimits(snapshot({ spentUsd: 25, stepUsd: 10 })).kill).toBeNull();
    expect(judgeLimits(snapshot({ stepUsd: 25, elapsedMs: 1000 })).kill).toBe('time');
    expect(judgeLimits(snapshot({ stepTokens: 5, maxRunTokens: 5 })).kill).toBe('tokens');
    expect(overSpend(25, 25)).toBe(true);
    expect(overSpend(24.99, 25)).toBe(false);
    expect(overSpend(100, 0)).toBe(false);
  });

  it('retries a non-empty crash until the launch cap and leaves a valid result block down', () => {
    const prompt = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: BLOCK }] } }),
      'Error: [unavailable] Error',
    ].join('\n');
    const under = {
      exitCode: 1,
      killReason: null,
      halted: false,
      callsSoFar: 3,
      maxCalls: 20,
      attempts: 1,
      maxLaunches: 3,
      decided: watched(prompt),
    };
    const answer = (text: string) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    expect(retryCrash(under)).toBe(true);
    expect(retryCrash({ ...under, decided: watched('Error: [unavailable] Error\n') })).toBe(true);
    expect(retryCrash({ ...under, decided: watched('') })).toBe(true);
    expect(retryCrash({ ...under, attempts: 2 })).toBe(true);
    expect(retryCrash({ ...under, attempts: 3 })).toBe(false);
    expect(retryCrash({ ...under, exitCode: 0 })).toBe(false);
    expect(retryCrash({ ...under, killReason: 'time' })).toBe(false);
    expect(retryCrash({ ...under, killReason: 'idle' })).toBe(false);
    expect(retryCrash({ ...under, halted: true })).toBe(false);
    expect(retryCrash({ ...under, callsSoFar: 20 })).toBe(false);
    expect(retryCrash({ ...under, decided: watched(`${prompt}\n${answer(BLOCK)}\n`) })).toBe(false);
    expect(callsExceeded(20, 20)).toBe(true);
  });

  it('counts only a result block the step accepts', () => {
    const answer = (text: string) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    expect(watched(`${answer('notes\ndecision: return\n')}\n`)).toBe(false);
    expect(watched(`${answer(resultAnswer('notes', { decision: 'maybe', review: 'x', summary: [] }))}\n`)).toBe(false);
    expect(watched(`${answer(BLOCK)}\n`)).toBe(true);
    expect(hasModelDecision({ text: BLOCK, locked: true }, undefined)).toBe(false);
  });

  it('counts tokens when the model has no price', () => {
    expect(priceTokens('composer-2.5', 10, 4, {})).toBeNull();
    expect(callsExceeded(20, 20)).toBe(true);
    expect(callsExceeded(19, 20)).toBe(false);
  });

  it('resumes once only after a crash with an empty file and a chat id', () => {
    const crash = { chatId: 'chat-1', resumed: false, completed: false, killReason: null };
    expect(shouldResume(crash, true)).toBe(true);
    expect(shouldResume({ ...crash, killReason: 'time' }, true)).toBe(false);
    expect(shouldResume({ ...crash, completed: true }, true)).toBe(false);
    expect(shouldResume({ ...crash, resumed: true }, true)).toBe(false);
    expect(shouldResume(crash, false)).toBe(false);
    expect(shouldResume({ ...crash, chatId: null }, true)).toBe(false);
  });

  it('retries a failed read twice', async () => {
    let attempts = 0;
    const value = await withRetries(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('down');
        }
        return 'ok';
      },
      () => true,
      2,
      async () => undefined,
    );
    expect(value).toBe('ok');
    expect(attempts).toBe(3);
  });
});

describe('turnUsd', () => {
  it('charges a fresh turn in full', () => {
    expect(turnUsd(1.25, 0.4, 0, false)).toBe(1.25);
    expect(turnUsd(null, 0.4, 3, true)).toBe(0.4);
  });

  it('subtracts the chat total already recorded when the CLI reports the whole chat', () => {
    expect(turnUsd(4, 9, 3, true)).toBe(1);
  });

  it('keeps a smaller number as this turn alone', () => {
    expect(turnUsd(1, 9, 3, true)).toBe(1);
  });
});
