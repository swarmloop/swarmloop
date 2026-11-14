import { renderCause, renderImplementation } from './implement-record';
import { legacyImplementation } from '../../agent-result/legacy/implementation';

describe('renderImplementation', () => {
  it('writes one line per item and indents the later lines of an item', () => {
    expect(renderImplementation(['changed A', 'changed B: with a colon\n  nested\n\ncode'])).toBe(
      '- changed A\n- changed B: with a colon\n    nested\n  \n  code\n',
    );
  });

  it('writes nothing for no items', () => {
    expect(renderImplementation([])).toBe('');
  });

  it('is read back whole by the legacy reader', () => {
    const items = ['changed A', 'changed B: with a colon\n  nested\n\ncode'];
    expect(legacyImplementation(renderImplementation(items)).implementation).toEqual(items);
  });
});

describe('renderCause', () => {
  it('writes the cause lines as a section', () => {
    expect(renderCause(['the parser dropped the suffix'])).toBe('cause:\n- the parser dropped the suffix\n\n');
  });
});
