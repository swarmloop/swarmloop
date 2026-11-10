import { CodexRuntime } from './codex.runtime';

const NOW = Date.parse('2026-11-08T18:42:00Z');
const runtime = new CodexRuntime();
const failed = (message: string): string => JSON.stringify({ type: 'turn.failed', error: { message } });
const classify = (finalLine: string, stderr = '') => runtime.classifyLimit({ finalLine, stderr, now: NOW });

describe('Codex limit texts', () => {
  it('reads a usage limit with a clock time', () => {
    expect(
      classify(
        failed(
          "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:50 PM.",
        ),
      ),
    ).toEqual({ window: 'usage', resetsAt: '2026-11-08T21:50:00.000Z' });
  });

  it('reads the wordings of the codex 0.167.0 binary: per model, admin request and credits', () => {
    expect(
      classify(
        failed("You've hit your usage limit for gpt-6.1-sol. Switch to another model now, or try again at 9:50 PM."),
      ),
    ).toEqual({ window: 'usage', resetsAt: '2026-11-08T21:50:00.000Z' });
    expect(
      classify(
        failed(
          "You've hit your usage limit. To get more access now, send a request to your admin or try again at 9:50 PM.",
        ),
      ),
    ).toEqual({ window: 'usage', resetsAt: '2026-11-08T21:50:00.000Z' });
    expect(
      classify(
        failed(
          "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 9:50 PM.",
        ),
      ),
    ).toEqual({ window: 'usage', resetsAt: '2026-11-08T21:50:00.000Z' });
    expect(
      classify(
        failed(
          "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits",
        ),
      ),
    ).toEqual({ window: 'usage' });
  });

  it('reads a usage limit with a date', () => {
    expect(classify(failed("You've hit your usage limit. Try again at Nov 14th, 2026 9:50 AM."))?.resetsAt).toBe(
      '2026-11-14T09:50:00.000Z',
    );
  });

  it('reads a usage limit with a length of time', () => {
    expect(classify(failed("You've hit your usage limit. Try again in 3 days 5 hours 2 minutes."))).toEqual({
      window: 'usage',
      resetsAt: '2026-11-11T23:44:00.000Z',
    });
  });

  it('reads a usage limit with no time from stderr', () => {
    expect(classify('', "You've hit your usage limit.\n")).toEqual({ window: 'usage' });
  });

  it('reads a rate limit and a quota text', () => {
    expect(classify(failed('Rate limit reached for gpt-6.1 on tokens per min. Please try again in 90s.'))).toEqual({
      window: 'rate',
      resetsAt: '2026-11-08T18:43:30.000Z',
    });
    expect(classify(failed('You exceeded your current quota, please check your plan and billing details.'))).toEqual({
      window: 'quota',
    });
  });

  it.each([
    [
      'an auth error',
      'Incorrect API key provided: sk-proj-***. You can find your API key at https://platform.openai.com.',
    ],
    ['an expired login', 'Your access token could not be refreshed. Please log out and sign in again.'],
    ['a billing error', 'Your credit balance is too low to run this request.'],
    ['a network error', 'stream disconnected before completion: error sending request for url'],
    ['a full context', 'Your input exceeds the context window of this model.'],
  ])('does not take %s for a limit', (_name, text) => {
    expect(classify(failed(text), text)).toBeNull();
  });
});
