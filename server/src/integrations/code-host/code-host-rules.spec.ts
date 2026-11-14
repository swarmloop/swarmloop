import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasCi } from '../../git/repo-names';
import { gitDetail } from '../../git/git';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { request } from '../http';
import { codeHostLabel, pushRejectionOfAnyHost } from './code-host-rules';
import { githubRules } from './github/github-rules';
import { gitlabRules } from './gitlab/gitlab-rules';

describe('code host rules', () => {
  describe('hasCi', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'has-ci-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('finds a GitLab pipeline file', () => {
      writeFileSync(join(dir, '.gitlab-ci.yml'), 'x');
      expect(hasCi(dir)).toBe(true);
    });

    it.each(['test.yml', 'test.yaml'])('finds a GitHub workflow %s', (file) => {
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(dir, '.github', 'workflows', file), 'x');
      expect(hasCi(dir)).toBe(true);
    });

    it('finds nothing in an empty workflows folder, a folder without CI or a missing folder', () => {
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(dir, '.github', 'workflows', 'notes.txt'), 'x');
      expect(hasCi(dir)).toBe(false);
      expect(hasCi(join(dir, 'missing'))).toBe(false);
    });
  });

  describe('push rejection', () => {
    const github = '! [remote rejected] main -> main (hook declined)';
    const gitlab = 'remote: GitLab: You are not allowed to push';
    const lines = (...rows: string[]): string => rows.join('\n');

    it('picks a GitHub rejection line', () => {
      expect(gitDetail(new Error(lines('fatal: could not push', github)))).toBe(github);
    });

    it('picks a GitLab line ahead of a fatal line', () => {
      expect(gitDetail(new Error(lines(gitlab, 'fatal: the remote end hung up')))).toBe(gitlab);
    });

    it('picks the earlier line when both hosts have one', () => {
      expect(pushRejectionOfAnyHost([gitlab, github])).toBe(gitlab);
      expect(pushRejectionOfAnyHost([github, gitlab])).toBe(github);
    });

    it('falls back to the fatal line when no host explains the push', () => {
      expect(gitDetail(new Error(lines('hint: try again', 'fatal: unable to access')))).toBe('fatal: unable to access');
      expect(pushRejectionOfAnyHost(['fatal: unable to access'])).toBeUndefined();
    });
  });

  describe('HTTP labels', () => {
    const original = global.fetch;

    afterEach(() => {
      global.fetch = original;
    });

    async function labelOf(url: string, classify?: (at: string) => string | null): Promise<string> {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          status: 200,
          ok: true,
          url,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      ) as unknown as typeof fetch;
      const calls: { provider: string }[] = [];
      await request(new FakeClock(), url, {}, calls as never, { classify });
      return calls[0].provider;
    }

    it.each([
      ['https://api.github.com/repos/a/b', 'github'],
      ['https://ghe.example/api/v3/repos/a/b', 'github'],
      ['https://gitlab.example/api/v4/projects/1', 'gitlab'],
    ])('labels %s as %s through its host', async (url, expected) => {
      const classify = (at: string): string | null => githubRules.classifyCall(at) ?? gitlabRules.classifyCall(at);
      expect(await labelOf(url, classify)).toBe(expected);
    });

    it('keeps jira and confluence labels and calls any other url other', async () => {
      expect(await labelOf('https://jira.example/rest/api/2/issue/A-1')).toBe('jira');
      expect(await labelOf('https://wiki.example/wiki/rest/api/content')).toBe('confluence');
      expect(await labelOf('https://example.test/api/v4/projects/1')).toBe('other');
    });
  });

  it('gives the label of a host by name and nothing for an unknown name', () => {
    expect(codeHostLabel('github')).toBe('GitHub');
    expect(codeHostLabel('gitlab')).toBe('GitLab');
    expect(codeHostLabel('other')).toBeNull();
  });
});
