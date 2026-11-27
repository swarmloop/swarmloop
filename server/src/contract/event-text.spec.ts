import { resultLine } from './event-text';

describe('resultLine', () => {
  it('gives the first line of a result without its time stamp', () => {
    expect(resultLine('2026-01-01T10:00:00.000Z the code host refuses to read pipelines (HTTP 403)\nmore')).toBe(
      'the code host refuses to read pipelines (HTTP 403)',
    );
  });

  it('keeps a plain line as it is', () => {
    expect(resultLine('  checks failed  \nsecond')).toBe('checks failed');
    expect(resultLine('')).toBe('');
  });
});
