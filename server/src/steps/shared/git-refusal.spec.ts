import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { GitRuleRefused } from '../../core/git-rule-refused';
import { GitRulesError } from '../../core/swarmloop-error';
import type { RunEntity } from '../../history/entities';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import { GitRefusal } from './git-refusal';
import { GitRulesWriter } from './git-rules-writer';
import type { ChatAnswer } from './implement-chat';
import { RebasedPublisher } from './rebased-publisher';
import { RunNames } from './run-names';

const KEY = 'PROJ-9';
const FEATURE = `feature/${KEY}-ship-the-field`;
const REQUIREMENTS = JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key: KEY, summary: 'Ship the field' }] });
const run = {
  id: 1,
  key: KEY,
  parentRunId: null,
  taskId: null,
  split: false,
  targetPath: null,
} as unknown as RunEntity;
const scope = { run, repo: 'demo', repos: ['demo'] };
const answer = { change: { type: 'feat' as const, subject: 'Ship it' } };

let root: string;
let tree: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-refusal-'));
  tree = featureWorktree(root, KEY).tree;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The service with an in-memory document store and a chat that gives the scripted answers. */
function setup(answers: ChatAnswer[]) {
  const stored: { id: number; kind: string; body: string }[] = [
    { id: 1, kind: 'requirements', body: REQUIREMENTS },
    { id: 2, kind: 'branch_names', body: `demo ${FEATURE}\n` },
  ];
  const latest = (kind: string) => [...stored].reverse().find((item) => item.kind === kind) ?? null;
  const kernel = {
    config: new AppConfig(testEnv({ SWARMLOOP_ROOT: root })),
    runs: { findById: async () => null },
    documents: {
      bodiesOfKind: async (_id: number, kind: string) =>
        stored.filter((item) => item.kind === kind).map((item) => item.body),
      latestBody: async (_key: string, kind: string) => latest(kind)?.body ?? null,
      latestDocument: async (_key: string, kind: string) => latest(kind),
      putDocument: async (_run: RunEntity, kind: string, body: string) => {
        stored.push({ id: stored.length + 1, kind, body });
      },
    },
  };
  const asked: string[] = [];
  const chat = {
    ask: async (_run: RunEntity, _repos: string[], prompt: string): Promise<ChatAnswer> => {
      asked.push(prompt);
      return answers.shift() ?? { error: 'no answer' };
    },
  };
  const names = new RunNames(kernel as never);
  const publisher = new RebasedPublisher(kernel as never, {} as never);
  const refusal = new GitRefusal(kernel as never, chat as never, names, new GitRulesWriter(), publisher, {
    of: async () => null,
  } as never);
  return { refusal, asked, stored, names };
}

const refused = (kind: 'branch' | 'commit' | 'title', name: string) => new GitRuleRefused('rule says no', name, kind);

describe('GitRefusal', () => {
  it('asks once with only the host message and the name, renames the branch and tries again', async () => {
    const { refusal, asked, stored, names } = setup([{ value: { ...answer, gitRules: { branch: 'work/{slug}' } } }]);
    const seen: string[] = [];
    const result = await refusal.guard(scope, 'branch', async () => {
      seen.push(git(tree, ['branch', '--show-current']));
      if (seen.length === 1) throw refused('branch', FEATURE);
      return 'pushed';
    });
    expect(result).toBe('pushed');
    expect(seen).toEqual([FEATURE, 'work/ship-the-field']);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('rule says no');
    expect(asked[0]).toContain(FEATURE);
    expect(await names.branch(run, 'demo')).toBe('work/ship-the-field');
    expect(
      stored.some((item) => item.kind === 'git_refusal' && item.body.startsWith('git-refusal:demo:branch\n')),
    ).toBe(true);
    expect(JSON.parse(readFileSync(join(tree, '.swarmloop.json'), 'utf8'))).toEqual({
      version: 1,
      git: { branch: 'work/{slug}' },
    });
  });

  it('amends the unpushed head commit with the message of the new rule, and the rule file', async () => {
    const { refusal } = setup([{ value: { ...answer, gitRules: { commit: '{type}: {subject}' } } }]);
    git(tree, ['commit', '--allow-empty', '-m', 'feat(PROJ-9): Ship the field']);
    let tries = 0;
    await refusal.guard(scope, 'commit', async () => {
      tries += 1;
      if (tries === 1) throw refused('commit', 'feat(PROJ-9): Ship the field');
      return true;
    });
    expect(git(tree, ['log', '-1', '--format=%s'])).toBe('feat: Ship it');
    expect(git(tree, ['show', '--name-only', '--format=', 'HEAD'])).toBe('.swarmloop.json');
  });

  it('tries a refused title again with the change of the answer', async () => {
    const { refusal, names } = setup([
      { value: { change: { type: 'fix', subject: 'Stop it' }, gitRules: { title: '{type}: {subject}' } } },
    ]);
    const titles: string[] = [];
    await refusal.guard(scope, 'title', async () => {
      titles.push(await names.title(run, 'demo'));
      if (titles.length === 1) throw refused('title', titles[0]);
    });
    expect(titles).toEqual(['Ship the field', 'fix: Stop it']);
  });

  it('blocks with the rule error when the same kind is refused again after the answer', async () => {
    const { refusal, asked } = setup([{ value: answer }]);
    const work = async () => {
      throw refused('title', 'Ship the field');
    };
    await expect(refusal.guard(scope, 'title', work)).rejects.toThrow(GitRulesError);
    await expect(refusal.guard(scope, 'title', work)).rejects.toThrow('rule says no refuses Ship the field');
    expect(asked).toHaveLength(1);
  });

  it('blocks with the rule error and does not retry when the answer cannot be used', async () => {
    const { refusal } = setup([{ error: 'the implement agent gave no git_refusal' }]);
    let tries = 0;
    await expect(
      refusal.guard(scope, 'branch', async () => {
        tries += 1;
        throw refused('branch', FEATURE);
      }),
    ).rejects.toMatchObject({ code: 'GIT_RULES', hostMessage: 'rule says no', refused: FEATURE });
    expect(tries).toBe(1);
  });

  it('renders the name again before the work when a rule was put into the repository after the block', async () => {
    const { refusal, asked } = setup([{ value: answer }]);
    await expect(
      refusal.guard(scope, 'branch', async () => {
        throw refused('branch', FEATURE);
      }),
    ).rejects.toThrow(GitRulesError);
    expect(existsSync(join(tree, '.swarmloop.json'))).toBe(false);
    writeFileSync(join(tree, '.swarmloop.json'), '{"version":1,"git":{"branch":"work/{slug}"}}\n');
    let seen = '';
    await refusal.guard(scope, 'branch', async () => {
      seen = git(tree, ['branch', '--show-current']);
    });
    expect(seen).toBe('work/ship-the-field');
    expect(asked).toHaveLength(1);
  });

  it('does not ask for a failure that is not a rule refusal', async () => {
    const { refusal, asked } = setup([]);
    await expect(
      refusal.guard(scope, 'commit', async () => {
        throw new Error('disk gone');
      }),
    ).rejects.toThrow('disk gone');
    expect(asked).toHaveLength(0);
  });
});
