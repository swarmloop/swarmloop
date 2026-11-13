import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { RunEntity } from '../../history/entities';
import type { StepContext } from '../base-step';
import { git } from '../../testing/runs.spec-helpers';
import { defaultBranchTests, testPaths, type DefaultBranchDeps } from './default-branch-tests';
import { originProject, type Failure } from './pipeline-report';

const KEY = 'PROJ-1';
const TEST_FILE = 'app/login/page.test.ts';

function put(dir: string, file: string): void {
  mkdirSync(join(dir, dirname(file)), { recursive: true });
  writeFileSync(join(dir, file), 'export {};\n');
  git(dir, ['add', file]);
  git(dir, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', `add ${file}`]);
}

interface World {
  deps: DefaultBranchDeps;
  clone: string;
  tree: string;
  failure(trace: string): Promise<Failure>;
  ctx(history?: string[]): StepContext;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-default-tests-'));
  const bare = join(root, 'origin.git');
  const clone = join(root, 'clone');
  const tree = join(root, 'worktrees', KEY, 'demo');
  git(root, ['init', '-b', 'main', '--bare', bare]);
  git(root, ['clone', bare, clone]);
  put(clone, 'src/readme.ts');
  git(clone, ['push', 'origin', 'HEAD:main']);
  mkdirSync(dirname(tree), { recursive: true });
  git(root, ['clone', bare, tree]);
  // The origin is a gitlab url, as the project name is read from it; a fetch names the url with the token, which reaches the bare repository.
  git(tree, ['remote', 'set-url', 'origin', 'https://gitlab.example/group/demo.git']);
  git(tree, ['config', `url.${bare}.insteadOf`, 'https://oauth2:token@gitlab.example/group/demo.git']);
  git(tree, ['switch', '-c', 'feature/task']);
  const rebase = jest.fn(() => Promise.resolve('resume' as const));
  const deps: DefaultBranchDeps = {
    runs: {} as DefaultBranchDeps['runs'],
    rebase: { rebase },
    halted: () => false,
    hosts: () =>
      Promise.resolve({
        clock: new FakeClock(),
        GITLAB_BASE_URL: 'https://gitlab.example',
        GITLAB_TOKEN: 'token',
      } as unknown as Awaited<ReturnType<DefaultBranchDeps['hosts']>>),
    root,
  };
  return {
    deps,
    clone,
    tree,
    failure: async (trace) => ({
      project: (await originProject(tree)) ?? '',
      pipelineId: 1,
      name: 'test',
      stage: 'test',
      url: '',
      trace,
    }),
    ctx: (history = []) => {
      const stored: Record<string, unknown> = { repos: ['demo'], pipeline_rebases: JSON.stringify(history) };
      return {
        opened: { run: { key: KEY, prompt: null } as RunEntity, startedAt: 'now' },
        reread: (artifact: { kind: string }) => Promise.resolve(stored[artifact.kind] ?? null),
      } as unknown as StepContext;
    },
  };
}

describe('a test file only the default branch has', () => {
  it('names test files by their shape, in any language', () => {
    expect(
      testPaths(`FAIL ${TEST_FILE}:12:3\n at tests/test_login.py. and pkg/login_test.go and src/readme.ts`),
    ).toEqual([TEST_FILE, 'tests/test_login.py', 'pkg/login_test.go']);
  });

  it('is fixed by a rebase, once per head of the default branch', async () => {
    const w = world();
    put(w.clone, TEST_FILE);
    git(w.clone, ['push', 'origin', 'HEAD:main']);
    const failure = await w.failure(`FAIL ${TEST_FILE}\n`);

    const first = await defaultBranchTests(w.deps, w.ctx(), [failure]);
    expect(first?.route).toEqual({ to: 'wait', reason: 'automatic rebase' });
    const log = first?.outputs.find((output) => output.artifact.kind === 'pipeline_log')?.value as string;
    expect(log).toContain('result: rebase');
    expect(log).toContain(TEST_FILE);
    const recorded = first?.outputs.find((output) => output.artifact.kind === 'pipeline_rebases')?.value as string;

    expect(await defaultBranchTests(w.deps, w.ctx(JSON.parse(recorded)), [failure])).toBeNull();

    put(w.clone, 'app/login/other.test.ts');
    git(w.clone, ['push', 'origin', 'HEAD:main']);
    const next = await w.failure(`FAIL ${TEST_FILE}\n`);
    expect(await defaultBranchTests(w.deps, w.ctx(JSON.parse(recorded)), [next])).not.toBeNull();
  });

  it('finds nothing when the file is on the branch too, or on neither', async () => {
    const w = world();
    put(w.clone, TEST_FILE);
    git(w.clone, ['push', 'origin', 'HEAD:main']);
    git(w.tree, ['fetch', `${w.clone}/../origin.git`, 'main']);
    git(w.tree, ['merge', 'FETCH_HEAD']);

    expect(await defaultBranchTests(w.deps, w.ctx(), [await w.failure(`FAIL ${TEST_FILE}\n`)])).toBeNull();
    expect(await defaultBranchTests(w.deps, w.ctx(), [await w.failure('FAIL app/none.test.ts\n')])).toBeNull();
    expect(await defaultBranchTests(w.deps, w.ctx(), [await w.failure('no test named\n')])).toBeNull();
  });
});
