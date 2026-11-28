import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { DocumentRepository } from '../../history/document.repository';
import type { RebaseHosts } from '../../git/rebase/types';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { NOT_DELIVERED, unchangedOutcome } from './commit-delivered';

const BRANCH = 'feature/PROJ-1-ship';

const RUN = { id: 1, key: 'PROJ-1' };

const SECTIONS: Record<string, object> = {
  code: { sections: { quality: 'checked', security: 'checked' } },
  behavior: { sections: { regressions: 'checked', performance: 'checked' } },
};

/** The result of a reviewer other than requirements, as a review round stores it. */
const result = (reviewer: string, decision: 'ok' | 'return'): string =>
  `${JSON.stringify({ decision, review: 'Checked.', summary: ['clear'], ...SECTIONS[reviewer] })}\n`;

/** The stored results by kind, in the order they were written; each has the id of its place in the list. */
function stored(results: [string, string][]): DocumentRepository {
  const latest = new Map(results.map(([kind, body], index) => [kind, { id: index + 1, kind, body }]));
  return {
    latestBody: async (_key: string, kind: string) => latest.get(kind)?.body ?? null,
    latestDocuments: async (_runs: number[], kinds: string[]) => kinds.flatMap((kind) => latest.get(kind) ?? []),
  } as unknown as DocumentRepository;
}

/** Reviews stored as results only, the way a passing review round leaves them. */
function reviews(
  requirements: object,
  others: [string, 'ok' | 'return'][] = [
    ['code', 'ok'],
    ['behavior', 'ok'],
  ],
): DocumentRepository {
  return stored([
    ['review_requirements_result', `${JSON.stringify({ decision: 'ok', review: 'Checked.', ...requirements })}\n`],
    ...others.map(([reviewer, decision]): [string, string] => [
      `review_${reviewer}_result`,
      result(reviewer, decision),
    ]),
  ]);
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
    const outcome = await unchangedOutcome(passing, RUN, [entry]);
    expect(outcome).toEqual({ issues: [expect.objectContaining({ title: text })] });
  });

  it('is delivered when the branch on origin holds no change of its own', async () => {
    const { clone, entry } = world();
    git(clone, ['push', 'origin', BRANCH]);
    expect(await unchangedOutcome(passing, RUN, [entry])).toEqual({ delivered: 'src/readme.ts' });
  });

  it('is delivered when the branch was never pushed', async () => {
    const { entry } = world();
    expect(await unchangedOutcome(passing, RUN, [entry])).toEqual({ delivered: 'src/readme.ts' });
  });

  it('is delivered when the tree has no origin', async () => {
    const { clone, entry } = world();
    git(clone, ['remote', 'remove', 'origin']);
    const base = git(clone, ['rev-parse', 'HEAD']);
    expect(await unchangedOutcome(passing, RUN, [{ ...entry, base }])).toEqual({ delivered: 'src/readme.ts' });
  });

  it('is not delivered when a reviewer did not find the work, before any git runs', async () => {
    const { entry } = world();
    const outcome = await unchangedOutcome(reviews({ summary: ['none'] }), RUN, [
      { ...entry, tree: { repo: 'demo', path: join(entry.tree.path, 'missing') } },
    ]);
    expect(outcome).toEqual({ issues: [expect.objectContaining({ title: NOT_DELIVERED })] });
  });

  it('is not delivered when the code or the behavior reviewer returned', async () => {
    const { entry } = world();
    for (const returned of ['code', 'behavior']) {
      const others: [string, 'ok' | 'return'][] = [
        ['code', returned === 'code' ? 'return' : 'ok'],
        ['behavior', returned === 'behavior' ? 'return' : 'ok'],
      ];
      const outcome = await unchangedOutcome(reviews({ summary: ['found'], met: ['src/readme.ts'] }, others), RUN, [
        entry,
      ]);
      expect(outcome).toEqual({ issues: [expect.objectContaining({ title: NOT_DELIVERED })] });
    }
  });

  it('is not delivered when a retired reviewer of a run reviewed before the three returned', async () => {
    const { entry } = world();
    const old = reviews({ summary: ['found'], met: ['src/readme.ts'] }, [
      ['quality', 'ok'],
      ['security', 'return'],
    ]);
    const outcome = await unchangedOutcome(old, RUN, [entry]);
    expect(outcome).toEqual({ issues: [expect.objectContaining({ title: NOT_DELIVERED })] });
  });

  it('does not let the return of a retired reviewer stop a run the three reviewers passed later', async () => {
    const { clone, entry } = world();
    git(clone, ['push', 'origin', BRANCH]);
    const mixed = stored([
      ['review_security_result', result('security', 'return')],
      [
        'review_requirements_result',
        `${JSON.stringify({ decision: 'ok', review: 'x', summary: [], met: ['src/readme.ts'] })}\n`,
      ],
      ['review_code_result', result('code', 'ok')],
      ['review_behavior_result', result('behavior', 'ok')],
    ]);
    expect(await unchangedOutcome(mixed, RUN, [entry])).toEqual({ delivered: 'src/readme.ts' });
  });
});
