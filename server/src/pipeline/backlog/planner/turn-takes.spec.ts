import { plannerDatabase } from './planner.spec-helpers';
import { TurnTakes } from './turn-takes';

type Db = Awaited<ReturnType<typeof plannerDatabase>>;

async function withTakes(body: (db: Db, takes: TurnTakes, id: number) => Promise<void>): Promise<void> {
  const db = await plannerDatabase();
  try {
    await body(db, new TurnTakes(db.chat), await db.addBacklog());
  } finally {
    await db.close();
  }
}

describe('TurnTakes', () => {
  it('takes nothing and says so when no window is open', () =>
    withTakes(async (db, takes, id) => {
      await db.addMessage(id, 'waits');
      expect(takes.take(id)).toBe(false);
      await takes.idle();
      expect((await db.chat.waitingItems(id)).messages).toHaveLength(1);
    }));

  it('takes what waits into the turn of the open window, one take after another, and tells after each', () =>
    withTakes(async (db, takes, id) => {
      const told: string[] = [];
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      takes.open(id, 'turn-1', async () => {
        told.push(`taken ${(await db.chat.itemsOfTurn('turn-1')).messages.length}`);
        if (told.length === 1) await gate;
        told.push('told');
      });
      await db.addMessage(id, 'first');
      expect(takes.take(id)).toBe(true);
      expect(takes.take(id)).toBe(true);
      release();
      await takes.idle();

      expect(told).toEqual(['taken 1', 'told', 'taken 1', 'told']);
      expect((await db.chat.waitingItems(id)).messages).toEqual([]);
    }));

  it('waits for the takes it chained when it closes, and takes nothing after', () =>
    withTakes(async (db, takes, id) => {
      takes.open(id, 'turn-1', async () => undefined);
      await db.addMessage(id, 'first');
      takes.take(id);
      await takes.close('turn-1');
      expect((await db.chat.itemsOfTurn('turn-1')).messages).toHaveLength(1);

      await db.addMessage(id, 'late');
      expect(takes.take(id)).toBe(false);
      expect((await db.chat.waitingItems(id)).messages.map((message) => message.text)).toEqual(['late']);
    }));

  it('closes only the window of its turn and does nothing for a turn without one', () =>
    withTakes(async (db, takes, id) => {
      takes.open(id, 'turn-1', async () => undefined);
      await takes.close('turn-2');
      await db.addMessage(id, 'first');
      expect(takes.take(id)).toBe(true);
      await takes.idle();
      expect((await db.chat.itemsOfTurn('turn-1')).messages).toHaveLength(1);
    }));

  it('does not reject when a take fails, and goes on with the next one', () =>
    withTakes(async (db, takes, id) => {
      let calls = 0;
      takes.open(id, 'turn-1', async () => {
        calls += 1;
        if (calls === 1) throw new Error('could not tell');
      });
      await db.addMessage(id, 'first');
      takes.take(id);
      takes.take(id);
      await expect(takes.close('turn-1')).resolves.toBeUndefined();
      expect(calls).toBe(2);
    }));
});
