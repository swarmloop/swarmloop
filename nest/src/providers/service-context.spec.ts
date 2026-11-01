import { ServiceContextService, pipelineRef, pipelineRefs } from './service-context';
import { IssueBundle } from '../integrations/issue-tracker/issue-bundle';

const bundle: IssueBundle = {
  key: 'PROJ-1',
  summary: 'Ship the field',
  descriptionMarkdown: 'Add the field to the form',
  acceptanceCriteria: 'The field is saved',
  epic: null,
  comments: [],
  attachments: [],
  links: [],
  confluence: [],
  pages: [],
};

describe('service context', () => {
  const tracker = { fetch: jest.fn() };
  const host = { findMergeRequest: jest.fn() };
  const hosts = { byName: jest.fn(() => host) };
  const history = {
    root: () => '/tmp/swarmloop',
    latestBody: jest.fn(),
    findRun: jest.fn(async () => ({ codeHost: 'gitlab' })),
  };
  const service = new ServiceContextService(history as never, tracker as never, hosts as never);

  afterEach(() => {
    tracker.fetch.mockReset();
    host.findMergeRequest.mockReset();
    hosts.byName.mockClear();
    history.latestBody.mockReset();
    history.findRun.mockReset();
    history.findRun.mockResolvedValue({ codeHost: 'gitlab' });
  });

  it('adds jira and gitlab notes without credentials', async () => {
    tracker.fetch.mockResolvedValue({ bundle, httpCalls: [] });
    history.latestBody.mockImplementation(async (_key: string, kind: string) => {
      if (kind === 'pipeline_ref') {
        return 'project: group/demo\nref: feature/PROJ-1\n';
      }
      return null;
    });
    host.findMergeRequest.mockResolvedValue({
      record: { project: 'group/demo', iid: 9, url: 'https://example.test/9', summary: 'Ships the field.' },
      httpCalls: [],
    });
    const block = await service.block('PROJ-1', 'ship the field');
    expect(tracker.fetch).toHaveBeenCalledWith('PROJ-1', '/tmp/swarmloop/worktrees/PROJ-1');
    expect(block).toContain('Jira PROJ-1: Ship the field');
    expect(block).toContain('GitLab group/demo !9 https://example.test/9');
    expect(block).not.toContain('Authorization');
    expect(block).not.toContain('token');
  });

  it('skips a ticket that is already in the requirements', async () => {
    history.latestBody.mockImplementation(async (_key: string, kind: string) => {
      if (kind === 'requirements') {
        return 'PROJ-1 is described here';
      }
      if (kind === 'merge_request') {
        return 'project: group/demo\niid: 9\nurl: https://example.test/9\n\nShips the field.\n';
      }
      return null;
    });
    const block = await service.block('PROJ-1', 'ship');
    expect(tracker.fetch).not.toHaveBeenCalled();
    expect(host.findMergeRequest).not.toHaveBeenCalled();
    expect(block).toContain('project: group/demo');
    expect(block).not.toContain('Ships the field');
  });

  it('skips the merge request lookup before a code host is known', async () => {
    history.findRun.mockResolvedValue({ codeHost: '' });
    history.latestBody.mockImplementation(async (_key: string, kind: string) => {
      if (kind === 'pipeline_ref') {
        return 'project: group/demo\nref: feature/PROJ-1\n';
      }
      return null;
    });
    expect(await service.block('PROJ-1', 'ship')).toBe('');
    expect(host.findMergeRequest).not.toHaveBeenCalled();
  });

  it('leaves the prompt alone when the host cannot read the services', async () => {
    tracker.fetch.mockRejectedValue(new Error('JIRA_API_TOKEN is missing'));
    history.latestBody.mockImplementation(async (_key: string, kind: string) => {
      if (kind === 'pipeline_ref') {
        return 'project: group/demo\nref: feature/PROJ-1\n';
      }
      return null;
    });
    host.findMergeRequest.mockRejectedValue(new Error('GITLAB_TOKEN is missing'));
    expect(await service.block('PROJ-1', 'ship')).toBe('');
  });

  it('reads a pipeline ref without crossing a later project', () => {
    expect(pipelineRef('project: group/demo\nref: feature/PROJ-1\nsha: abc\n')).toEqual({
      project: 'group/demo',
      ref: 'feature/PROJ-1',
    });
    expect(pipelineRef('sha: abc\n')).toBeNull();
    expect(pipelineRefs('project: group/a\nref: feature/a\nsha: 1\nproject: group/b\nref: feature/b\n')).toEqual([
      { project: 'group/a', ref: 'feature/a' },
      { project: 'group/b', ref: 'feature/b' },
    ]);
  });
});
