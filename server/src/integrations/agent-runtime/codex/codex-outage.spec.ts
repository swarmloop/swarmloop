import { CodexRuntime } from './codex.runtime';

const runtime = new CodexRuntime();
const classify = (finalLine: string, stderr = '') => runtime.classifyOutage({ finalLine, stderr, now: 0 });
const failed = (message: string): string => JSON.stringify({ type: 'turn.failed', error: { message } });
const NETWORK =
  'stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)';

describe('Codex outage texts', () => {
  it('reads a final turn.failed whose stream disconnected: the host and the text', () => {
    expect(classify(failed(NETWORK))).toEqual({ host: 'api.openai.com', detail: NETWORK });
  });

  it('reads an error event that could not send its request', () => {
    const line = JSON.stringify({ type: 'error', message: 'Reconnecting... error sending request for url (x)' });
    expect(classify(line)?.detail).toBe('Reconnecting... error sending request for url (x)');
  });

  it('is no outage for an answer, an answer without a result block, or an outage text in stderr of an answer', () => {
    const answer = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } });
    expect(classify(answer)).toBeNull();
    expect(classify(JSON.stringify({ type: 'result', is_error: false, result: NETWORK }))).toBeNull();
    expect(classify(answer, NETWORK)).toBeNull();
  });

  it('is no outage for the usage limit', () => {
    expect(classify(failed("You've hit your usage limit. Try again in 3 days."))).toBeNull();
  });
});
