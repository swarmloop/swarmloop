import { ConflictException } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import { conflict, refusedAsBusy } from '../history/command.repository';
import type { PartStart } from '../steps/contract/artifacts-split';
import { PartDelivery } from './part-delivery';

const child = { key: 'epic-a', revision: 3 } as RunEntity;
const record: PartStart = { type: 'resume', key: 'subtask-needs-epic-a-1', by: 'machine', level: null };

function delivery() {
  const bodies: Record<string, string> = {};
  const documents = {
    latestBody: async (_key: string, kind: string) => bodies[kind] ?? null,
    putDocument: async (_run: unknown, kind: string, body: string) => void (bodies[kind] = body),
  };
  return { deliveries: new PartDelivery(documents as never), bodies };
}

const busy = () => conflict('RUN_BUSY', 'epic-a is already running', child, 'running');

describe('refusedAsBusy', () => {
  it('is true for the refusal of a held run only', () => {
    expect(refusedAsBusy(busy())).toBe(true);
    expect(refusedAsBusy(conflict('REVISION_CONFLICT', 'moved', child, 'running'))).toBe(false);
    expect(refusedAsBusy(new ConflictException('skipped'))).toBe(false);
    expect(refusedAsBusy(new Error('RUN_BUSY'))).toBe(false);
  });
});

describe('PartDelivery', () => {
  it('stores the start of a held part and answers held', async () => {
    const { deliveries } = delivery();

    const result = await deliveries.start(child, record, () => Promise.reject(busy()));

    expect(result).toBe('held');
    await expect(deliveries.held(child)).resolves.toEqual(record);
  });

  it('sends a stored start again with its key, and clears it once it went', async () => {
    const { deliveries } = delivery();
    await deliveries.start(child, record, () => Promise.reject(busy()));
    const keys: string[] = [];

    const stored = (await deliveries.held(child))!;
    const result = await deliveries.start(child, stored, async () => void keys.push(stored.key));

    expect(result).toBe('sent');
    expect(keys).toEqual([record.key]);
    await expect(deliveries.held(child)).resolves.toBeNull();
  });

  it('keeps the stored start while the part is still held', async () => {
    const { deliveries } = delivery();
    await deliveries.start(child, record, () => Promise.reject(busy()));

    const result = await deliveries.start(child, record, () => Promise.reject(busy()));

    expect(result).toBe('held');
    await expect(deliveries.held(child)).resolves.toEqual(record);
  });

  it('sends nothing stored for a part with no held start', async () => {
    const { deliveries, bodies } = delivery();

    await expect(deliveries.start(child, record, async () => undefined)).resolves.toBe('sent');

    expect(bodies).toEqual({});
    await expect(deliveries.held(child)).resolves.toBeNull();
  });

  it.each([
    ['another refusal', () => conflict('REVISION_CONFLICT', 'moved', child, 'running')],
    ['any other error', () => new Error('disk full')],
  ])('rethrows %s and stores nothing', async (_name, error) => {
    const { deliveries, bodies } = delivery();

    await expect(deliveries.start(child, record, () => Promise.reject(error()))).rejects.toThrow();

    expect(bodies).toEqual({});
  });
});
