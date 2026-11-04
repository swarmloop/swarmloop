import { parseCommand as parseAgentCommand } from './agent';
import { parseCommand } from './commands';

describe('ACP commands', () => {
  it('parses case-insensitive slash commands and leaves ordinary prompts alone', () => {
    expect(parseCommand('/STEP research open questions')).toEqual({ name: 'step', rest: 'research open questions' });
    expect(parseAgentCommand('/resume')).toEqual({ name: 'resume', rest: '' });
    expect(parseCommand('Ship the field')).toBeNull();
  });
});
