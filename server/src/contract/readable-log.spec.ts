import { AgentWorkFeed, logFinished, usageFromLog } from './readable-log';
import { reviewChipStatus } from './readable-log-review';

describe('readableLog', () => {
  it('counts cache tokens as input', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 4 },
    });
    expect(usageFromLog(raw)).toStrictEqual({ tokensIn: 114, tokensOut: 2 });
  });

  it('treats a result or exit line as finished', () => {
    expect(logFinished(`${JSON.stringify({ type: 'thinking', text: 'look' })}\n`)).toBe(false);
    expect(logFinished(`${JSON.stringify({ type: 'result', usage: {} })}\n`)).toBe(true);
    expect(logFinished('process exited 0\n')).toBe(true);
    expect(logFinished('process killed: idle\n')).toBe(true);
    expect(logFinished('thinking\nprocess killed: time\nthinking\n')).toBe(false);
    expect(logFinished('process killed: time\nprocess started\n')).toBe(false);
    const quoted =
      '{"type":"tool_call","snippet":"reviewChipStatus(\'decision: return\\\\nprocess exited 0\\\\n\')"}\n';
    expect(logFinished(quoted)).toBe(false);
    expect(reviewChipStatus(quoted)).toBe(null);
    const block = (decision: string): string =>
      `notes\n\n\`\`\`json\n${JSON.stringify({ decision, review: 'notes', summary: [] })}\n\`\`\`\n`;
    const answered = (decision: string): string => `${JSON.stringify({ type: 'result', result: block(decision) })}\n`;
    expect(reviewChipStatus(answered('return'))).toBe('returned');
    expect(reviewChipStatus(answered('ok'))).toBe('done');
    expect(reviewChipStatus(answered('maybe'))).toBe('failed');
    // A decision line in prose is not a decision.
    expect(reviewChipStatus(`${JSON.stringify({ type: 'result', result: 'notes\ndecision: return\n' })}\n`)).toBe(
      'failed',
    );
    // The prompt is not an answer, even when it holds an example block.
    const prompt = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: block('ok') }] } });
    expect(reviewChipStatus(`${prompt}\nprocess exited 1\n`)).toBe('failed');
    expect(reviewChipStatus(`${prompt}\n${answered('return')}`)).toBe('returned');
  });
});

describe('AgentWorkFeed', () => {
  const started = (command: string) =>
    `${JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command } } } })}\n`;
  const completed = `${JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    tool_call: { shellToolCall: { result: { success: {} } } },
  })}\n`;

  it('settles the tools of a later launch as they arrive after a tool of an earlier launch was left open', () => {
    const feed = new AgentWorkFeed(['/work'], () => 0);
    feed.push(started('sleep 100'));
    expect(feed.finish()).toMatchObject([{ kind: 'tool', target: 'sleep 100', status: 'unfinished' }]);
    expect(feed.push(started('npm test'))).toEqual([]);
    expect(feed.push(completed)).toMatchObject([{ kind: 'tool', target: 'npm test', status: 'ok' }]);
  });
});
