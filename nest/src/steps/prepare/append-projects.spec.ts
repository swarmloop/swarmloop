import { appendProjectNames } from './append-projects';

describe('appendProjectNames', () => {
  it('adds a new name and keeps the previous ones', () => {
    expect(appendProjectNames(['billing-api'], ['billing-api', 'handbook'])).toEqual({
      projects: ['billing-api', 'handbook'],
      added: ['handbook'],
    });
  });

  it('ignores a name that is already selected', () => {
    expect(appendProjectNames(['billing-api'], ['billing-api'])).toEqual({
      projects: ['billing-api'],
      added: [],
    });
  });

  it('rejects a list that drops a selected name', () => {
    expect(() => appendProjectNames(['billing-api', 'worker'], ['worker'])).toThrow('billing-api cannot be removed');
  });
});
