import type { RunEntity } from '../../history/entities';
import { requirementBodies, viewTitle } from './run-title';

const run = (over: Partial<RunEntity> = {}) =>
  ({ key: 'PROJ-1', prompt: '', title: null, ...over }) as Pick<RunEntity, 'key' | 'prompt' | 'title'>;

describe('view title of a run', () => {
  it('uses the title research stored', () => {
    expect(viewTitle(run({ title: 'Show a title', prompt: '# Other' }), '{"prompt":"x"}')).toBe('Show a title');
  });

  it('falls back to the heading of the prompt, without its marks', () => {
    expect(viewTitle(run({ prompt: '# 03 — Applier and command\nmore' }), null)).toBe('03 — Applier and command');
  });

  it('cuts a long one-line prompt at a word boundary within 70 characters', () => {
    const title = viewTitle(
      run({ prompt: 'Read api/docs/plans/scoring-revision/README.md step 2 and change the applier so that it works' }),
      null,
    );
    expect(title).toBe('Read api/docs/plans/scoring-revision/README.md step 2 and change the…');
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('prefers the ticket of the requirements to the prompt', () => {
    const body = JSON.stringify({ prompt: 'x', tickets: [{ key: 'PROJ-9', summary: 'Fix the list' }] });
    expect(viewTitle(run({ prompt: 'x' }), body)).toBe('PROJ-9 Fix the list');
  });

  it('reads a requirements body that is not JSON as none', () => {
    expect(viewTitle(run({ prompt: 'Add a field' }), 'not json')).toBe('Add a field');
  });

  it('is the key when there is nothing else', () => {
    expect(viewTitle(run({ prompt: '' }), null)).toBe('PROJ-1');
  });
});

describe('requirement bodies', () => {
  it('maps the latest requirements body to its run id with one read', async () => {
    const latestDocuments = jest.fn().mockResolvedValue([{ runId: 4, body: 'a' }]);
    const bodies = await requirementBodies({ latestDocuments }, [4, 5]);
    expect(bodies.get(4)).toBe('a');
    expect(bodies.has(5)).toBe(false);
  });
});
