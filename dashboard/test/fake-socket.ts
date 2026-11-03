import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/** Records what the client sends. Tests assert on this recorder, not on the method, to avoid unbound-method. */
export const emitted = vi.fn();

/** The socket.io-client members the dashboard uses. `emit` records what the client sends. */
export const fakeSocket = Object.assign(new EventEmitter(), { connected: false, emit: emitted });

/** Delivers a server event to the listeners the code registered with `on`. */
export function receive(event: string, ...args: unknown[]): void {
  EventEmitter.prototype.emit.call(fakeSocket, event, ...args);
}

export function fakeLive(): { liveSocket: () => typeof fakeSocket } {
  return { liveSocket: () => fakeSocket };
}

export function resetFakeSocket(): void {
  fakeSocket.removeAllListeners();
  fakeSocket.connected = false;
  emitted.mockClear();
}
