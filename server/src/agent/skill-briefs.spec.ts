import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { AgentLaunchPrep } from './agent-launch-prep';
import { copySkillBriefs, SKILLS_DIR } from './skill-briefs';

function put(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('copySkillBriefs', () => {
  it('copies every file but SKILL.md with fixed modes and overwrites earlier copies', () => {
    const skills = mkdtempSync(join(tmpdir(), 'skills-'));
    const briefs = mkdtempSync(join(tmpdir(), 'briefs-'));
    put(skills, 'a/SKILL.md', 'skill a');
    put(skills, 'a/extra.md', 'extra');
    put(skills, 'b/c/SKILL.md', 'skill c');
    put(skills, 'b/c/note.md', 'note');
    copySkillBriefs(skills, briefs);
    const out = join(briefs, 'skills');
    expect(readFileSync(join(out, 'a/extra.md'), 'utf8')).toBe('extra');
    expect(readFileSync(join(out, 'b/c/note.md'), 'utf8')).toBe('note');
    expect(existsSync(join(out, 'a/SKILL.md'))).toBe(false);
    expect(existsSync(join(out, 'b/c/SKILL.md'))).toBe(false);
    expect(mode(join(out, 'a/extra.md'))).toBe(0o644);
    expect(mode(join(out, 'b/c/note.md'))).toBe(0o644);
    for (const dir of ['', 'a', 'b', 'b/c']) {
      expect(mode(join(out, dir))).toBe(0o755);
    }
    put(skills, 'a/extra.md', 'changed');
    copySkillBriefs(skills, briefs);
    expect(readFileSync(join(out, 'a/extra.md'), 'utf8')).toBe('changed');
  });

  it.each([
    'state',
    'state/briefs',
    'state/briefs/skills',
    'state/briefs/skills/a',
    'state/briefs/skills/a/b',
    'state/briefs/skills/a/b/extra.md',
  ])('refuses a destination symlink at %s without changing its target', (path) => {
    const root = mkdtempSync(join(tmpdir(), 'skill-links-'));
    const skills = join(root, 'source');
    const briefs = join(root, 'state/briefs');
    put(skills, 'a/b/extra.md', 'skill content');
    const link = join(root, path);
    const target = join(root, 'service');
    const outside = join(target, relative(link, join(briefs, 'skills/a/b/extra.md')));
    put(root, relative(root, outside), 'service content');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);

    expect(() => copySkillBriefs(skills, briefs)).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('service content');
  });

  it('copies when a folder above the state folder is a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-above-'));
    const skills = join(root, 'source');
    put(skills, 'a/extra.md', 'extra');
    mkdirSync(join(root, 'real/state'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'data'));

    copySkillBriefs(skills, join(root, 'data/state/briefs'));

    expect(readFileSync(join(root, 'real/state/briefs/skills/a/extra.md'), 'utf8')).toBe('extra');
  });
});

describe('AgentLaunchPrep skill briefs', () => {
  function launch(step: string, linkedRoot = false): string {
    const real = mkdtempSync(join(tmpdir(), 'swarmloop-root-'));
    const root = linkedRoot ? join(mkdtempSync(join(tmpdir(), 'swarmloop-link-')), 'root') : real;
    if (linkedRoot) {
      symlinkSync(real, root);
    }
    const config = new AppConfig(
      testEnv({
        SWARMLOOP_ROOT: root,
        CURSOR_API_KEY: 'test-key',
        AGENTS_PLAN: 'cursor:m',
        AGENTS_IMPLEMENT: 'cursor:m',
        AGENTS_REVIEW: 'cursor:m',
      }),
    );
    new AgentLaunchPrep(config).prepare(
      {
        prompt: 'short prompt',
        workspace: join(root, 'ws'),
        outputFile: join(root, 'out.txt'),
        sessionFile: join(root, 'session.json'),
        runtime: 'cursor',
        model: 'm',
        agentCalls: 0,
        spentUsd: 0,
        resumeChatId: null,
        runKey: 'run1',
        step,
        attemptId: 'attempt1',
        mounts: [{ hostPath: join(root, 'ws'), containerPath: '/work/repo', readonly: false }],
        tools: 'read',
      },
      runtimeFor('cursor'),
      false,
    );
    return join(agentStateDir(root, 'run1', step), 'briefs');
  }

  it('leaves the project base text in the brief folder of a step with a brief mount', () => {
    const briefs = launch('plan');
    expect(readFileSync(join(briefs, 'skills/implement/project-base.md'), 'utf8')).toBe(
      readFileSync(join(SKILLS_DIR, 'implement/project-base.md'), 'utf8'),
    );
  });

  it('leaves the project base text in the brief folder when the repository root is a symlink', () => {
    const briefs = launch('plan', true);
    expect(readFileSync(join(briefs, 'skills/implement/project-base.md'), 'utf8')).toBe(
      readFileSync(join(SKILLS_DIR, 'implement/project-base.md'), 'utf8'),
    );
  });

  it('leaves no brief folder for a step without a brief mount', () => {
    expect(existsSync(launch('requirements'))).toBe(false);
    expect(readFileSync(join(launch('plan'), 'skills/implement/project-base.md'), 'utf8')).toBe(
      readFileSync(join(SKILLS_DIR, 'implement/project-base.md'), 'utf8'),
    );
  });
});
