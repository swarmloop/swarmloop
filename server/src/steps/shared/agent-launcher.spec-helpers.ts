import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

/** A child that stays up until a spec ends it, or until the runner kills it. */
export function controlled() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const exit = (code: number): void => {
    child.emit('close', code);
  };
  const kill = jest.fn(() => {
    setImmediate(() => exit(1));
    return true;
  });
  return Object.assign(child, { stdout, stderr: new PassThrough(), containerName: 'box', kill, exit });
}

export type Child = ReturnType<typeof controlled>;

export async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100_000 && !done(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}
