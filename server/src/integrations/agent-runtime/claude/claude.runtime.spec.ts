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
    expect(runtime.readDirArgs('/work/logs')).toEqual(['--add-dir', '/work/logs']);
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

  describe('prompt cache', () => {
    it('knows the 1-hour cache prices of Opus 5.5, Sonnet 5.5 and Haiku 5.5', () => {
      const opus = runtime.promptCache('claude-opus-5-5');
      expect(opus).toEqual({ ttlMinutes: 60, cacheReadPerMillion: 0.2, cacheWritePerMillion: 8 });
      expect(opus!.cacheWritePerMillion / opus!.cacheReadPerMillion).toBe(40);
      const sonnet = runtime.promptCache('claude-sonnet-5-5');
      expect(sonnet).toEqual({ ttlMinutes: 60, cacheReadPerMillion: 0.1, cacheWritePerMillion: 4 });
      expect(sonnet!.cacheWritePerMillion / sonnet!.cacheReadPerMillion).toBe(40);
      expect(runtime.promptCache('claude-haiku-5-5')).toEqual({
        ttlMinutes: 60,
        cacheReadPerMillion: 0.01,
        cacheWritePerMillion: 0.2,
      });
    });

    it('gives null for an unknown model', () => {
      expect(runtime.promptCache('claude-unknown')).toBeNull();
      expect(runtime.promptCache('constructor')).toBeNull();
      expect(runtime.promptCache('__proto__')).toBeNull();
    });
  });

  describe('context window', () => {
    it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])('knows the %s window', (model) => {
      expect(runtime.contextTokens(model)).toBe(1_000_000);
    });

    it('gives null for an unknown model', () => {
      expect(runtime.contextTokens('claude-unknown')).toBeNull();
    });
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
    const denied = (tools: 'none' | 'read' | 'plan' | 'write') => {
      const args = runtime.printArgs({ model: 'm', prompt: 'p', mounts, resumeChatId: null, mode: 'ask', tools });
      return (args[args.indexOf('--disallowedTools') + 1] ?? '').split(',');
    };

    describe('with a helper', () => {
      const launch = (tools: 'read' | 'plan', helper?: { model: string; effort?: 'low'; prompt: string }) =>
        runtime.printArgs({ model: 'm', prompt: 'p', mounts, resumeChatId: null, mode: 'plan', tools, helper });
      const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? '';

      it('lets the subagent tool through, runs the helper on its model and level with read tools', () => {
        const args = launch('plan', { model: 'h-model', effort: 'low', prompt: 'read it' });
        const deniedTools = flag(args, '--disallowedTools').split(',');
        expect(runtime.hasHelpers).toBe(true);
        expect(deniedTools).not.toContain('Task');
        expect(deniedTools).not.toContain('Agent');
        for (const tool of READ_ONLY.filter((name) => name !== 'Task' && name !== 'Skill')) {
          expect(deniedTools).toContain(tool);
        }
        expect(deniedTools).toContain('Agent(general-purpose)');
        expect(JSON.parse(flag(args, '--agents'))).toEqual({
          reader: expect.objectContaining({
            model: 'h-model',
            effort: 'low',
            tools: ['Read', 'Grep', 'Glob', 'Bash'],
          }),
        });
      });

      it('leaves the level out when the helper has none', () => {
        expect(
          JSON.parse(flag(launch('read', { model: 'h', prompt: 'read it' }), '--agents')).reader,
        ).not.toHaveProperty('effort');
      });

      it("gives the reader the helper's prompt, leaves the agent its search and sets no hook for it", () => {
        const args = launch('plan', { model: 'h', prompt: 'the reader skill' });
        const deniedTools = flag(args, '--disallowedTools').split(',');
        expect(deniedTools).not.toContain('Grep');
        expect(deniedTools).not.toContain('Read');
        expect(deniedTools).not.toContain('Agent');
        expect(JSON.parse(flag(args, '--agents')).reader).toMatchObject({
          prompt: 'the reader skill',
          tools: ['Read', 'Grep', 'Glob', 'Bash'],
        });
        expect(args).not.toContain('--settings');
        expect(runtime.homeFiles().map((file) => file.path)).toEqual([
          '.claude/settings.json',
          '.claude/deny-background.sh',
        ]);
      });

      it('keeps the subagent tool denied and passes no definition without a helper', () => {
        const args = launch('plan');
        expect(flag(args, '--disallowedTools').split(',')).toContain('Task');
        expect(args).not.toContain('--agents');
      });
    });

    it('denies the writing tools and the l00k list to a read step', () => {
      expect(denied('read')).toEqual([...L00K, ...READ_ONLY]);
      expect(claudeDisallowedTools('read').split(',')).toEqual(denied('read'));
    });

    it('denies a plan step what a read step is denied, except Skill', () => {
      expect(denied('plan')).toEqual([...L00K, ...READ_ONLY.filter((tool) => tool !== 'Skill')]);
      expect(claudeDisallowedTools('plan').split(',')).toEqual(denied('plan'));
    });

    it('denies a step with no tools reading and running commands as well', () => {
      const none = denied('none');
      expect(none).toEqual(expect.arrayContaining([...denied('read'), 'Read', 'Grep', 'Glob', 'Bash']));
      expect(claudeDisallowedTools('none').split(',')).toEqual(none);
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

    it('launches without an effort exactly as before', () => {
      const args = runtime.printArgs(base);
      expect(args).not.toContain('--effort');
      expect(runtime.homeFiles().length).toBeGreaterThan(0);
    });
  });
});
