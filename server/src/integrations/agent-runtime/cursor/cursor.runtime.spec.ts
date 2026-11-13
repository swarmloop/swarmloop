import { CursorRuntime } from './cursor.runtime';

describe('CursorRuntime', () => {
  const runtime = new CursorRuntime();
  const mounts = [{ containerPath: '/work/demo' }];

  it('says whether its plan mode has a plan tool', () => {
    expect(runtime.planModeHasPlanTool).toBe(true);
  });

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

  describe('effort', () => {
    const args = ['--print', '--model', 'grok-4.7', '--trust', 'go'];
    const withList = new CursorRuntime();
    withList.setModelIds(['grok-4.7', 'grok-4.7-high', 'grok-4.7-xhigh']);

    it('swaps the model id for the one with the level', () => {
      const launch = withList.withEffort({ model: 'grok-4.7', args, unsetEnv: [] }, 'high');
      expect(launch.model).toBe('grok-4.7-high');
      expect(launch.args).toEqual(['--print', '--model', 'grok-4.7-high', '--trust', 'go']);
    });

    it('leaves an old id that names its effort unchanged', () => {
      const old = { model: 'grok-4.7-high', args: ['--model', 'grok-4.7-high'], unsetEnv: [] };
      expect(withList.efforts('grok-4.7-high')).toEqual([]);
      expect(withList.withEffort(old, 'low')).toBe(old);
    });

    it('has no levels until a list is set', () => {
      expect(runtime.efforts('grok-4.7')).toEqual([]);
      expect(withList.efforts('grok-4.7')).toEqual(['high', 'xhigh']);
    });
  });
});
