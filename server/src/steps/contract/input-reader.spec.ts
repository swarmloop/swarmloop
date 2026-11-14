import type { DocumentRepository } from '../../history/document.repository';
import { ARTIFACTS } from './artifacts';
import { InputReader } from './input-reader';
import type { InputSpec } from './step-contract';

/** An in-memory store: the latest body of a kind wins, and each document gets the next id. */
function store(initial: Record<string, string> = {}) {
  const rows: { id: number; kind: string; body: string }[] = Object.entries(initial).map(([kind, body], index) => ({
    id: index + 1,
    kind,
    body,
  }));
  const latest = (kind: string) => [...rows].reverse().find((row) => row.kind === kind) ?? null;
  const documents = {
    latestBody: jest.fn(async (_key: string, kind: string) => latest(kind)?.body ?? null),
    latestDocument: jest.fn(async (_key: string, kind: string) => latest(kind)),
    hasDocument: jest.fn(async (_key: string, kind: string) => latest(kind) !== null),
  };
  return { rows, reader: new InputReader(documents as unknown as DocumentRepository), documents };
}

const SPEC = {
  repos: { artifact: ARTIFACTS.repos, need: 'start' },
  requirements: { artifact: ARTIFACTS.requirements, need: 'run' },
  commit: { artifact: ARTIFACTS.commit, need: 'optional' },
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional', late: true },
} as const satisfies InputSpec;

describe('input reader', () => {
  it('reads each input through its codec, in the order of the spec, and leaves a late input alone', async () => {
    const { reader, documents } = store({ repos: 'demo\n\n billing \n', requirements: '{}', ci_skip: 'skip\n' });
    const input = await reader.read('K', SPEC);
    expect(input).toEqual({ repos: ['demo', 'billing'], requirements: '{}', commit: null });
    expect(documents.latestBody.mock.calls.map((call) => call[1])).toEqual(['repos', 'requirements', 'commit']);
  });

  it('fails with "<kind> is missing" when a run input is absent', async () => {
    const { reader } = store({ repos: 'demo\n' });
    await expect(reader.read('K', SPEC)).rejects.toThrow('requirements is missing');
    await expect(reader.read('K', SPEC)).rejects.toMatchObject({ code: 'INPUT_MISSING' });
  });

  it('gives null for a start or optional input that is absent, and keeps a blank body', async () => {
    const { reader } = store({ requirements: '' });
    expect(await reader.read('K', SPEC)).toEqual({ repos: null, requirements: '', commit: null });
  });

  it('rereads one kind, null when nothing is stored', async () => {
    const { reader, rows } = store();
    expect(await reader.reread('K', ARTIFACTS.ciSkip)).toBeNull();
    rows.push({ id: 1, kind: 'ci_skip', body: 'skip\n' });
    expect(await reader.reread('K', ARTIFACTS.ciSkip)).toBe('skip\n');
  });

  it('names the first start kind with no document, and counts a stored empty body as present', async () => {
    const spec = {
      requirements: { artifact: ARTIFACTS.requirements, need: 'start' },
      repos: { artifact: ARTIFACTS.repos, need: 'start' },
      commit: { artifact: ARTIFACTS.commit, need: 'run' },
    } as const satisfies InputSpec;
    expect(await store().reader.missing('K', spec, 'start')).toBe('requirements');
    expect(await store({ requirements: '' }).reader.missing('K', spec, 'start')).toBe('repos');
    expect(await store({ requirements: '', repos: '' }).reader.missing('K', spec, 'start')).toBeNull();
    expect(await store().reader.missing('K', spec, 'run')).toBe('commit');
    expect(await store().reader.missing('K', spec, 'optional')).toBeNull();
  });

  it('tells whether a kind was stored after another', async () => {
    const { reader, rows } = store();
    expect(await reader.newer('K', ARTIFACTS.ciRerun, ARTIFACTS.commit)).toBe(false);
    rows.push({ id: 1, kind: 'ci_rerun', body: '1' });
    expect(await reader.newer('K', ARTIFACTS.ciRerun, ARTIFACTS.commit)).toBe(true);
    rows.push({ id: 2, kind: 'commit', body: 'a.ts\n' });
    expect(await reader.newer('K', ARTIFACTS.ciRerun, ARTIFACTS.commit)).toBe(false);
    rows.push({ id: 3, kind: 'ci_rerun', body: '2' });
    expect(await reader.newer('K', ARTIFACTS.ciRerun, ARTIFACTS.commit)).toBe(true);
  });

  it('reads a late research result through its codec', async () => {
    const value = { summary: ['why'], questions: [], impact: [] };
    const { reader } = store({ research_result: JSON.stringify(value) });
    expect(await reader.reread('K', ARTIFACTS.researchResult)).toEqual(value);
    expect(
      await reader.read('K', { result: { artifact: ARTIFACTS.researchResult, need: 'optional', late: true } }),
    ).toEqual({});
  });
});
