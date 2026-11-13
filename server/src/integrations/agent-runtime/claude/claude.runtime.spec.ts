import { ClaudeRuntime, claudeDisallowedTools } from './claude.runtime';

describe('ClaudeRuntime', () => {
  const runtime = new ClaudeRuntime();
  const mounts = [{ containerPath: '/work/demo' }];

  it('says whether its plan mode has a plan tool', () => {
    expect(runtime.planModeHasPlanTool).toBe(false);
  });

  it('loads CLAUDE.md by itself', () => {
    expect(runtime.ownRuleFiles()).toEqual(['CLAUDE.md']);
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

  describe('effort', () => {
    const base = { model: 'claude-opus-5-5', prompt: 'do it', mounts, resumeChatId: null, tools: 'write' as const };

    it('declares every level', () => {
      expect(runtime.efforts('claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('puts --effort before the prompt and clears the env override', () => {
      const args = runtime.printArgs(base);
      const launch = runtime.withEffort({ model: base.model, args, unsetEnv: [] }, 'high');
      expect(launch.args.slice(launch.args.indexOf('--model'), launch.args.indexOf('--model') + 4)).toEqual([
        '--model',
        'claude-opus-5-5',
        '--effort',
        'high',
      ]);
      expect(launch.args.at(-1)).toBe('do it');
      expect(launch.unsetEnv).toEqual(['CLAUDE_CODE_EFFORT_LEVEL']);
    });

    it('puts --effort in terminal args too', () => {
      const args = runtime.terminalArgs({ model: 'm', workspace: '/work', resumeChatId: null, vendor: [] });
      expect(runtime.withEffort({ model: 'm', args, unsetEnv: [] }, 'max').args.slice(0, 4)).toEqual([
        '--model',
        'm',
        '--effort',
        'max',
      ]);
    });

    it('launches without an effort exactly as before', () => {
      const args = runtime.printArgs(base);
      expect(args).not.toContain('--effort');
      expect(runtime.homeFiles().length).toBeGreaterThan(0);
    });
  });
});
