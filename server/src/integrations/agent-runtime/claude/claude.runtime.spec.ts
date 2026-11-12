import { ClaudeRuntime, claudeDisallowedTools } from './claude.runtime';

describe('ClaudeRuntime', () => {
  const runtime = new ClaudeRuntime();
  const mounts = [{ containerPath: '/work/demo' }];

  it('says whether its plan mode has a plan tool', () => {
    expect(runtime.planModeHasPlanTool).toBe(false);
  });

  it('opens the brief directory', () => {
    expect(runtime.briefArgs()).toEqual(['--add-dir', '/work/brief']);
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
      '--include-partial-messages',
      '--model',
      'grok-4.7',
      '--verbose',
      '--disallowedTools',
      'Monitor,ScheduleWakeup,CronCreate,CronDelete,CronList,RemoteTrigger',
      '--permission-mode',
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
      '--include-partial-messages',
      '--model',
      'grok-4.7',
      '--resume',
      'chat-1',
      '--verbose',
      '--disallowedTools',
      'Monitor,ScheduleWakeup,CronCreate,CronDelete,CronList,RemoteTrigger',
      '--dangerously-skip-permissions',
      'write the server',
    ]);
  });

  describe('tools', () => {
    const L00K = ['Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger'];
    const READ_ONLY = [
      'Edit',
      'Write',
      'NotebookEdit',
      'Task',
      'WebSearch',
      'WebFetch',
      'Workflow',
      'Skill',
      'SendMessage',
      'EnterWorktree',
      'ExitWorktree',
    ];
    const denied = (tools: 'read' | 'plan' | 'write') => {
      const args = runtime.printArgs({ model: 'm', prompt: 'p', mounts, resumeChatId: null, mode: 'ask', tools });
      return (args[args.indexOf('--disallowedTools') + 1] ?? '').split(',');
    };

    it('denies the writing tools and the l00k list to a read step', () => {
      expect(denied('read')).toEqual([...L00K, ...READ_ONLY]);
      expect(claudeDisallowedTools('read').split(',')).toEqual(denied('read'));
    });

    it('denies a plan step what a read step is denied, except Skill', () => {
      expect(denied('plan')).toEqual([...L00K, ...READ_ONLY.filter((tool) => tool !== 'Skill')]);
      expect(claudeDisallowedTools('plan').split(',')).toEqual(denied('plan'));
    });

    it('denies only the l00k list to a write step', () => {
      expect(denied('write')).toEqual(L00K);
    });
  });
});
