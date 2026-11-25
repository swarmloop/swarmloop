import { ClaudeRuntime } from './claude.runtime';

const runtime = new ClaudeRuntime();
const classify = (finalLine: string, stderr = '') => runtime.classifyOutage({ finalLine, stderr, now: 0 });
const apiError = (result?: string): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    ...(result === undefined ? {} : { result }),
  });

describe('Claude outage texts', () => {
  it('reads the API error after the retries: the host and the first line of its text', () => {
    expect(
      classify(apiError('API Error: 502 swarmloop egress: getaddrinfo ENOTFOUND api.anthropic.com\nmore')),
    ).toEqual({
      host: 'api.anthropic.com',
      detail: 'API Error: 502 swarmloop egress: getaddrinfo ENOTFOUND api.anthropic.com',
    });
  });

  it('says API error when the result has no text', () => {
    expect(classify(apiError())).toEqual({ host: 'api.anthropic.com', detail: 'API error' });
  });

  it('is no outage for an answer, an answer without a result block, or an outage text in stderr of an answer', () => {
    const answer = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' });
    expect(classify(answer)).toBeNull();
    expect(classify(JSON.stringify({ type: 'result', result: 'I wrote the plan.' }))).toBeNull();
    expect(classify(answer, 'API Error: 502 ENOTFOUND api.anthropic.com')).toBeNull();
  });

  it('is no outage for the usage limit, an auth error or a full context', () => {
    for (const text of [
      "You've hit your 5-hour limit · resets 9:50pm (UTC)",
      'Invalid API key',
      'Prompt is too long',
    ]) {
      const line = JSON.stringify({ type: 'result', is_error: true, result: text });
      expect(classify(line)).toBeNull();
    }
  });
});
