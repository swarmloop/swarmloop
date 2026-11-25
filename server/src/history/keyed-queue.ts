/** Runs work for one key one at a time, in call order. A key keeps no record once its last work is done. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** How many keys have work that is not done. */
  pending(): number {
    return this.tails.size;
  }

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
