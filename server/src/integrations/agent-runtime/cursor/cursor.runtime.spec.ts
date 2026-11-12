import { CursorRuntime } from './cursor.runtime';

describe('CursorRuntime', () => {
  const runtime = new CursorRuntime();
  const mounts = [{ containerPath: '/work/demo' }];

  it('loads AGENTS.md and CLAUDE.md by itself', () => {
    expect(runtime.ownRuleFiles()).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('prints plan mode and agent mode with resume and mcp approval', () => {
    expect(
      runtime.printArgs({
        model: 'grok-4.7',
        prompt: 'read the worktrees',
        mounts,
        resumeChatId: null,
        mode: 'plan',
        tools: 'write',
      }),
    ).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--model',
      'grok-4.7',
      '--trust',
      '--workspace',
      '/work/demo',
      '--mode',
      'plan',
      'read the worktrees',
    ]);
    expect(
      runtime.printArgs({
        model: 'grok-4.7',
        prompt: 'write the server',
        mounts,
        resumeChatId: 'chat-1',
        mode: 'agent',
        tools: 'write',
        approveMcps: true,
      }),
    ).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--model',
      'grok-4.7',
      '--trust',
      '--workspace',
      '/work/demo',
      '--resume',
      'chat-1',
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      'write the server',
    ]);
  });
});
