import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { logFinished, readableLog, reviewChipStatus, usageFromLog } from './readable-log.ts';

describe('readableLog', () => {
  it('separates each message and keeps the type with an indent', () => {
    const raw = [
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'Look at the tree.' }),
      JSON.stringify({ type: 'thinking', subtype: 'completed' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will ' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'read it.' }] } }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { globToolCall: { args: { targetDirectory: '/work', globPattern: '**/*' } } },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: { globToolCall: { result: { success: { totalFiles: 0 } } } },
      }),
      JSON.stringify({ type: 'connection', subtype: 'reconnecting', attempt: 1, endpoint_url: 'https://example.test' }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { shellToolCall: { args: { command: 'ls /work' } } },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: { shellToolCall: { result: { rejected: true } } },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'I will read it.The same sentence again with no break.\n\nplan:\n- add the server\n',
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
      'process exited 0',
    ].join('\n');

    assert.equal(
      readableLog(raw),
      [
        'thinking',
        '    Look at the tree.',
        '',
        'assistant',
        '    I will read it.',
        '',
        'glob',
        '    /work **/*',
        '    0 files',
        '',
        'connection',
        '    reconnecting, attempt 1',
        '',
        'shell',
        '    ls /work',
        '    rejected',
        '',
        'result',
        '    plan:',
        '    - add the server',
        '',
        'status',
        '    process exited 0',
      ].join('\n'),
    );
    assert.equal(readableLog(raw).includes('example.test'), false);
    assert.deepEqual(usageFromLog(raw), { tokensIn: 10, tokensOut: 2 });
  });

  it('counts cache tokens as input', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 4 },
    });
    assert.deepEqual(usageFromLog(raw), { tokensIn: 114, tokensOut: 2 });
  });

  it('treats a result or exit line as finished', () => {
    assert.equal(logFinished(`${JSON.stringify({ type: 'thinking', text: 'look' })}\n`), false);
    assert.equal(logFinished(`${JSON.stringify({ type: 'result', usage: {} })}\n`), true);
    assert.equal(logFinished('process exited 0\n'), true);
    assert.equal(logFinished('process killed: idle\n'), true);
    assert.equal(logFinished('thinking\nprocess killed: time\nthinking\n'), false);
    assert.equal(logFinished('process killed: time\nprocess started\n'), false);
    const quoted = '{"type":"tool_call","snippet":"reviewChipStatus(\'decision: return\\\\nprocess exited 0\\\\n\')"}\n';
    assert.equal(logFinished(quoted), false);
    assert.equal(reviewChipStatus(quoted), null);
    assert.equal(reviewChipStatus('decision: return\nprocess exited 0\n'), 'waiting');
    assert.equal(reviewChipStatus('decision: ok\nprocess exited 0\n'), 'done');
    const prompt = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: '```\ndecision: ok\n```\nEnd with `decision: return` when it breaks.\n' }] },
    });
    assert.equal(reviewChipStatus(`${prompt}\nprocess exited 1\n`), 'failed');
    const answered = `${prompt}\n${JSON.stringify({ type: 'result', result: 'notes\ndecision: return\n' })}\n`;
    assert.equal(reviewChipStatus(answered), 'waiting');
  });
});
