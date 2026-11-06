import { promptSections } from './prompt-manifest';

describe('promptSections', () => {
  it('lists the text before the first heading and each heading with its size', () => {
    const prompt = 'Intro line\n\nRequirements:\nship it\n\nWhat previous steps did:\n- planned';
    expect(promptSections(prompt)).toEqual([
      { heading: 'prompt', size: 'Intro line\n'.length + 1 },
      { heading: 'Requirements', size: 'Requirements:\nship it\n'.length + 1 },
      { heading: 'What previous steps did', size: 'What previous steps did:\n- planned'.length + 1 },
    ]);
  });
});
