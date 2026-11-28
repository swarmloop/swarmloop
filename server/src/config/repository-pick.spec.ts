import { fallbackFolder, repositoryPick } from './repository-pick';

describe('repositoryPick', () => {
  it('splits owner and name at the last slash', () => {
    expect(repositoryPick('alice/app')).toEqual({ owner: 'alice', name: 'app' });
    expect(repositoryPick('acme/team/apps/app')).toEqual({ owner: 'acme/team/apps', name: 'app' });
  });

  it.each(['app', '/app', 'acme/', 'acme/run-x', 'acme/.x', 'acme/../x', '.hidden/app', 'acme//app'])(
    'is not a pick: %s',
    (value) => {
      expect(repositoryPick(value)).toBeNull();
    },
  );
});

describe('fallbackFolder', () => {
  it('joins the name and the owner path with dashes', () => {
    expect(fallbackFolder('acme/team/apps', 'app')).toBe('app-acme-team-apps');
    expect(fallbackFolder('alice', 'app')).toBe('app-alice');
  });
});
