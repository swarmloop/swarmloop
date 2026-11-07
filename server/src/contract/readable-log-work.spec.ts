import { AgentWorkFeed, type AgentWork } from './readable-log';

function lines(...records: object[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function run(stream: string, chunk = 40): AgentWork[] {
  let tick = 0;
  const feed = new AgentWorkFeed(['/work/demo'], () => (tick += 10));
  const work: AgentWork[] = [];
  for (let index = 0; index < stream.length; index += chunk) {
    work.push(...feed.push(stream.slice(index, index + chunk)));
  }
  return [...work, ...feed.finish()];
}

describe('AgentWorkFeed', () => {
  it('turns a Claude stream into its text and its tool calls, in order', () => {
    const stream = lines(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading the file first.' },
            { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/work/demo/src/app.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'const app = 1;\nmore' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Exit code 2\nboom', is_error: true }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The tests fail.' }] } },
    );
    expect(run(stream)).toEqual([
      { kind: 'message', text: 'Reading the file first.' },
      { kind: 'tool', tool: 'read', target: 'src/app.ts', status: 'ok', durationMs: 10, resultLine: 'const app = 1;' },
      { kind: 'tool', tool: 'shell', target: 'npm test', status: 'failed', durationMs: 10, resultLine: 'exit 2' },
      { kind: 'message', text: 'The tests fail.' },
    ]);
  });

  it('turns a Codex stream into its commands, its file changes and its messages', () => {
    const stream = lines(
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
      {
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a\nb\n', exit_code: 0 },
      },
      {
        type: 'item.completed',
        item: { id: 'c2', type: 'file_change', changes: [{ path: '/work/demo/x.ts', kind: 'update' }] },
      },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Done.' } },
    );
    expect(run(stream)).toEqual([
      { kind: 'tool', tool: 'shell', target: 'ls', status: 'ok', durationMs: 10, resultLine: 'exit 0' },
      { kind: 'tool', tool: 'edit', target: 'x.ts', status: 'ok', durationMs: 0, resultLine: '' },
      { kind: 'message', text: 'Done.' },
    ]);
  });

  it('turns a Cursor stream into its tool calls with the pattern of a search', () => {
    const stream = lines(
      {
        type: 'tool_call',
        subtype: 'started',
        tool_call: { grepToolCall: { args: { pattern: 'TODO', path: 'src' } } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        tool_call: { grepToolCall: { args: { pattern: 'TODO', path: 'src' }, result: { success: { totalFiles: 3 } } } },
      },
      { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'git status' } } } },
      {
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          shellToolCall: { args: { command: 'git status' }, result: { success: { stdout: 'clean', exitCode: 0 } } },
        },
      },
    );
    expect(run(stream)).toEqual([
      { kind: 'tool', tool: 'grep', target: 'TODO src', status: 'ok', durationMs: 10, resultLine: '3 files' },
      { kind: 'tool', tool: 'shell', target: 'git status', status: 'ok', durationMs: 10, resultLine: 'exit 0' },
    ]);
  });

  it('records only messages for a runtime whose stream names no tools', () => {
    const stream = lines({ type: 'assistant', message: { content: 'I changed the config.' } });
    expect(run(stream)).toEqual([{ kind: 'message', text: 'I changed the config.' }]);
  });

  it('hands out a tool that never finished as unfinished', () => {
    const stream = lines({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sleep 99' } }] },
    });
    expect(run(stream)).toMatchObject([{ kind: 'tool', status: 'unfinished', target: 'sleep 99' }]);
  });
});
