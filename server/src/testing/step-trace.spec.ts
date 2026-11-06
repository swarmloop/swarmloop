import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DocumentRepository } from '../history/document.repository';
import { expectGolden, normalizeTrace, recordingDocuments } from './step-trace.spec-helpers';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('normalizeTrace', () => {
  it('replaces ISO timestamps', () => {
    expect(normalizeTrace({ at: 'on 2026-01-02T03:04:05.678Z ok' })).toEqual({ at: 'on <t> ok' });
  });

  it('replaces the temp root, also inside keys', () => {
    const path = join(tmpdir(), 'swarmloop-x1', 'worktrees', 'a');
    expect(normalizeTrace({ [path]: `at ${path}` })).toEqual({ '<root>/worktrees/a': 'at <root>/worktrees/a' });
  });

  it('replaces the /work sandbox mount', () => {
    expect(normalizeTrace('in /work/billing-api now')).toBe('in <work>/billing-api now');
  });

  it('numbers SHAs by first appearance and gives the same SHA the same number', () => {
    expect(normalizeTrace({ a: [SHA_B, SHA_A, SHA_B] })).toEqual({ a: ['<sha:1>', '<sha:2>', '<sha:1>'] });
  });

  it('replaces durations', () => {
    expect(normalizeTrace({ text: 'took 1234ms', durationMs: 7 })).toEqual({ text: 'took <ms>', durationMs: '<ms>' });
  });

  it('numbers UUIDs by first appearance', () => {
    const one = '123e4567-e89b-12d3-a456-426614174000';
    const two = '123e4567-e89b-12d3-a456-426614174001';
    expect(normalizeTrace([one, two, one])).toEqual(['<id:1>', '<id:2>', '<id:1>']);
  });
});

describe('recordingDocuments', () => {
  it('records kinds in call order, listings as *, and returns the real results', async () => {
    const real = {
      latestBody: jest.fn().mockResolvedValue('body'),
      latestDocument: jest.fn().mockResolvedValue({ id: 1, body: 'b' }),
      hasDocument: jest.fn().mockResolvedValue(true),
      listDocuments: jest.fn().mockResolvedValue([]),
      putDocument: jest.fn().mockResolvedValue(undefined),
    };
    const documents = recordingDocuments(real as unknown as DocumentRepository);
    await documents.putDocument({ id: 1 } as never, 'plan', 'x');
    expect(await documents.latestBody('k', 'requirements')).toBe('body');
    expect(await documents.latestDocument('k', 'repos')).toEqual({ id: 1, body: 'b' });
    expect(await documents.hasDocument('k', 'plan')).toBe(true);
    expect(await documents.listDocuments(1)).toEqual([]);
    expect(documents.kinds).toEqual(['plan', 'requirements', 'repos', 'plan', '*']);
  });
});

describe('expectGolden', () => {
  const saved = { ...process.env };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarmloop-golden-'));
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes sorted pretty JSON with UPDATE_GOLDEN=1 and then matches it', () => {
    delete process.env.CI;
    process.env.UPDATE_GOLDEN = '1';
    expectGolden('t', { b: 1, a: { d: 1, c: 2 } }, dir);
    expect(readFileSync(join(dir, 't.json'), 'utf8')).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
    delete process.env.UPDATE_GOLDEN;
    expectGolden('t', { a: { c: 2, d: 1 }, b: 1 }, dir);
  });

  it('refuses to write when CI is set', () => {
    process.env.CI = 'true';
    process.env.UPDATE_GOLDEN = '1';
    expect(() => expectGolden('t', { a: 1 }, dir)).toThrow(/missing/);
    writeFileSync(join(dir, 't.json'), '{}\n');
    expect(() => expectGolden('t', { a: 1 }, dir)).toThrow();
    expect(readFileSync(join(dir, 't.json'), 'utf8')).toBe('{}\n');
  });

  it('fails on a missing golden and names the file', () => {
    delete process.env.UPDATE_GOLDEN;
    expect(() => expectGolden('gone', {}, dir)).toThrow(join(dir, 'gone.json'));
  });
});
