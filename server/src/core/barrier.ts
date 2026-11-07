/** The points of a run where a test may stop the process, in the order they happen. */
export type BarrierName =
  'after-accept' | 'after-container-create' | 'after-push' | 'before-finalize' | 'after-finalize';

type BarrierHook = (name: BarrierName) => Promise<void> | void;

let hook: BarrierHook | null = null;

/** Installs the hook a test uses to hold or stop the process at a barrier. Null removes it. */
export function setBarrierHook(next: BarrierHook | null): void {
  hook = next;
}

/** Waits for the hook of a test. Without one it does nothing, so the run is not changed. */
export async function barrier(name: BarrierName): Promise<void> {
  await hook?.(name);
}
