import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildAgentArgs, reviewBriefMount, spillPrompt, terminalArgs } from './agent-runner';

describe('buildAgentArgs', () => {
  const mounts = [{ hostPath: '/tmp/worktrees/PROJ-1/demo', containerPath: '/work/demo' }];

  it('asks the cursor agent in ask mode', () => {
    const args = buildAgentArgs('agent', {
      model: 'grok-4.7',
      prompt: 'read the worktrees',
      mounts,
      resumeChatId: null,
      mode: 'ask',
    });
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('ask');
    expect(args).not.toContain('--force');
    expect(args.at(-1)).toBe('read the worktrees');
  });

  it('leaves the editing agent on the cli default', () => {
    const args = buildAgentArgs('agent', {
      model: 'grok-4.7',
      prompt: 'write the server',
      mounts,
      resumeChatId: null,
      mode: 'agent',
    });
    expect(args).not.toContain('--mode');
    expect(args).toContain('--force');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('disabled');
    expect(args).toContain('--model');
  });

  it('resumes the editing agent without a mode flag', () => {
    const args = buildAgentArgs('agent', {
      model: 'grok-4.7',
      prompt: 'write the server',
      mounts,
      resumeChatId: 'chat-1',
      mode: 'agent',
    });
    expect(args).not.toContain('--mode');
    expect(args).toContain('--resume');
    expect(args).toContain('--force');
  });

  it('approves mcp servers when the ide attached them', () => {
    const args = buildAgentArgs('agent', {
      model: 'from-env',
      prompt: 'read the worktrees',
      mounts,
      resumeChatId: null,
      mode: 'agent',
      approveMcps: true,
    });
    expect(args).toContain('--approve-mcps');
    expect(args.at(-1)).toBe('read the worktrees');
  });

  it('approves mcp servers when the ide attached them', () => {
    const args = buildAgentArgs('agent', {
      model: 'from-env',
      prompt: 'read the worktrees',
      mounts,
      resumeChatId: null,
      mode: 'agent',
      approveMcps: true,
    });
    expect(args).toContain('--approve-mcps');
    expect(args.at(-1)).toBe('read the worktrees');
  });

  it('does not pass cursor mode to claude', () => {
    const args = buildAgentArgs('claude', {
      model: 'grok-4.7',
      prompt: 'read the worktrees',
      mounts,
      resumeChatId: null,
      mode: 'ask',
    });
    expect(args).not.toContain('--mode');
    expect(args).not.toContain('--trust');
    expect(args).not.toContain('--workspace');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--verbose');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args.at(-1)).toBe('read the worktrees');
  });
});

describe('review brief mount', () => {
  it('mounts briefs for every turn of a shared chat', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-brief-'));
    const mount = { hostPath: join(root, 'briefs'), containerPath: '/work/brief', readonly: true };
    expect(reviewBriefMount(root, 'commit')).toBeNull();
    expect(reviewBriefMount(root, 'chat')).toBeNull();
    expect(reviewBriefMount(root, 'implement')).toEqual(mount);
    expect(reviewBriefMount(root, 'plan-improve')).toEqual(mount);
    expect(reviewBriefMount(root, 'code-review-quality')).toEqual(mount);
    expect(reviewBriefMount(root, 'code-review-report')).toEqual(mount);
  });
});

describe('spillPrompt', () => {
  it('leaves a short prompt as the command argument', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-brief-'));
    const delivered = spillPrompt('read the worktrees', root, 'code-review-quality');
    expect(delivered.text).toBe('read the worktrees');
    expect(delivered.mounts).toEqual([]);
  });

  it('writes a long prompt where the sandbox can read it', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-brief-'));
    const prompt = `${'a'.repeat(100_000)}\nrest of the brief`;
    const delivered = spillPrompt(prompt, root, 'code-review/quality');
    expect(delivered.text).toContain('Read /work/brief/code-review-quality.md');
    expect(Buffer.byteLength(delivered.text)).toBeLessThan(100_000);
    expect(delivered.mounts).toEqual([{ hostPath: join(root, 'briefs'), containerPath: '/work/brief', readonly: true }]);
    expect(readFileSync(join(root, 'briefs', 'code-review-quality.md'), 'utf8')).toBe(prompt);
  });
});

describe('terminalArgs', () => {
  it('opens the vendor screen and forwards other words unchanged', () => {
    expect(terminalArgs({ model: 'from-env', workspace: '/work', resumeChatId: 'chat-1', vendor: [] })).toEqual([
      '--model',
      'from-env',
      '--trust',
      '--workspace',
      '/work',
      '--resume',
      'chat-1',
    ]);
    expect(terminalArgs({ model: 'from-env', workspace: '/work', resumeChatId: null, vendor: ['mcp', 'list'] })).toEqual([
      'mcp',
      'list',
    ]);
  });
});
