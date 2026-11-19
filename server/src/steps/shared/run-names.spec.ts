import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import type { RunEntity } from '../../history/entities';
import { git } from '../../testing/git-fixture';
import { ARTIFACTS } from '../contract/artifacts';
import { RunNames } from './run-names';

const KEY = 'PROJ-7';
const REQUIREMENTS = JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key: KEY, summary: 'Ship the field' }] });
const TODAY = 'feature/PROJ-7-ship-the-field';
const run = { id: 1, key: KEY, parentRunId: null, taskId: null, split: false } as unknown as RunEntity;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-names-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tree(repo: string, files: Record<string, string> = {}, branch = 'main'): void {
  const path = join(dir, 'worktrees', KEY, repo);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-b', branch]);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(path, name), body);
  }
}

function names(stored: Record<string, string> = {}) {
  const bodies: Record<string, string> = { requirements: REQUIREMENTS, ...stored };
  const kernel = {
    config: new AppConfig(testEnv({ SWARMLOOP_ROOT: dir })),
    documents: {
      latestBody: async (_key: string, kind: string) => bodies[kind] ?? null,
      latestDocument: async (_key: string, kind: string) =>
        kind in bodies ? { id: Object.keys(bodies).indexOf(kind), body: bodies[kind] } : null,
      putDocument: async (_run: RunEntity, kind: string, body: string) => {
        bodies[kind] = body;
      },
    },
    runs: { findById: async () => null },
  };
  return { service: new RunNames(kernel as never), bodies };
}

const manifest = (git: object): Record<string, string> => ({ '.swarmloop.json': JSON.stringify({ version: 1, git }) });
const change = { type: 'fix', scope: 'api', subject: 'Stop the loop' };
const CONVENTIONAL = { '.commitlintrc.json': '{}' };

describe('RunNames.branch', () => {
  it('reads the stored line of a repository', async () => {
    const { service } = names({ branch_names: 'api feature/stored-name\nweb other\n' });
    expect(await service.branch(run, 'api')).toBe('feature/stored-name');
    expect(await service.branch(run, 'web')).toBe('other');
  });

  it('computes the name of a run that stored none', async () => {
    expect(await names().service.branch(run, 'api')).toBe(TODAY);
  });
});

describe('RunNames.store', () => {
  it('stores a name rendered from the format of the repository', async () => {
    tree('api', manifest({ branch: 'work/{ticket}-{slug}' }));
    const { service, bodies } = names();
    await service.store(run, ['api']);
    expect(bodies[ARTIFACTS.branchNames.kind]).toBe('api work/PROJ-7-ship-the-field\n');
  });

  it("stores today's name for a worktree already on it, even with a branch template", async () => {
    tree('api', manifest({ branch: 'work/{slug}' }), TODAY);
    const { service, bodies } = names();
    await service.store(run, ['api']);
    expect(bodies[ARTIFACTS.branchNames.kind]).toBe(`api ${TODAY}\n`);
  });

  it('keeps a line that exists and gives a repository added later the same name', async () => {
    tree('api', manifest({ branch: 'work/{slug}' }));
    tree('web');
    const { service } = names({ branch_names: 'api old-name\n' });
    const lines = await service.store(run, ['api', 'web']);
    expect([...lines]).toEqual([
      ['api', 'old-name'],
      ['web', 'old-name'],
    ]);
  });

  it('stores one name for every repository of a run, from the first repository, so mixed formats still share a branch', async () => {
    tree('api', manifest({ branch: 'work/{slug}' }));
    tree('web');
    const lines = await names().service.store(run, ['api', 'web']);
    expect([...lines.values()]).toEqual(['work/ship-the-field', 'work/ship-the-field']);
  });
});

describe('RunNames.commitMessage', () => {
  it("is today's message when nothing is configured", async () => {
    tree('api');
    expect(await names().service.commitMessage(run, 'api')).toBe('feat(PROJ-7): Ship the field');
  });

  it("uses the change of the plan, and implement's change over it", async () => {
    tree('api', CONVENTIONAL);
    const plan = { summary: ['x'], plan: ['one'], change: { type: 'feat', subject: 'Plan subject' } };
    const implemented = { implementation: ['x'], summary: ['y'], change };
    expect(await names({ plan_result: JSON.stringify(plan) }).service.commitMessage(run, 'api')).toBe(
      'feat: Plan subject',
    );
    const both = names({ plan_result: JSON.stringify(plan), implementation_result: JSON.stringify(implemented) });
    expect(await both.service.commitMessage(run, 'api')).toBe('fix(api): Stop the loop');
  });

  it('makes a follow-up commit a fix unless implement named a type', async () => {
    tree('api', CONVENTIONAL);
    const plan = { summary: ['x'], plan: ['one'], change: { type: 'feat', subject: 'Plan subject' } };
    const planned = names({ plan_result: JSON.stringify(plan), pipeline_ref: 'ref\n' }).service;
    expect(await planned.commitMessage(run, 'api')).toBe('fix: Plan subject');
    const implemented = { implementation: ['x'], summary: ['y'], change: { type: 'feat', subject: 'Own' } };
    const named = names({ implementation_result: JSON.stringify(implemented), pipeline_ref: 'ref\n' }).service;
    expect(await named.commitMessage(run, 'api')).toBe('feat: Own');
  });
});

describe('RunNames.title', () => {
  it('is the summary without a format, and the template of the manifest with one', async () => {
    tree('api');
    tree('web', manifest({ title: '[{ticket} ]{subject}' }));
    expect(await names().service.title(run, 'api')).toBe('Ship the field');
    expect(await names().service.title(run, 'web')).toBe('PROJ-7 Ship the field');
  });
});
