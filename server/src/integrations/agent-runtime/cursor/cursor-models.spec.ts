import { readFileSync } from 'fs';
import { join } from 'path';
import { effortsOf, idWithEffort, parseModelIds } from './cursor-models';

const ids = parseModelIds(readFileSync(join(__dirname, 'cursor-models.recorded.txt'), 'utf8'));

describe('cursor models', () => {
  it('reads the ids of the recorded list and skips its other lines', () => {
    expect(ids).toHaveLength(11);
    expect(ids).toContain('opus-5.5-extra-high');
  });

  it('puts the level behind the model id', () => {
    expect(idWithEffort(ids, 'grok-4.7', 'high')).toBe('grok-4.7-high');
    expect(effortsOf(ids, 'grok-4.7')).toEqual(['low', 'high', 'xhigh']);
  });

  it('takes the xhigh id first and the extra-high id second', () => {
    expect(idWithEffort(ids, 'grok-4.7', 'xhigh')).toBe('grok-4.7-xhigh');
    expect(idWithEffort(ids, 'opus-5.5', 'xhigh')).toBe('opus-5.5-extra-high');
  });

  it('gives no levels to an id that already ends in one', () => {
    expect(effortsOf(ids, 'grok-4.7-high')).toEqual([]);
    expect(idWithEffort(ids, 'grok-4.7-high', 'low')).toBeNull();
  });

  it('gives no levels to an unknown model or a model without level ids', () => {
    expect(effortsOf(ids, 'no-such-model')).toEqual([]);
    expect(effortsOf(ids, 'sonnet-5.5')).toEqual([]);
    expect(idWithEffort(ids, 'no-such-model', 'high')).toBeNull();
  });
});
