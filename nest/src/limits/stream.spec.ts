import { addGuessedLine, emptyUsageGuess, readStreamLine, takeAnswer, usageFromStream } from './stream';

describe('stream usage', () => {
  it('counts a later model round against the context so far', () => {
    const guess = emptyUsageGuess();
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'abcd' }] } }),
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'abcd' }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { readToolCall: { args: { path: 'abcd' } } },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: { readToolCall: { args: { path: 'abcd' }, result: { success: { content: 'abcdefgh' } } } },
      }),
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'abcd' }),
      JSON.stringify({
        type: 'result',
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
    ];
    for (const line of lines) {
      const piece = readStreamLine(line);
      if (piece) {
        addGuessedLine(guess, piece);
      }
    }
    expect(guess.tokensOut).toBe(6);
    expect(guess.tokensIn).toBe(16);
    expect(usageFromStream(lines.join('\n'))).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reportedUsd: null,
    });
  });

  it('keeps the finished assistant message and ignores the joined result', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'The checklist.' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'implementation:\n- skipped the duplicate\n\nsummary:\n- both screens print every launch\n' }] },
      }),
      JSON.stringify({
        type: 'result',
        result: 'The checklist.implementation:\n- skipped the duplicate\n\nsummary:\n- both screens print every launch\n',
      }),
    ];
    let text = '';
    let locked = false;
    for (const line of lines) {
      const piece = readStreamLine(line);
      if (!piece) {
        continue;
      }
      const next = takeAnswer(text, locked, piece);
      text = next.text;
      locked = next.locked;
    }
    const partial = readStreamLine(JSON.stringify({ type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: ' more' }] } }));
    if (partial) {
      const after = takeAnswer(text, locked, partial);
      text = after.text;
      locked = after.locked;
    }
    expect(text.startsWith('implementation:\n')).toBe(true);
    expect(text.endsWith('launch\n')).toBe(true);
    expect(locked).toBe(true);
  });
});
