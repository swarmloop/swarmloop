import { resultArtifactCodec } from './result-codec';
import { storedResult } from './stored-result';
import { sample } from './result.spec-helpers';

const valid = { title: 't', items: [], decision: 'ok' };

describe('storedResult', () => {
  it('returns the latest value of the kind', () => {
    const documents = [
      { kind: 'sample_result', body: JSON.stringify({ ...valid, title: 'old' }) },
      { kind: 'plan', body: 'x' },
      { kind: 'sample_result', body: JSON.stringify(valid) },
    ];
    expect(storedResult(sample, documents)).toEqual(valid);
  });

  it('returns null when the kind was never stored', () => {
    expect(storedResult(sample, [{ kind: 'plan', body: 'x' }])).toBeNull();
  });
});

describe('resultArtifactCodec', () => {
  const codec = resultArtifactCodec(sample);

  it('round-trips a valid value', () => {
    expect(codec.parse(codec.format(valid))).toEqual(valid);
  });

  it('refuses a body the schema does not accept', () => {
    expect(() => codec.parse('{"title":"t"}')).toThrow('sample_result is not valid');
  });
});
