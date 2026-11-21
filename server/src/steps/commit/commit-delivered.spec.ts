import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { DocumentRepository } from '../../history/document.repository';
import type { RebaseHosts } from '../../git/rebase/types';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { NOT_DELIVERED, unchangedOutcome } from './commit-delivered';

const BRANCH = 'feature/PROJ-1-ship';

/** Reviews stored as results only, the way a passing review round leaves them. */
function reviews(requirements: object): DocumentRepository {
  const bodies: Record<string, string> = {
    review_requirements_result: `${JSON.stringify({ decision: 'ok', review: 'Checked.', ...requirements })}\n`,
    review_quality_result: `${JSON.stringify({ decision: 'ok', review: 'Checked.', summary: ['clear'] })}\n`,
  };
  return { latestBody: async (_key: string, kind: string) => bodies[kind] ?? null } as unknown as DocumentRepository;
}

const passing = reviews({ summary: ['found'], met: ['src/readme.ts'] });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-delivered-'));
  const { clone } = copyMainWithOrigin(root, 'demo');
  git(clone, ['switch', '-c', BRANCH]);
  const base = git(clone, ['rev-parse', 'origin/main']);
  const hosts = {
    GITLAB_BASE_URL: '',
    GITLAB_TOKEN: '',
    GITHUB_BASE_URL: '',
    GITHUB_TOKEN: '',
    clock: new FakeClock(),
  } as RebaseHosts;
  const entry = { tree: { repo: 'demo', path: clone }, branch: BRANCH, base, hosts };
  return { clone, entry };
}

describe('unchangedOutcome', () => {
  it('is not delivered when the branch on origin has a change the base lacks', async () => {
    const { clone, entry } = world();
    writeFileSync(join(clone, 'src', 'own.ts'), 'export const own = 1;\n');
    git(clone, ['add', 'src/own.ts']);
    git(clone, ['commit', '-m', 'own']);
    git(clone, ['push', 'origin', BRANCH]);
    const sha = git(clone, ['rev-parse', 'HEAD']);
    git(clone, ['reset', '--hard', entry.base]);
    const text = `the branch ${BRANCH} on origin has ${sha} with changes this worktree does not have`;
    const outcome = await unchangedOutcome(passing, 'PROJ-1', [entry]);
    expect(outcome).toEqual({ issues: [expect.objectContaining({ title: text })] });
  });

  it('is delivered when the branch on origin holds no change of its own', async () => {
    const { clone, entry } = world();
    git(clone, ['push', 'origin', BRANCH]);
    expect(await unchangedOutcome(passing, 'PROJ-1', [entry])).toEqual({ delivered: 'src/readme.ts' });
  });

  it('is delivered when the branch was never pushed', async () => {
    const { entry } = world();
    expect(await unchangedOutcome(passing, 'PROJ-1', [entry])).toEqual({ delivered: 'src/readme.ts' });
  });

  it('is delivered when the tree has no origin', async () => {
    const { clone, entry } = world();
    git(clone, ['remote', 'remove', 'origin']);
    const base = git(clone, ['rev-parse', 'HEAD']);
    expect(await unchangedOutcome(passing, 'PROJ-1', [{ ...entry, base }])).toEqual({ delivered: 'src/readme.ts' });
  });

  it('is not delivered when a reviewer did not find the work, before any git runs', async () => {
    const { entry } = world();
    const outcome = await unchangedOutcome(reviews({ summary: ['none'] }), 'PROJ-1', [
      { ...entry, tree: { repo: 'demo', path: join(entry.tree.path, 'missing') } },
    ]);
    expect(outcome).toEqual({ issues: [expect.objectContaining({ title: NOT_DELIVERED })] });
  });
});
