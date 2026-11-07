import { RebaseJournal } from './journal';

/** A journal that lives in memory, for specs that run the git work without a database. */
export function memoryJournal(generation = 0): RebaseJournal {
  let body: string | null = null;
  return new RebaseJournal(
    {
      read: () => Promise.resolve(body),
      write: (next) => {
        body = next;
        return Promise.resolve();
      },
    },
    generation,
  );
}
