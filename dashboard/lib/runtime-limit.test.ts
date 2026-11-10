import { describe, expect, it } from 'vitest';
import { localTime } from './format';
import { limitSentence } from './runtime-limit';

const RESETS_AT = '2026-11-08T21:50:00.000Z';
const RESUMES_AT = '2026-11-08T21:51:00.000Z';

describe('limitSentence', () => {
  it('names the runtime, the reset in the viewer’s time and the agent that took over', () => {
    expect(limitSentence({ runtime: 'claude', resetsAt: RESETS_AT, continuedWith: 'codex:gpt-6.1-sol' })).toBe(
      `Claude hit its usage limit (resets ${localTime(RESETS_AT)}). Continued with codex:gpt-6.1-sol.`,
    );
  });

  it('says when a waiting run goes on', () => {
    expect(limitSentence({ runtime: 'codex', resetsAt: RESETS_AT, resumesAt: RESUMES_AT })).toBe(
      `Codex hit its usage limit (resets ${localTime(RESETS_AT)}). The run goes on at ${localTime(RESUMES_AT)}.`,
    );
  });

  it('leaves the reset out when the provider gave none', () => {
    expect(limitSentence({ runtime: 'cursor', resumesAt: RESUMES_AT })).toBe(
      `Cursor hit its usage limit. The run goes on at ${localTime(RESUMES_AT)}.`,
    );
  });
});
