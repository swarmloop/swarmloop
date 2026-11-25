import { CursorRuntime } from './cursor.runtime';

const runtime = new CursorRuntime();
const classify = (finalLine: string, stderr = '') => runtime.classifyOutage({ finalLine, stderr, now: 0 });
const TEXT = 'ConnectError: [unavailable] fetch failed';

describe('Cursor outage texts', () => {
  it('reads the unavailable error of an error result', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: TEXT });
    expect(classify(line)).toEqual({ host: 'api2.cursor.sh', detail: TEXT });
  });

  it('reads the unavailable error of stderr', () => {
    expect(classify('', `${TEXT}\n`)).toEqual({ host: 'api2.cursor.sh', detail: TEXT });
  });

  it('is no outage for an answer, an answer without a result block, or an outage text in stderr of an answer', () => {
    const answer = JSON.stringify({ type: 'result', is_error: false, result: 'Done.' });
    expect(classify(answer)).toBeNull();
    expect(classify(JSON.stringify({ type: 'result', result: 'I wrote the plan.' }))).toBeNull();
    expect(classify(answer, TEXT)).toBeNull();
  });

  it('is no outage for the usage limit or the Claude-shaped API error line', () => {
    const limit = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your usage limit" });
    expect(classify(limit)).toBeNull();
    const apiError = JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'api_error' });
    expect(classify(apiError)).toBeNull();
  });
});
