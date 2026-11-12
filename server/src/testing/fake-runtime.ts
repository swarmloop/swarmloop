import type { PipelineService } from '../pipeline/pipeline.service';

/**
 * The parent run keeps its real launcher. Any other key (a subtask) is recorded and answers as started, so a spec
 * decides how far that run goes. The keys are pushed to `launched`, in order.
 */
export function holdDetachedStarts(pipeline: PipelineService, parentKey: string, launched: string[]): void {
  const original = pipeline.startDetached.bind(pipeline);
  jest.spyOn(pipeline, 'startDetached').mockImplementation((key, ...rest) => {
    if (key === parentKey) return original(key, ...rest);
    launched.push(key);
    return Promise.resolve({ exitCode: 0, message: `${key} started` });
  });
}

/** A sandbox a spec switches after the app is built: it answers like a gone container, or does not answer at all. */
export class FakeSandbox {
  private silentForMs = 0;

  get silent(): boolean {
    return this.silentForMs > 0;
  }

  /** Docker does not answer until `ms` of time have passed. */
  goSilent(ms: number): void {
    this.silentForMs = ms;
  }

  /** Time passes: a silent docker answers again once its time is over. */
  elapse(ms: number): void {
    this.silentForMs = Math.max(0, this.silentForMs - ms);
  }

  /** The calls for `createTestApp({ sandbox })`. Bound, so the same sandbox serves an app after a restart. */
  readonly calls = {
    stopRun: (): Promise<'gone'> => this.answer('gone'),
    attemptRunning: (): Promise<boolean> => this.answer(false),
  };

  private answer<T>(value: T): Promise<T> {
    return this.silent ? Promise.reject(new Error('docker did not answer')) : Promise.resolve(value);
  }
}
