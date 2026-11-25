import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DENY_BACKGROUND_REASON,
  DENY_BACKGROUND_SCRIPT,
  READ_BY_HELPER_REASON,
  READ_BY_HELPER_SCRIPT,
} from './claude-hook';
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

describe('read-by-helper hook', () => {
  const run = (input: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'swarmloop-hook-')), 'hook.sh');
    writeFileSync(path, READ_BY_HELPER_SCRIPT);
    return spawnSync('sh', [path, '/work/web', '/work/api'], { input: JSON.stringify(input), encoding: 'utf8' });
  };
  const denies = (input: unknown): boolean => {
    const { stdout, status } = run(input);
    expect(status).toBe(0);
    return stdout !== '' && JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason === READ_BY_HELPER_REASON;
  };

  it('denies the agent Bash and a Read or Glob of a code mount', () => {
    expect(denies({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toBe(true);
    expect(denies({ tool_name: 'Read', tool_input: { file_path: '/work/api/src/a.ts' } })).toBe(true);
    expect(denies({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts', path: '/work/web' } })).toBe(true);
    expect(denies({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } })).toBe(true);
    expect(denies({ tool_name: 'Glob', tool_input: { pattern: '*.ts', path: 'src' } })).toBe(true);
    expect(denies({ tool_name: 'Glob', tool_input: { pattern: 'web/**', path: '/work' } })).toBe(true);
    expect(denies({ tool_name: 'Glob', tool_input: { pattern: 'work/**', path: '/' } })).toBe(true);
    expect(denies({ tool_name: 'Read', tool_input: { file_path: '/work/./web/a.ts' } })).toBe(true);
    expect(denies({ tool_name: 'Read', tool_input: { file_path: '/work//web/a.ts' } })).toBe(true);
    expect(denies({ tool_name: 'Read', tool_input: { file_path: '/work/brief/../web/a.ts' } })).toBe(true);
  });

  it('lets the agent read its own folder and search, and lets a subagent read the code', () => {
    expect(denies({ tool_name: 'Read', tool_input: { file_path: '/work/brief/brief.md' } })).toBe(false);
    expect(denies({ tool_name: 'Read', tool_input: { file_path: '/work/webish/a.ts' } })).toBe(false);
    expect(denies({ tool_name: 'Glob', tool_input: { pattern: '*', path: '/work/logs' } })).toBe(false);
    expect(denies({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '/work/web' } })).toBe(false);
    expect(denies({ agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } })).toBe(false);
    expect(denies({ agent_id: 'a1', tool_name: 'Read', tool_input: { file_path: '/work/web/a.ts' } })).toBe(false);
  });
});
