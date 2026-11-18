import { SystemClock } from './clock';

const RING_SIZE = 32;

interface Mark {
  what: string;
  at: number;
}

const clock = new SystemClock();
const ring: Mark[] = [];

/** Notes that the main loop entered `what` now. Only the last 32 marks are kept. */
export function markEntered(what: string): void {
  ring.push({ what, at: clock.now() });
  if (ring.length > RING_SIZE) {
    ring.shift();
  }
}

/** The last thing entered at or before `at` (ms), or null when the ring holds none. */
export function enteredBefore(at: number): string | null {
  for (let index = ring.length - 1; index >= 0; index -= 1) {
    if (ring[index].at <= at) {
      return ring[index].what;
    }
  }
  return null;
}

/** A timer that does not hold the process and marks `what` each time before it calls `fn`. */
export function markedInterval(what: string, fn: () => void, ms: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    markEntered(what);
    fn();
  }, ms);
  timer.unref();
  return timer;
}
