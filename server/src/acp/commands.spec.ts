import { parseCommand, promptText } from './commands';

describe('ACP commands', () => {
  it('parses slash commands without changing their prompt text', () => {
    expect(parseCommand('/review ./checkout check the branch')).toEqual({
      name: 'review',
      rest: './checkout check the branch',
    });
    expect(parseCommand('/REPLAY  Ship it  ')).toEqual({ name: 'replay', rest: 'Ship it' });
    expect(parseCommand('Ship it')).toBeNull();
  });

  it('joins text and embedded prompt blocks', () => {
    expect(promptText([{ type: 'text', text: 'first' }, { content: { text: 'second' } }])).toBe('first\nsecond');
    expect(promptText([{ type: 'image' }])).toBe('');
  });
});
