import { hasTitleText } from '../contract/requirements-view';
import { TITLE_MARK_CHARACTERS } from './title-marks';

describe('TITLE_MARK_CHARACTERS', () => {
  it('holds exactly the characters that make a line have no title text', () => {
    const marks = new Set(TITLE_MARK_CHARACTERS);
    const wrong: string[] = [];
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const char = String.fromCharCode(unit);
      if (!hasTitleText(char) !== marks.has(char)) {
        wrong.push(unit.toString(16));
      }
    }

    expect(wrong).toEqual([]);
  });
});
