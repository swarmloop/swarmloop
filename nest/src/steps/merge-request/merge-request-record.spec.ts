import { parseMergeRequests, remoteProject, renderMergeRequest } from './merge-request-record';

describe('merge request record', () => {
  it('reads a project path from an ssh or https origin', () => {
    expect(remoteProject('git@gitlab.example:group/demo.git')).toEqual({ host: 'gitlab.example', project: 'group/demo' });
    expect(remoteProject('https://gitlab.example/group/sub/demo.git')).toEqual({ host: 'gitlab.example', project: 'group/sub/demo' });
    expect(remoteProject('ssh://git@gitlab.example/group/demo.git')).toEqual({ host: 'gitlab.example', project: 'group/demo' });
    expect(remoteProject('https://gitlab.example/group/demo.git/')).toEqual({ host: 'gitlab.example', project: 'group/demo' });
  });

  it('rejects an origin that is not a project url', () => {
    expect(() => remoteProject('/tmp/demo.git')).toThrow(/origin is missing/);
    expect(() => remoteProject('https://gitlab.example/')).toThrow(/origin is missing/);
  });

  it('renders one block and summary per project', () => {
    const body = renderMergeRequest([
      { project: 'group/demo', iid: 12, url: 'https://gitlab.example/group/demo/-/merge_requests/12', summary: 'Demo field.\n' },
      { project: 'group/web', iid: 4, url: 'https://gitlab.example/group/web/-/merge_requests/4', summary: 'Web field.\n' },
    ]);
    expect(body).toContain('project: group/demo\niid: 12\nurl: https://gitlab.example/group/demo/-/merge_requests/12\n\nDemo field.');
    expect(body).toContain('project: group/web\niid: 4\nurl: https://gitlab.example/group/web/-/merge_requests/4\n\nWeb field.');
    expect(parseMergeRequests(body)).toEqual([
      { project: 'group/demo', iid: 12, url: 'https://gitlab.example/group/demo/-/merge_requests/12' },
      { project: 'group/web', iid: 4, url: 'https://gitlab.example/group/web/-/merge_requests/4' },
    ]);
  });
});
