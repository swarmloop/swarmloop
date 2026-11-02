import { skillPrompt } from './shared/skill-prompt';
import { LINKED_CONTEXT, requirementsBrief, TASK_SCOPE } from './shared/requirements-brief';

describe('requirements brief', () => {
  const record = {
    prompt: `https://example.test/browse/PROJ-1\n\n${'i'.repeat(9000)}\nINSTRUCTION-TAIL`,
    tickets: [
      {
        key: 'PROJ-1',
        summary: 'Ship the field',
        description: 'Decode the company URL.',
        acceptanceCriteria: 'Must round-trip.',
        comments: [{ author: 'Ann', body: 'Watch the slash.' }],
      },
      { key: 'PROJ-8', summary: 'Also named in the prompt', description: 'Second task.', acceptanceCriteria: '', comments: [] },
    ],
    epic: { key: 'PROJ-0', summary: 'Rewrite the pages', description: 'Do the whole migration.', comments: [{ body: 'Epic note' }] },
    epics: [{ key: 'PROJ-0', summary: 'Rewrite the pages', description: 'Do the whole migration.', comments: [] }],
    files: [
      { name: 'note.txt', source: 'attachment', url: null, body: 'file-body', encoding: 'utf8' },
      { name: '', source: 'paste', url: 'https://figma.example/1', body: 'pasted-body', encoding: 'utf8' },
      {
        name: '',
        source: 'link',
        url: 'https://example.test/browse/PROJ-9',
        body: `PROJ-9\nLinked story\n\nLinked body\n\n${'y'.repeat(9000)}\nLINKED-TAIL\n\nAcceptance criteria:\nLinked must\n\nComments:\nAda: Linked note`,
        encoding: 'utf8',
      },
      {
        name: '',
        source: 'link',
        url: 'https://www.example.test/offices/',
        body: '<!DOCTYPE html><html><title>Offices</title>',
        encoding: 'utf8',
      },
    ],
    pages: [
      { source: 'confluence', id: '42', title: 'Design', url: 'https://example.test/wiki/pages/42', body: '<p>Keep this</p>', encoding: 'utf8' },
      {
        source: 'confluence',
        id: '99',
        title: 'Long spec',
        url: 'https://example.test/wiki/pages/99',
        body: 'x'.repeat(8 * 1024 + 1),
        encoding: 'utf8',
      },
    ],
    plan: null,
  };

  it('keeps one ticket as the work and the rest as context', () => {
    const brief = requirementsBrief(`${JSON.stringify(record)}\n`);
    expect(brief.startsWith('Work, and only this work: PROJ-1, PROJ-8.')).toBe(true);
    expect(brief).toContain(TASK_SCOPE);
    expect(brief).toContain(LINKED_CONTEXT);
    expect(brief).not.toContain('not a reason for decision: return');
    expect(brief).toContain('Instructions:');
    expect(brief).toContain('https://example.test/browse/PROJ-1');
    expect(brief).toContain('INSTRUCTION-TAIL');
    expect(brief).toContain('Decode the company URL.');
    expect(brief).toContain('Must round-trip.');
    expect(brief).toContain('Ann: Watch the slash.');
    expect(brief).toContain('Second task.');
    expect(brief).toContain('Attachment note.txt:\nfile-body');
    expect(brief).toContain('Pasted https://figma.example/1:\npasted-body');
    expect(brief).toContain('- Epic PROJ-0: Rewrite the pages');
    expect(brief).toContain('- PROJ-9: Linked story');
    expect(brief).toContain('Linked body');
    expect(brief).toContain('Linked must');
    expect(brief).toContain('Ada: Linked note');
    expect(brief).toContain('- https://www.example.test/offices/');
    expect(brief).toContain('<p>Keep this</p>');
    expect(brief).toContain('https://example.test/wiki/pages/99');
    expect(brief).toContain('x'.repeat(8 * 1024 + 1));
    expect(brief).toContain('LINKED-TAIL');
    expect(brief).not.toContain('Do the whole migration.');
    expect(brief).not.toContain('Epic note');
    expect(brief).not.toContain('<!DOCTYPE html>');
  });

  it('leaves a record without tickets unchanged', () => {
    const raw = '{"prompt":"hello"}\n';
    expect(requirementsBrief(raw)).toBe(raw);
  });

  it('puts the brief in the agent prompt', () => {
    const prompt = skillPrompt('research', JSON.stringify(record), ['api'], [], [{ hostPath: '/tmp/api', containerPath: '/work/api' }]);
    expect(prompt).toContain('Work, and only this work: PROJ-1, PROJ-8.');
    expect(prompt).toContain('Linked body');
    expect(prompt).toContain('Ada: Linked note');
    expect(prompt).toContain('Do not treat another ticket as work to do');
  });
});
