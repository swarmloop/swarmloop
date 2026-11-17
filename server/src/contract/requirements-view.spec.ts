import { runTitle } from './requirements-view';

describe('runTitle', () => {
  it('drops the marks of a heading and of markdown', () => {
    expect(runTitle('# 03 — Applier and command')).toBe('03 — Applier and command');
    expect(runTitle('**Fix** the [list](http://x.y) `now`')).toBe('Fix the list now');
  });

  it('keeps a short first line and ignores the lines after it', () => {
    expect(runTitle('\n\nAdd a title\nmore text')).toBe('Add a title');
  });

  it('cuts a long line at a word boundary within 70 characters', () => {
    const title = runTitle(
      'Read the plan and then change the applier so that every command goes through one gate first',
    );
    expect(title).toBe('Read the plan and then change the applier so that every command goes…');
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('keeps a title whose cut falls just after a word', () => {
    const text = `${'a'.repeat(34)} ${'b'.repeat(34)} tail`;
    expect(runTitle(text)).toBe(`${'a'.repeat(34)} ${'b'.repeat(34)}…`);
  });

  it('cuts one very long word hard', () => {
    expect(runTitle('x'.repeat(100))).toBe(`${'x'.repeat(69)}…`);
  });

  it('adds one ellipsis when the line is over 160 characters', () => {
    const title = runTitle('word '.repeat(80));
    expect(title.endsWith('word…')).toBe(true);
    expect(title.endsWith('……')).toBe(false);
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('is empty for an empty text', () => {
    expect(runTitle('')).toBe('');
  });
});
