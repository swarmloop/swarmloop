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
      JSON.stringify({
        type: 'assistant',
        timestamp_ms: 1,
        message: { content: [{ type: 'text', text: 'The checklist.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'implementation:\n- skipped the duplicate\n\nsummary:\n- both screens print every launch\n',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        result:
          'The checklist.implementation:\n- skipped the duplicate\n\nsummary:\n- both screens print every launch\n',
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
    const partial = readStreamLine(
      JSON.stringify({ type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: ' more' }] } }),
    );
    if (partial) {
      const after = takeAnswer(text, locked, partial);
      text = after.text;
      locked = after.locked;
    }
    expect(text.startsWith('implementation:\n')).toBe(true);
    expect(text.endsWith('launch\n')).toBe(true);
    expect(locked).toBe(true);
  });

  it('reads a codex thread, its message, its usage, and a failure', () => {
    expect(readStreamLine(JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }))?.chatId).toBe('th-1');
    const message = readStreamLine(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    );
    expect(message?.text).toBe('done');
    expect(message?.finalMessage).toBe(false);
    expect(message?.replaceText).toBe(true);
    let answer = '';
    let locked = false;
    for (const body of ['first', 'second']) {
      const piece = readStreamLine(
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: body } }),
      );
      if (!piece) {
        continue;
      }
      const next = takeAnswer(answer, locked, piece);
      answer = next.text;
      locked = next.locked;
    }
    expect(answer).toBe('second');
    expect(locked).toBe(false);
    expect(
      readStreamLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }))
        ?.finalMessage,
    ).toBe(false);
    const turn = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
    });
    expect(readStreamLine(turn)).toMatchObject({
      result: true,
      stops: false,
      addUsage: true,
      tokensIn: 60,
      tokensOut: 10,
      cacheRead: 40,
      reportedUsd: null,
    });
    const second = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 5 },
    });
    expect(usageFromStream(`${turn}\n${second}`)).toEqual({
      input: 80,
      output: 15,
      cacheRead: 40,
      cacheWrite: 0,
      reportedUsd: null,
    });
    expect(readStreamLine(JSON.stringify({ type: 'result', result: 'ok' }))).toMatchObject({
      stops: true,
      addUsage: false,
    });
    expect(readStreamLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }))?.text).toBe('boom');
    expect(readStreamLine(JSON.stringify({ type: 'error', message: 'nope' }))?.text).toBe('nope');
  });
});
