import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DENY_BACKGROUND_REASON, DENY_BACKGROUND_SCRIPT } from './claude-hook';
import { ClaudeRuntime } from './claude.runtime';

function runHook(input: unknown): { stdout: string; status: number | null } {
  const path = join(mkdtempSync(join(tmpdir(), 'swarmloop-hook-')), 'hook.sh');
  writeFileSync(path, DENY_BACKGROUND_SCRIPT);
  const done = spawnSync('sh', [path], { input: JSON.stringify(input), encoding: 'utf8' });
  return { stdout: done.stdout, status: done.status };
}

describe('deny-background hook', () => {
  it('denies a Bash call that runs in the background', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test', run_in_background: true },
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_BACKGROUND_REASON,
      },
    });
    expect(DENY_BACKGROUND_REASON).toBe(
      'Run it in the foreground and wait for it. Your answer ends this process and kills anything still running.',
    );
  });

  it('allows a normal Bash call', () => {
    expect(runHook({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toEqual({ stdout: '', status: 0 });
    expect(runHook({ tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: false } })).toEqual({
      stdout: '',
      status: 0,
    });
  });

  it('is wired as a PreToolUse hook on Bash in the CLI home', () => {
    const files = new ClaudeRuntime().homeFiles();
    const settings = JSON.parse(files.find((file) => file.path === '.claude/settings.json')?.content ?? '{}');
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'sh /home/sandbox/.claude/deny-background.sh' }] },
    ]);
    expect(files.find((file) => file.path === '.claude/deny-background.sh')?.mode).toBe(0o755);
  });
});
