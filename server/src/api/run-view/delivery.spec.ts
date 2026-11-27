import { deliveryEntriesOf, deliveryViews } from './delivery';

describe('run delivery', () => {
  it('shows each repository with its state and nothing of the host', () => {
    expect(deliveryViews('demo published group/demo\nweb read\napi publishing\n')).toEqual([
      { repo: 'demo', state: 'published' },
      { repo: 'web', state: 'read' },
      { repo: 'api', state: 'publishing' },
    ]);
  });

  it('shows nothing for a run with no list or an unreadable one', () => {
    expect(deliveryViews(null)).toEqual([]);
    expect(deliveryViews('demo shipped\n')).toEqual([]);
  });

  it('reads every repository of a run made before the list as published, for its merge request labels', () => {
    expect(deliveryEntriesOf(null, 'demo\nweb\n')).toEqual([
      { repo: 'demo', state: 'published' },
      { repo: 'web', state: 'published' },
    ]);
    expect(deliveryEntriesOf('demo shipped\n', null)).toEqual([]);
  });
});
