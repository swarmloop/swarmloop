import { decide, parseAllow } from './allow-list';

const login = { provider: 'github' as const, user: 'Ann', groups: ['Acme'] };
const noOwner = async () => null;

describe('parseAllow', () => {
  it('reads the four kinds, case-insensitively, and an empty list', () => {
    expect(parseAllow('')).toEqual([]);
    expect(parseAllow('GitHub:Ann, github-org:Acme,gitlab:bob,gitlab-group:Team/Dev')).toEqual([
      { provider: 'github', kind: 'user', name: 'ann' },
      { provider: 'github', kind: 'group', name: 'acme' },
      { provider: 'gitlab', kind: 'user', name: 'bob' },
      { provider: 'gitlab', kind: 'group', name: 'team/dev' },
    ]);
  });

  it('names a bad entry', () => {
    expect(() => parseAllow('github:ann,ann')).toThrow('"ann"');
    expect(() => parseAllow('github:')).toThrow('"github:"');
  });
});

describe('decide', () => {
  it('lets in a listed user and a member of a listed org', async () => {
    expect(await decide(parseAllow('github:ann'), login, noOwner)).toEqual({ allowed: true });
    expect(await decide(parseAllow('github-org:acme'), login, noOwner)).toEqual({ allowed: true });
  });

  it('refuses a user outside the list, and a name listed for the other provider', async () => {
    expect(await decide(parseAllow('github:bob'), login, noOwner)).toMatchObject({ allowed: false });
    expect(await decide(parseAllow('gitlab:ann'), login, noOwner)).toMatchObject({ allowed: false });
  });

  it('lets in only the token owner when the list is empty', async () => {
    expect(await decide([], login, async () => 'ann')).toEqual({ allowed: true });
    expect(await decide([], login, async () => 'bob')).toMatchObject({ allowed: false });
  });

  it('refuses everyone when the list is empty and no token is configured', async () => {
    const verdict = await decide([], login, noOwner);
    expect(verdict).toEqual({ allowed: false, reason: expect.stringContaining('no github token') });
  });

  it('with an empty list lets in a person who can push, and refuses one who cannot with the push message', async () => {
    expect(await decide([], login, noOwner, async () => true)).toEqual({ allowed: true });
    expect(await decide([], login, noOwner, async () => false)).toEqual({
      allowed: false,
      reason: expect.any(String),
      message: "github:Ann can't push to any repository this server works on",
    });
  });

  it('ignores the push check when the list is not empty', async () => {
    expect(await decide(parseAllow('github:bob'), login, noOwner, async () => true)).toMatchObject({ allowed: false });
    expect(await decide(parseAllow('github:ann'), login, noOwner, async () => false)).toEqual({ allowed: true });
  });
});
