import { renderTemplate } from './name-template';

describe('renderTemplate', () => {
  const conventional = '{type}[({scope})]: {subject}';

  it('keeps the bracketed scope when it has a value', () => {
    expect(renderTemplate(conventional, { type: 'fix', scope: 'api', subject: 'Stop it' })).toBe('fix(api): Stop it');
  });

  it('drops the bracketed scope when it is empty or missing', () => {
    expect(renderTemplate(conventional, { type: 'feat', scope: '', subject: 'Add it' })).toBe('feat: Add it');
    expect(renderTemplate(conventional, { type: 'feat', subject: 'Add it' })).toBe('feat: Add it');
  });

  it('keeps the ticket and its space, or drops both', () => {
    expect(renderTemplate('[{ticket} ]{subject}', { ticket: 'PROJ-1', subject: 'Do it' })).toBe('PROJ-1 Do it');
    expect(renderTemplate('[{ticket} ]{subject}', { subject: 'Do it' })).toBe('Do it');
  });

  it('renders a placeholder outside brackets empty when it has no value', () => {
    expect(renderTemplate('{key}-{slug}', { key: 'K-1' })).toBe('K-1-');
  });
});
