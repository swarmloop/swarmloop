import { CodexRuntime } from './codex.runtime';

describe('CodexRuntime', () => {
  const runtime = new CodexRuntime();
  const mounts = [{ containerPath: '/work/demo' }];

  it('says whether its plan mode has a plan tool', () => {
    expect(runtime.planModeHasPlanTool).toBe(false);
  });

  it('loads AGENTS.md by itself', () => {
    expect(runtime.ownRuleFiles()).toEqual(['AGENTS.md']);
  });

  it('prefers the subscription file and rejects an empty pair', () => {
    expect(
      runtime.credential({ cursorKey: '', anthropicKey: '', oauthToken: '', codexAuth: 'auth', codexApiKey: 'key' }),
    ).toEqual({
      name: 'CODEX_AUTH',
      value: 'auth',
    });
    expect(
      runtime.credential({ cursorKey: '', anthropicKey: '', oauthToken: '', codexAuth: '', codexApiKey: 'key' }),
    ).toEqual({
      name: 'CODEX_API_KEY',
      value: 'key',
    });
    expect(() =>
      runtime.credential({ cursorKey: '', anthropicKey: '', oauthToken: '', codexAuth: '', codexApiKey: '' }),
    ).toThrow('CODEX_AUTH or CODEX_API_KEY is missing');
  });

  it('prints a fresh run, a resumed run, plan mode, and a brief mount', () => {
    expect(
      runtime.printArgs({
        model: 'gpt-6.1-sol',
        prompt: 'read the worktrees',
        mounts,
        resumeChatId: null,
        mode: 'agent',
        tools: 'write',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      'gpt-6.1-sol',
      '--dangerously-bypass-approvals-and-sandbox',
      'read the worktrees',
    ]);
    expect(
      runtime.printArgs({
        model: 'gpt-6.1-sol',
        prompt: 'write the server',
        mounts,
        resumeChatId: 'thread-1',
        mode: 'agent',
        tools: 'write',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      'gpt-6.1-sol',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      'thread-1',
      'write the server',
    ]);
    expect(
      runtime.printArgs({
        model: 'gpt-6.1-sol',
        prompt: 'read the worktrees',
        mounts,
        resumeChatId: 'thread-1',
        mode: 'plan',
        tools: 'write',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      'gpt-6.1-sol',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      'thread-1',
      'read the worktrees',
    ]);
    expect(
      runtime.printArgs({
        model: 'gpt-6.1-sol',
        prompt: 'read the worktrees',
        mounts,
        resumeChatId: null,
        mode: 'plan',
        tools: 'write',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      'gpt-6.1-sol',
      '--dangerously-bypass-approvals-and-sandbox',
      'read the worktrees',
    ]);
    const withBrief = runtime.printArgs({
      model: 'gpt-6.1-sol',
      prompt: 'read the worktrees',
      mounts: [...mounts, { containerPath: '/work/brief' }],
      resumeChatId: null,
      mode: 'agent',
      tools: 'write',
    });
    withBrief.unshift(...runtime.briefArgs());
    expect(withBrief.slice(0, 2)).toEqual(['--add-dir', '/work/brief']);
    expect(withBrief.at(-1)).toBe('read the worktrees');
  });
});
