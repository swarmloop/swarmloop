import { describe, expect, it } from 'vitest';
import { inputTitle } from './input-title';

describe('inputTitle', () => {
  it('words the input kinds of the steps', () => {
    expect(inputTitle('requirements')).toBe('Requirements');
    expect(inputTitle('plan')).toBe('Plan');
    expect(inputTitle('pipeline_ref')).toBe('Watched branch');
  });

  it('turns any other kind into words', () => {
    expect(inputTitle('foo_bar')).toBe('Foo bar');
  });
});
