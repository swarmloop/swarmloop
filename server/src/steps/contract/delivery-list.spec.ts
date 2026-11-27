import type { DeliveryEntry } from '../../contract/delivery';
import {
  deliveryOf,
  deliverySummary,
  formatDelivery,
  parseDelivery,
  stillPublishing,
  toPublish,
  withPublished,
  withRead,
} from './delivery-list';

const LIST: DeliveryEntry[] = [
  { repo: 'demo', state: 'published', project: 'group/demo' },
  { repo: 'api', state: 'read' },
  { repo: 'web', state: 'publishing' },
];

describe('delivery list', () => {
  it('reads back what it wrote', () => {
    expect(parseDelivery(formatDelivery(LIST))).toEqual(LIST);
  });

  it('refuses an unknown state', () => {
    expect(() => parseDelivery('demo shipped\n')).toThrow('unknown state for demo: shipped');
  });

  it('reads every repository as published when the run has no list', () => {
    expect(deliveryOf(null, ['demo', 'api'])).toEqual([
      { repo: 'demo', state: 'published' },
      { repo: 'api', state: 'published' },
    ]);
    expect(deliveryOf(LIST, ['demo'])).toEqual(LIST);
  });

  it('names the repositories to publish and the ones still publishing', () => {
    expect(toPublish(LIST).map((entry) => entry.repo)).toEqual(['demo', 'web']);
    expect(stillPublishing(LIST).map((entry) => entry.repo)).toEqual(['web']);
  });

  it('marks a repository published with its project, or read', () => {
    const published = withPublished(LIST, [{ repo: 'web', project: 'group/web' }]);
    expect(published[2]).toEqual({ repo: 'web', state: 'published', project: 'group/web' });
    expect(withRead(published, ['web', 'demo']).map((entry) => entry.state)).toEqual(['read', 'read', 'read']);
    expect(withRead(published, ['web'])[2]).toEqual({ repo: 'web', state: 'read' });
  });

  it('sums up the states in words', () => {
    expect(deliverySummary(LIST)).toBe('1 publishing, 1 published, 1 read');
  });
});
