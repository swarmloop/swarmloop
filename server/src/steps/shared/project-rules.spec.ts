import { chmodSync, mkdirSync, symlinkSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SandboxMount } from '../../core/sandbox-mount';
import { projectRules } from './project-rules';

let dir = '';

function mount(name: string, rules?: string): SandboxMount {
  const hostPath = join(dir, name);
  mkdirSync(hostPath, { recursive: true });
  if (rules !== undefined) {
    writeFileSync(join(hostPath, 'AGENTS.md'), rules);
  }
  return { hostPath, containerPath: `/work/${name}` };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarmloop-rules-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('projectRules', () => {
  it('leaves out the working directory when the runtime loads AGENTS.md itself', () => {
    const mounts = [mount('api', 'api rules'), mount('web', 'web rules')];
    expect(projectRules(['api', 'web'], mounts, 'codex', false)).toEqual([
      { heading: 'Project rules (web)', body: 'web rules' },
    ]);
  });

  it('gives every repository, the working directory first, when the runtime does not', () => {
    const mounts = [mount('api', 'api rules'), mount('web', 'web rules')];
    expect(projectRules(['api', 'web'], mounts, 'claude', false)).toEqual([
      { heading: 'Project rules (api)', body: 'api rules' },
      { heading: 'Project rules (web)', body: 'web rules' },
    ]);
  });

  it('cuts a file above 32 KiB and says where the full file is', () => {
    const [rule] = projectRules(['api'], [mount('api', 'x'.repeat(40 * 1024))], 'claude', false);
    expect(rule?.body).toBe(
      `${'x'.repeat(32 * 1024)}\nThis file was cut at 32 KiB. The full file is /work/api/AGENTS.md.`,
    );
  });

  it('adds nothing for a missing, empty or unreadable file', () => {
    const unreadable = mount('c', 'secret');
    chmodSync(join(unreadable.hostPath, 'AGENTS.md'), 0o000);
    const mounts = [mount('a'), mount('b', '  \n'), unreadable];
    const readable = process.getuid?.() === 0 ? 1 : 0;
    expect(projectRules(['a', 'b', 'c'], mounts, 'claude', false)).toHaveLength(readable);
  });

  it('adds nothing for an AGENTS.md that is a symlink to a file outside the mount', () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'host secret');
    const linked = mount('a');
    symlinkSync(outside, join(linked.hostPath, 'AGENTS.md'));
    expect(projectRules(['a'], [linked], 'claude', false)).toEqual([]);
  });

  it('gives none to a chat that already received them', () => {
    expect(projectRules(['api'], [mount('api', 'rules')], 'claude', true)).toEqual([]);
  });
});
