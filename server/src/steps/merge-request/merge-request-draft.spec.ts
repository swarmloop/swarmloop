import { setMergeRequestsDraft } from './merge-request-draft';
import { renderMergeRequest } from './merge-request-record';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';

const person = { codeHost: 'gitlab', startedBy: 'alice' };

function setup() {
  const setDraft = jest.fn().mockResolvedValue({ httpCalls: [] });
  const registry = {
    hostFor: async (run: { codeHost: string; startedBy: string | null }) => {
      if (run.startedBy !== 'alice') throw new Error('GITLAB_TOKEN is missing');
      return { setDraft };
    },
  } as unknown as CodeHostRegistry;
  return { setDraft, registry };
}

const body = renderMergeRequest([
  { project: 'group/a', iid: 1, url: 'https://code.example/a/1', draft: true, summary: '' },
  { project: 'group/b', iid: 2, url: 'https://code.example/b/2', draft: false, summary: '' },
]);

describe('setMergeRequestsDraft', () => {
  it('puts every record into the asked draft state through the host of the run person', async () => {
    const { setDraft, registry } = setup();
    await setMergeRequestsDraft(registry, person, body, false);
    expect(setDraft).toHaveBeenCalledWith('group/a', 1, false);
  });

  it('refuses a run whose person has no host', async () => {
    const { registry } = setup();
    await expect(setMergeRequestsDraft(registry, { ...person, startedBy: null }, body, false)).rejects.toThrow(
      'GITLAB_TOKEN is missing',
    );
  });

  it('leaves alone a record already in that state', async () => {
    const { setDraft, registry } = setup();
    await setMergeRequestsDraft(registry, person, body, false);
    expect(setDraft).not.toHaveBeenCalledWith('group/b', 2, false);
  });

  it('rewrites the draft lines of the body', async () => {
    const { registry } = setup();
    const result = await setMergeRequestsDraft(registry, person, body, true);
    expect(result.body.match(/^draft: true$/gm)).toHaveLength(2);
    expect(result.body).not.toContain('draft: false');
  });
});
