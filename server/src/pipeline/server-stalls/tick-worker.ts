import { Worker } from 'worker_threads';

/** A count that a thread other than the main loop raises once a second. */
export interface TickSource {
  ticks(): number;
  close(): Promise<void>;
}

const TICK_SCRIPT = `
const { workerData } = require('worker_threads');
const counter = new Int32Array(workerData);
setInterval(() => Atomics.add(counter, 0, 1), 1000);
`;

/** Ticks from a worker thread, so a blocked main loop shows as a count that stands still while the thread lives. */
export class WorkerTicks implements TickSource {
  private readonly counter = new Int32Array(new SharedArrayBuffer(4));
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(TICK_SCRIPT, { eval: true, workerData: this.counter.buffer });
    this.worker.unref();
  }

  ticks(): number {
    return Atomics.load(this.counter, 0);
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
