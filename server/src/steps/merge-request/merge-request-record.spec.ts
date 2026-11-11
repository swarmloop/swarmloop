import { mergeRequestDetails, parseMergeRequests, remoteProject, renderMergeRequest } from './merge-request-record';

describe('merge request record', () => {
  it('reads a project path from an ssh or https origin', () => {
    expect(remoteProject('git@gitlab.example:group/demo.git')).toEqual({
      host: 'gitlab.example',
      project: 'group/demo',
    });
    expect(remoteProject('https://gitlab.example/group/sub/demo.git')).toEqual({
      host: 'gitlab.example',
      project: 'group/sub/demo',
    });
    expect(remoteProject('ssh://git@gitlab.example/group/demo.git')).toEqual({
      host: 'gitlab.example',
      project: 'group/demo',
    });
    expect(remoteProject('https://gitlab.example/group/demo.git/')).toEqual({
      host: 'gitlab.example',
      project: 'group/demo',
    });
  });

  it('rejects an origin that is not a project url', () => {
    expect(() => remoteProject('/tmp/demo.git')).toThrow(/origin is missing/);
    expect(() => remoteProject('https://gitlab.example/')).toThrow(/origin is missing/);
  });

  it('renders one block and summary per project', () => {
    const body = renderMergeRequest([
      {
        project: 'group/demo',
        iid: 12,
        url: 'https://gitlab.example/group/demo/-/merge_requests/12',
        draft: true,
        summary: 'Demo field.\n',
      },
      {
        project: 'group/web',
        iid: 4,
        url: 'https://gitlab.example/group/web/-/merge_requests/4',
        draft: false,
        summary: 'Web field.\n',
      },
    ]);
    expect(body).toContain(
      'project: group/demo\niid: 12\nurl: https://gitlab.example/group/demo/-/merge_requests/12\ndraft: true\n\nDemo field.',
    );
    expect(body).toContain(
      'project: group/web\niid: 4\nurl: https://gitlab.example/group/web/-/merge_requests/4\ndraft: false\n\nWeb field.',
    );
    expect(parseMergeRequests(body)).toEqual([
      { project: 'group/demo', iid: 12, url: 'https://gitlab.example/group/demo/-/merge_requests/12', draft: true },
      { project: 'group/web', iid: 4, url: 'https://gitlab.example/group/web/-/merge_requests/4', draft: false },
    ]);
  });

  it('shows each link with its draft or ready state, and reads a record without the line as ready', () => {
    const records = parseMergeRequests('project: a/b\niid: 1\nurl: https://x/1\n\nProse.\n');
    expect(records).toEqual([{ project: 'a/b', iid: 1, url: 'https://x/1', draft: false }]);
    expect(mergeRequestDetails([...records, { ...records[0], url: 'https://x/2', draft: true }])).toEqual([
      'https://x/1 (ready)',
      'https://x/2 (draft)',
    ]);
  });
});
